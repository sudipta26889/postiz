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
  | { status: 'refused'; message: string; unavailable?: boolean };

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
  // what the action is about, independent of how it is worded (a post id,
  // the channels and minute a post goes out): a reworded retry joins the
  // pending request instead of filing another, and an action already carried
  // out is not done again for a day
  target?: string;
}

// How Postiz carries out an approved action on its own (no agent retry):
// each caller registers, per action name, how to run it for an organization
export interface ApprovalExecutor {
  execute: (orgId: string, args: any) => Promise<any>;
  validate?: (args: any, orgId: string) => Promise<string | null> | string | null;
  isNoop?: (result: any) => boolean;
}

// The minute a post goes out, whatever format the date came in
const minuteOf = (date: unknown) => {
  const time = Date.parse(date as string);
  return Number.isNaN(time)
    ? String(date ?? '')
    : new Date(time).toISOString().slice(0, 16);
};

// What a post request is about, however it is worded: each channel, the
// minute it goes out and how (now / schedule). Shared by the MCP schedule
// tool and POST /public/v1/posts
export const postTarget = (
  items: { integrationId?: string; date?: unknown; type?: string }[]
) =>
  'posts:' +
  items
    .map((p) => `${p.integrationId ?? '?'}@${minuteOf(p.date)}:${p.type ?? '?'}`)
    .sort()
    .join(',');

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
  const doneTargetTtl = DAY;
  const targetId = (input: { org: string; action: string; target?: string }) =>
    input.target
      ? crypto
          .createHash('sha256')
          .update(`${input.org}|${input.action}|${input.target}`)
          .digest('hex')
          .slice(0, 24)
      : null;
  const pendingTargetKey = (t: string) => `hil:target:pending:${t}`;
  const doneTargetKey = (t: string) => `hil:target:done:${t}`;
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
    input: DecideInput<T>
  ): Promise<ApprovalDecision<T>> => {
    // a different request for the same target already ran: a duplicate
    const target = targetId(input);
    if (target) {
      const doneBy = await deps.redis.get(doneTargetKey(target));
      if (doneBy && doneBy !== requestId) {
        return {
          status: 'refused',
          message: `Not carried out: this duplicates request ${doneBy}, which was already done.`,
        };
      }
    }

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
    if (target) {
      await deps.redis.set(doneTargetKey(target), requestId, 'EX', doneTargetTtl);
      await deps.redis.del(pendingTargetKey(target));
    }
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
      const target = targetId(input);
      if (
        target &&
        (await deps.redis.get(pendingTargetKey(target))) === requestId
      ) {
        await deps.redis.del(pendingTargetKey(target));
      }
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

    const args = data.approved_args ?? input.args;
    if (input.validate) {
      const problem = await input.validate(args, input.org);
      if (problem) {
        return {
          status: 'refused',
          message: `The approved arguments were refused: ${problem}`,
        };
      }
    }

    return claimAndRun(cfg, requestId, data.version ?? 1, args, input);
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

    const target = targetId(input);
    if (target) {
      // already carried out: don't ask a person again
      const doneBy = await deps.redis.get(doneTargetKey(target));
      if (doneBy) {
        return {
          status: 'done',
          requestId: doneBy,
          message: `This was already done (request ${doneBy}); not asking again.`,
        };
      }
      // a reworded retry of a request still waiting: join it, file nothing
      const pendingBy = await deps.redis.get(pendingTargetKey(target));
      if (pendingBy && (await deps.redis.get(pendingKey(pendingBy)))) {
        await deps.redis.set(reqKey(key), pendingBy, 'EX', approvedTtl);
        return pending(
          pendingBy,
          `A request for this is already waiting in DharaHIL (request ${pendingBy}); no duplicate was filed. Postiz carries it out automatically once approved: do not retry.`
        );
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
      context_summary: input.reason,
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
          target: input.target,
        }),
        'EX',
        ttlUntil(created.expires_at) + approvedTtl
      );
      await deps.redis.sadd(pendingSet, created.request_id);
      if (target) {
        await deps.redis.set(
          pendingTargetKey(target),
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
      let item: {
        action: string;
        org: string;
        args: any;
        key: string;
        target?: string;
      };
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
          target: item.target,
          validate: executor.validate,
          isNoop: executor.isNoop,
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
