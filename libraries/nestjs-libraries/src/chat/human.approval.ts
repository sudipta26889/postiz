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
        `Still waiting for human approval in DharaHIL (request ${requestId}).`
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
      return pending(
        created.request_id,
        `Waiting for human approval in DharaHIL (request ${created.request_id}, expires ${created.expires_at}). Repeat the identical call once approved.`,
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

  return { decide };
};

export const approvalGate = createApprovalGate();
