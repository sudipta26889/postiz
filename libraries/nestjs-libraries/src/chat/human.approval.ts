import crypto from 'crypto';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

// Human approval (DharaHIL) for risky actions. Transport-neutral: `decide`
// returns a decision, and each caller (the MCP tool wrapper, the public API
// controller) turns it into its own answer. Fail closed: any error, missing
// config or unknown answer is a refusal.

const DAY = 24 * 60 * 60;
const approvedTtl = 7 * DAY;
const claimTtl = 30 * DAY;

// Owner's rule: nothing is posted without a human. Any item that will go out,
// now or at a scheduled time, needs approval; only drafts (which never
// publish on their own) don't. Shared by the MCP schedule tool and the
// public API post routes.
export const publishReason = (
  items: { type?: string }[] | undefined
): string | null => {
  const list = Array.isArray(items) ? items : [];
  // an empty or missing list can't be checked: fail closed
  const publishes =
    list.length === 0 || list.some((p) => p?.type !== 'draft');
  return publishes ? 'Publishing or scheduling a post' : null;
};

export interface ApprovalConfig {
  baseUrl: string;
  tenantId: string;
  appId: string;
  apiKey: string;
}

export interface ApprovalDeps {
  fetch: typeof fetch;
  redis: typeof ioRedis;
  // false when REDIS_URL is unset: the mock client ignores NX, so the
  // at-most-once claim cannot be guaranteed
  hasRedis: () => boolean;
  config: () => ApprovalConfig;
}

export type ApprovalDecision<T> =
  // the action ran (or policy allowed it): its result
  | { status: 'executed'; result: T }
  // a human has not decided yet: ask the caller to repeat the same call later
  | { status: 'pending'; requestId: string; expiresAt?: string; message: string }
  // approved earlier: already done, or started and the outcome is unknown
  | { status: 'done' | 'running'; requestId: string; message: string }
  // rejected, expired, denied, not configured, or any error
  // rejected, expired, denied (unavailable: the service itself failed, not a
  // human: not configured, no Redis, gateway unreachable or erroring)
  | {
      status: 'refused';
      message: string;
      unavailable?: boolean;
      // a duplicate of something that exists (REST answers 409)
      duplicate?: boolean;
    };

export interface DecideInput<T> {
  // generic action name, e.g. the tool name or `public.posts.delete`
  action: string;
  org: string;
  // what the caller was asked to do: the call's own arguments
  args: any;
  reason: string;
  // extra checks on args a human edited, a reason to refuse or null
  validate?: (args: any, org: string) => Promise<string | null> | string | null;
  // runs the action with the (possibly edited) approved args
  execute: (args: any) => Promise<T>;
  // true when the result means nothing happened (a validation error): the
  // claim is released so the approved call can be repeated
  isNoop?: (result: T) => boolean;
  // same, for an error thrown before any side effect
  releaseOnError?: (err: unknown) => boolean;
  // duplicate protection for actions that create things (posts)
  guard?: ApprovalGuard;
}

// How an action protects against duplicates (design: G4 v3). The decision
// itself lives with the domain (PostsService); this hook only calls it
export interface ApprovalGuard {
  // one id for "this same action", to join an identical waiting request
  fingerprint: (args: any, org: string) => Promise<string | null> | string | null;
  // locks held while it runs, so two runs can't both pass the check
  locks: (args: any, org: string) => Promise<string[]> | string[];
  // request: inform (refuse an exact copy, warn on a resemblance)
  // execute: decide (an exact copy, or one the approver wasn't shown, is refused)
  check: (
    args: any,
    org: string,
    phase: 'request' | 'execute',
    shown: string[]
  ) => Promise<{ refuse?: string; warn?: string; shown?: string[] }>;
}

// How Postiz carries out an approved action on its own (no agent retry):
// each caller registers, per action name, how to run it for an organization
export interface ApprovalExecutor {
  execute: (orgId: string, args: any) => Promise<any>;
  validate?: (args: any, orgId: string) => Promise<string | null> | string | null;
  isNoop?: (result: any) => boolean;
  guard?: ApprovalGuard;
}

// Canonical JSON: sorted keys, like the DharaHIL SDK
export const canonicalJson = (value: any): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const approvalKey = (org: string, action: string, args: any) =>
  `postiz:${org}:${action}:${crypto
    .createHash('sha256')
    .update(canonicalJson(args))
    .digest('hex')
    .slice(0, 24)}`;

// The human reads these in a chat message: cap long strings
const redact = (value: any): any => {
  if (typeof value === 'string') {
    return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v)])
    );
  }
  return value;
};

// A refusal that came from us, not from the action
class ApprovalError extends Error {}

const defaultDeps = (): ApprovalDeps => ({
  fetch: (...a) => fetch(...a),
  redis: ioRedis,
  hasRedis: () => !!process.env.REDIS_URL,
  config: () => ({
    baseUrl: (process.env.DHARAHIL_BASE_URL || '').replace(/\/+$/, ''),
    tenantId: process.env.DHARAHIL_TENANT_ID || '',
    appId: process.env.DHARAHIL_APP_ID || '',
    apiKey: process.env.DHARAHIL_API_KEY || '',
  }),
});

export const createApprovalGate = (overrides: Partial<ApprovalDeps> = {}) => {
  const deps = { ...defaultDeps(), ...overrides };

  const call = async (
    cfg: ApprovalConfig,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ) => {
    let res;
    try {
      res = await deps.fetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-DHARA-API-KEY': cfg.apiKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: any) {
      throw new ApprovalError(`Approval service unreachable: ${err.message}`);
    }
    if (!res.ok) {
      throw new ApprovalError(`Approval service error: ${res.status}`);
    }
    return (await res.json()) as any;
  };

  const reqKey = (key: string) => `hil:req:${key}`;
  // a pending approval Postiz will carry out itself once a person approves
  const pendingKey = (requestId: string) => `hil:pending:${requestId}`;
  const pendingSet = 'hil:pending';
  const executors = new Map<string, ApprovalExecutor>();
  const joinKey = (org: string, fingerprint: string) =>
    `hil:join:${org}:${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 32)}`;
  const lockKey = (name: string) => `hil:lock:${name}`;
  const lockMs = 5 * 60 * 1000;
  // delete a lock only if it is still ours (it may have expired and been
  // taken by another run)
  const releaseScript =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

  // The stored pending entry: the args the person saw and what they were
  // shown as resemblances
  const pendingItem = async (requestId: string) => {
    const raw = await deps.redis.get(pendingKey(requestId));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as { args: any; shown?: string[] };
    } catch {
      return null;
    }
  };
  const execKey = (requestId: string) => `hil:exec:${requestId}`;

  const ttlUntil = (expiresAt: string) =>
    Math.max(60, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));

  const pending = (
    requestId: string,
    message: string,
    expiresAt?: string
  ): ApprovalDecision<never> => ({
    status: 'pending',
    requestId,
    expiresAt,
    message,
  });

  // Run the approved action at most once: the claim comes before the action
  const claimAndRun = async <T>(
    cfg: ApprovalConfig,
    requestId: string,
    version: number,
    args: any,
    input: DecideInput<T>,
    shown: string[] = []
  ): Promise<ApprovalDecision<T>> => {
    if (!input.guard) {
      return claimAndRunUnguarded(cfg, requestId, version, args, input);
    }

    // all locks or none, in a fixed order; a busy lock means "try again on
    // the next sweep", never run, never refuse
    const token = crypto.randomBytes(16).toString('hex');
    const names = [...new Set(await input.guard.locks(args, input.org))].sort();
    const taken: string[] = [];
    const release = async () => {
      for (const name of taken) {
        await deps.redis.eval(releaseScript, 1, lockKey(name), token);
      }
    };
    for (const name of names) {
      if (!(await deps.redis.set(lockKey(name), token, 'PX', lockMs, 'NX'))) {
        await release();
        return pending(
          requestId,
          `Approved; another run on the same post is in progress, Postiz will carry this out shortly (request ${requestId}).`
        );
      }
      taken.push(name);
    }

    try {
      const verdict = await input.guard.check(args, input.org, 'execute', shown);
      if (verdict.refuse) {
        await reportNotExecuted(cfg, requestId, version, verdict.refuse);
        await forgetPending(requestId);
        return { status: 'refused', duplicate: true, message: verdict.refuse };
      }
      return await claimAndRunUnguarded(cfg, requestId, version, args, input);
    } finally {
      await release();
    }
  };

  const reportNotExecuted = async (
    cfg: ApprovalConfig,
    requestId: string,
    version: number,
    reason: string
  ) => {
    try {
      await call(cfg, 'POST', `/v1/requests/${requestId}/executed`, {
        version,
        executed: false,
        result_summary: reason.slice(0, 500),
      });
    } catch (err: any) {
      console.error(`[approval] could not report ${requestId} not executed`, err.message);
    }
  };

  const forgetPending = async (requestId: string) => {
    await deps.redis.srem(pendingSet, requestId);
    await deps.redis.del(pendingKey(requestId));
  };

  const claimAndRunUnguarded = async <T>(
    cfg: ApprovalConfig,
    requestId: string,
    version: number,
    args: any,
    input: DecideInput<T>
  ): Promise<ApprovalDecision<T>> => {
    const claimed = await deps.redis.set(
      execKey(requestId),
      'running',
      'EX',
      claimTtl,
      'NX'
    );
    if (!claimed) {
      const state = await deps.redis.get(execKey(requestId));
      return state === 'done'
        ? {
            status: 'done',
            requestId,
            message: `This action was already done (request ${requestId}).`,
          }
        : {
            status: 'running',
            requestId,
            message: `This action was started earlier and its result is unknown; check before retrying (request ${requestId}).`,
          };
    }

    let result: T;
    try {
      result = await input.execute(args);
    } catch (err) {
      // an error before any side effect releases the claim; any other leaves
      // it as 'running', because the outcome is unknown
      if (input.releaseOnError?.(err)) {
        await deps.redis.del(execKey(requestId));
      }
      throw err;
    }

    if (input.isNoop?.(result)) {
      await deps.redis.del(execKey(requestId));
      return { status: 'executed', result };
    }

    await deps.redis.set(execKey(requestId), 'done', 'EX', claimTtl);
    try {
      await call(cfg, 'POST', `/v1/requests/${requestId}/executed`, {
        version,
        executed: true,
        result_summary: 'Executed by Postiz',
        result_hash: crypto
          .createHash('sha256')
          .update(canonicalJson(result ?? null))
          .digest('hex'),
      });
    } catch (err: any) {
      console.error(
        `[approval] could not report ${requestId} executed`,
        err.message
      );
    }
    return { status: 'executed', result };
  };

  const read = async <T>(
    cfg: ApprovalConfig,
    key: string,
    requestId: string,
    input: DecideInput<T>
  ): Promise<ApprovalDecision<T>> => {
    const data = await call(cfg, 'GET', `/v1/requests/${requestId}`);

    if (data.status === 'PENDING') {
      return pending(
        requestId,
        `Still waiting for human approval in DharaHIL (request ${requestId}). Postiz carries it out automatically once approved.`
      );
    }

    if (data.status === 'EXECUTED') {
      return {
        status: 'done',
        requestId,
        message: `This action was already done (request ${requestId}).`,
      };
    }

    if (data.status !== 'APPROVED') {
      await deps.redis.del(reqKey(key));
      return {
        status: 'refused',
        message: `Not approved (${data.status}${
          data.last_decision_note ? `: ${data.last_decision_note}` : ''
        }). Asking again starts a new request.`,
      };
    }

    // a human must have made the decision (not a rule or a standing grant)
    if (!data.last_decision_by?.email) {
      return {
        status: 'refused',
        message: `Approval request ${requestId} was not approved by a named person`,
      };
    }

    // the GET has no tool_name: the metadata we set ties it to this call
    if (data.metadata?.org !== input.org || data.metadata?.tool !== input.action) {
      return {
        status: 'refused',
        message: `Approval request ${requestId} does not match this organization or action`,
      };
    }

    await deps.redis.expire(reqKey(key), approvedTtl);

    // what runs is what the person approved: their edits, or else the args
    // stored when the request was filed, never a later caller's
    const stored = await pendingItem(requestId);
    const args = data.approved_args ?? stored?.args ?? input.args;
    if (input.validate) {
      const problem = await input.validate(args, input.org);
      if (problem) {
        return {
          status: 'refused',
          message: `The approved arguments were refused: ${problem}`,
        };
      }
    }

    return claimAndRun(
      cfg,
      requestId,
      data.version ?? 1,
      args,
      input,
      stored?.shown || []
    );
  };

  const ask = async <T>(
    cfg: ApprovalConfig,
    key: string,
    input: DecideInput<T>
  ): Promise<ApprovalDecision<T>> => {
    const mapped = await deps.redis.get(reqKey(key));
    if (mapped) {
      return read(cfg, key, mapped, input);
    }

    let reason = input.reason;
    let shown: string[] = [];
    let fingerprint: string | null = null;
    if (input.guard) {
      // an identical request still waiting (worded differently): join it
      fingerprint = await input.guard.fingerprint(input.args, input.org);
      if (fingerprint) {
        const waiting = await deps.redis.get(joinKey(input.org, fingerprint));
        if (waiting && (await pendingItem(waiting))) {
          const state = await call(cfg, 'GET', `/v1/requests/${waiting}`);
          if (state.status === 'PENDING') {
            await deps.redis.set(reqKey(key), waiting, 'EX', approvedTtl);
            return pending(
              waiting,
              `Identical to request ${waiting}, which is waiting for approval in DharaHIL. Nothing new was filed; request ${waiting}'s content is what will be carried out once approved. Do not retry.`
            );
          }
          if (state.status !== 'APPROVED') {
            await deps.redis.del(joinKey(input.org, fingerprint));
          } else {
            await deps.redis.set(reqKey(key), waiting, 'EX', approvedTtl);
            return read(cfg, key, waiting, input);
          }
        }
      }

      const verdict = await input.guard.check(input.args, input.org, 'request', []);
      if (verdict.refuse) {
        return { status: 'refused', duplicate: true, message: verdict.refuse };
      }
      if (verdict.warn) {
        reason = `${verdict.warn}\n\n${reason}`;
        shown = verdict.shown || [];
      }
    }

    const created = await call(cfg, 'POST', '/v1/requests', {
      tenant_id: cfg.tenantId,
      app_id: cfg.appId,
      agent_id: 'postiz-mcp',
      run_id: key,
      step_id: input.action,
      tool_name: input.action,
      tool_args: input.args,
      tool_args_redacted: redact(input.args),
      context_summary: reason,
      risk_level: 'HIGH',
      environment: 'production',
      tags: ['postiz', input.action],
      idempotency_key: key,
      metadata: {
        org: input.org,
        tool: input.action,
        ...(typeof input.args?.id === 'string' ? { post_id: input.args.id } : {}),
      },
      webhook: { url: '', headers: {}, decision_url: `${cfg.baseUrl}/v1/requests` },
    });

    // No request means the policy decided on its own (ALLOW, AUTO_ALLOWED, a
    // standing grant, DENY). Owner's rule: a human decides every one, so a
    // policy that allows without a human is a misconfiguration: refuse.
    if (!created.request_id) {
      return {
        status: 'refused',
        message: `Approval refused (${
          created.action || 'unknown'
        }): this action needs a human decision in DharaHIL, and the policy answered without one`,
      };
    }

    await deps.redis.set(
      reqKey(key),
      created.request_id,
      'EX',
      ttlUntil(created.expires_at)
    );
    if (created.status === 'PENDING') {
      // remembered so Postiz runs it itself the moment a person approves
      await deps.redis.set(
        pendingKey(created.request_id),
        JSON.stringify({
          action: input.action,
          org: input.org,
          args: input.args,
          key,
          shown,
        }),
        'EX',
        ttlUntil(created.expires_at) + approvedTtl
      );
      await deps.redis.sadd(pendingSet, created.request_id);
      if (fingerprint) {
        await deps.redis.set(
          joinKey(input.org, fingerprint),
          created.request_id,
          'EX',
          ttlUntil(created.expires_at) + approvedTtl
        );
      }
      return pending(
        created.request_id,
        `Approval requested in DharaHIL (request ${created.request_id}, expires ${created.expires_at}). Once a person approves, Postiz carries it out automatically: do not retry or change the request. Calling again with the same arguments only reports its status.`,
        created.expires_at
      );
    }
    // decided already (a standing grant): read the decision
    return read(cfg, key, created.request_id, input);
  };

  const decide = async <T>(
    input: DecideInput<T>
  ): Promise<ApprovalDecision<T>> => {
    const cfg = deps.config();
    if (!cfg.baseUrl || !cfg.tenantId || !cfg.appId || !cfg.apiKey) {
      return {
        status: 'refused',
        unavailable: true,
        message: 'approval service not configured, this action is refused',
      };
    }
    if (!deps.hasRedis()) {
      return {
        status: 'refused',
        unavailable: true,
        message:
          'Approval needs Redis (REDIS_URL is not set), this action is refused',
      };
    }

    try {
      return await ask(
        cfg,
        approvalKey(input.org, input.action, input.args),
        input
      );
    } catch (err) {
      // only our own failures are refusals; the action's errors pass through
      if (err instanceof ApprovalError) {
        return { status: 'refused', unavailable: true, message: err.message };
      }
      throw err;
    }
  };

  const registerExecutor = (action: string, executor: ApprovalExecutor) => {
    executors.set(action, executor);
  };

  // Carry out every pending action a person has approved since the last
  // sweep, through the same checks and at-most-once claim as a repeated
  // call, so an agent never has to resend an identical request
  const sweep = async () => {
    const cfg = deps.config();
    if (
      !cfg.baseUrl ||
      !cfg.tenantId ||
      !cfg.appId ||
      !cfg.apiKey ||
      !deps.hasRedis()
    ) {
      return;
    }

    const forget = async (requestId: string) => {
      await deps.redis.srem(pendingSet, requestId);
      await deps.redis.del(pendingKey(requestId));
    };

    for (const requestId of await deps.redis.smembers(pendingSet)) {
      const raw = await deps.redis.get(pendingKey(requestId));
      if (!raw) {
        await deps.redis.srem(pendingSet, requestId);
        continue;
      }
      // one unreadable entry must not stop every other approval
      let item: { action: string; org: string; args: any; key: string };
      try {
        item = JSON.parse(raw);
      } catch {
        console.error(`[approval] ${requestId} pending entry unreadable, dropped`);
        await forget(requestId);
        continue;
      }
      const executor = executors.get(item.action);
      if (!executor) {
        continue;
      }

      try {
        const decision = await read(cfg, item.key, requestId, {
          action: item.action,
          org: item.org,
          args: item.args,
          reason: '',
          validate: executor.validate,
          isNoop: executor.isNoop,
          guard: executor.guard,
          execute: (args) => executor.execute(item.org, args),
        });
        if (decision.status !== 'pending') {
          await forget(requestId);
          if (decision.status === 'refused') {
            console.error(`[approval] ${requestId} not carried out: ${decision.message}`);
          }
        }
      } catch (err: any) {
        // the approval service failing is transient: try again next sweep;
        // the action itself failing is not retried (its claim stays)
        if (!(err instanceof ApprovalError)) {
          await forget(requestId);
        }
        console.error(`[approval] ${requestId} sweep failed`, err?.message);
      }
    }
  };

  return { decide, registerExecutor, sweep };
};

export const approvalGate = createApprovalGate();

// Runs the sweep every 30 s in the backend; one sweep at a time
export const startApprovalSweep = (gate = approvalGate, everyMs = 30000) => {
  let running = false;
  const timer = setInterval(async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await gate.sweep();
    } catch (err: any) {
      console.error('[approval] sweep error', err?.message);
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref?.();
  return timer;
};
