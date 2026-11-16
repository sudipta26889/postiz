import {
  ApprovalDeps,
  createApprovalGate,
} from '@gitroom/nestjs-libraries/chat/human.approval';
import { createMcpApproval } from '@gitroom/nestjs-libraries/chat/mcp.approval';
import { runWithContext } from '@gitroom/nestjs-libraries/chat/async.storage';

// An ioredis stand-in that honours EX and NX like the real one
const fakeRedis = () => {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string, ...opts: any[]) => {
      if (opts.includes('NX') && data.has(k)) return null;
      data.set(k, v);
      return 'OK';
    },
    del: async (k: string) => (data.delete(k) ? 1 : 0),
    expire: async () => 1,
  };
};

const expiresAt = new Date(Date.now() + 3600_000).toISOString();
const json = (body: any, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

const setup = (answers: any[], overrides: Partial<ApprovalDeps> = {}) => {
  const redis = fakeRedis();
  const calls: { url: string; init: any }[] = [];
  const queue = [...answers];
  const fetch = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? json({}, 200);
  });
  const gate = createMcpApproval(createApprovalGate({
    fetch: fetch as any,
    redis: redis as any,
    hasRedis: () => true,
    config: () => ({
      baseUrl: 'https://hil.test',
      tenantId: 'tenant',
      appId: 'postiz',
      apiKey: 'key',
    }),
    ...overrides,
  }));
  return { gate, redis, calls, fetch };
};

const ctx = { auth: { id: 'org1' } } as any;
const args = { id: 'post1' };

const run = (
  gate: ReturnType<typeof createMcpApproval>,
  execute: jest.Mock,
  opts: { args?: any; org?: string; validate?: any } = {}
) =>
  runWithContext({ requestId: 'r', auth: undefined, surface: 'mcp' }, () =>
    gate.withApproval({
      toolName: 'deletePostTool',
      approval: () => 'Deleting a post',
      validate: opts.validate,
      execute,
    })(opts.args ?? args, {
      mcp: { extra: { authInfo: { id: opts.org ?? 'org1' } } },
    })
  );

const created = (status = 'PENDING', extra: any = {}) =>
  json({
    request_id: 'req1',
    version: 1,
    status,
    expires_at: expiresAt,
    metadata: { org: 'org1', tool: 'deletePostTool' },
    ...extra,
  });

describe('approval decision mapping', () => {
  it('runs at once when the policy allows', async () => {
    for (const action of ['ALLOW', 'AUTO_ALLOWED']) {
      const { gate } = setup([json({ action, request_id: null })]);
      const execute = jest.fn(async () => ({ output: { postId: 'p' } }));
      await expect(run(gate, execute)).resolves.toEqual({
        output: { postId: 'p' },
      });
      expect(execute).toHaveBeenCalledWith(args, expect.anything());
    }
  });

  it('refuses when the policy denies, or on any error', async () => {
    const execute = jest.fn();
    for (const answers of [
      [json({ action: 'DENY', request_id: null })],
      [json({}, 500)],
      [new Error('network down')],
    ]) {
      const { gate } = setup(answers);
      await expect(run(gate, execute)).rejects.toThrow();
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks the human and waits on REQUIRE_APPROVAL', async () => {
    const { gate, calls, redis } = setup([created()]);
    const execute = jest.fn();
    const result: any = await run(gate, execute);
    expect(result.output.errors).toMatch(/Waiting for human approval/);
    expect(result.output.errors).toContain('req1');
    expect(execute).not.toHaveBeenCalled();

    const body = JSON.parse(calls[0].init.body);
    expect(calls[0].url).toBe('https://hil.test/v1/requests');
    expect(calls[0].init.headers['X-DHARA-API-KEY']).toBe('key');
    expect(body.risk_level).toBe('HIGH');
    expect(body.run_id).toBe(body.idempotency_key);
    expect(body.metadata).toMatchObject({
      org: 'org1',
      tool: 'deletePostTool',
      post_id: 'post1',
    });
    expect([...redis.data.keys()].some((k) => k.startsWith('hil:req:'))).toBe(
      true
    );
  });

  it('says still waiting while PENDING, without a second request', async () => {
    const { gate, calls } = setup([created(), json({ status: 'PENDING' })]);
    const execute = jest.fn();
    await run(gate, execute);
    const result: any = await run(gate, execute);
    expect(result.output.errors).toMatch(/still waiting/i);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://hil.test/v1/requests/req1');
  });

  it.each([
    'REJECTED',
    'AUTO_DENIED',
    'EXPIRED',
    'REVISE_REQUESTED',
    'DENY',
    'SOMETHING_NEW',
  ])('refuses %s, drops the mapping and starts fresh next time', async (status) => {
    const { gate, redis } = setup([created(), json({ status }), created()]);
    const execute = jest.fn();
    await run(gate, execute);
    await expect(run(gate, execute)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect([...redis.data.keys()].some((k) => k.startsWith('hil:req:'))).toBe(
      false
    );
    const again: any = await run(gate, execute);
    expect(again.output.errors).toMatch(/Waiting for human approval/);
  });

  it('refuses an APPROVED request that belongs to another org or tool', async () => {
    const { gate } = setup([
      created(),
      json({ status: 'APPROVED', version: 1, metadata: { org: 'org2', tool: 'deletePostTool' } }),
    ]);
    const execute = jest.fn();
    await run(gate, execute);
    await expect(run(gate, execute)).rejects.toThrow(/does not match/);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('claim: at most once', () => {
  const approved = (extra: any = {}) =>
    json({
      status: 'APPROVED',
      version: 3,
      metadata: { org: 'org1', tool: 'deletePostTool' },
      approved_args: args,
      ...extra,
    });

  it('runs the action once and reports it executed', async () => {
    const { gate, calls } = setup([
      created(),
      approved(),
      json({ status: 'recorded' }),
      approved(),
    ]);
    const execute = jest.fn(async () => ({ output: { postId: 'post1' } }));
    await run(gate, execute);
    await expect(run(gate, execute)).resolves.toEqual({
      output: { postId: 'post1' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const report = calls.find((c) => c.url.endsWith('/executed'))!;
    expect(JSON.parse(report.init.body)).toMatchObject({
      version: 3,
      executed: true,
    });

    // a second call after the action: the claim is held as done
    const again: any = await run(gate, execute);
    expect(again.output.errors).toMatch(/already done \(request req1\)/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('still returns the result when the executed report fails', async () => {
    const { gate } = setup([created(), approved(), json({}, 500)]);
    const execute = jest.fn(async () => ({ output: { postId: 'post1' } }));
    await run(gate, execute);
    await expect(run(gate, execute)).resolves.toEqual({
      output: { postId: 'post1' },
    });
  });

  it('refuses a second execution and tells running from done', async () => {
    const { gate, redis } = setup([created(), approved(), approved()]);
    const execute = jest.fn();
    await run(gate, execute);
    redis.data.set('hil:exec:req1', 'running');
    const running: any = await run(gate, execute);
    expect(running.output.errors).toMatch(/result is unknown/);

    redis.data.set('hil:exec:req1', 'done');
    const done: any = await run(gate, execute);
    expect(done.output.errors).toMatch(/already done/);
    expect(running.output.errors).not.toBe(done.output.errors);
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers already done for an EXECUTED request', async () => {
    const { gate } = setup([created(), json({ status: 'EXECUTED' })]);
    const execute = jest.fn();
    await run(gate, execute);
    const result: any = await run(gate, execute);
    expect(result.output.errors).toMatch(/already done/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses edited args that fail validation, before claiming', async () => {
    const { gate, redis } = setup([
      created(),
      approved({ approved_args: { id: 'someone-elses' } }),
    ]);
    const execute = jest.fn();
    const validate = jest.fn(async () => 'integration not in this org');
    await run(gate, execute, { validate });
    await expect(run(gate, execute, { validate })).rejects.toThrow(
      /integration not in this org/
    );
    expect(validate).toHaveBeenCalledWith({ id: 'someone-elses' }, 'org1');
    expect(execute).not.toHaveBeenCalled();
    expect(redis.data.has('hil:exec:req1')).toBe(false);
  });

  it('runs the edited args when they validate', async () => {
    const { gate } = setup([
      created(),
      approved({ approved_args: { id: 'edited' } }),
      json({ status: 'recorded' }),
    ]);
    const execute = jest.fn(async () => ({ output: { postId: 'edited' } }));
    await run(gate, execute);
    await run(gate, execute);
    expect(execute).toHaveBeenCalledWith({ id: 'edited' }, expect.anything());
  });

  it('refuses when Redis is a mock (no REDIS_URL), before any request', async () => {
    const { gate, fetch } = setup([], { hasRedis: () => false });
    const execute = jest.fn();
    await expect(run(gate, execute)).rejects.toThrow(/Redis/);
    expect(fetch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('fail closed', () => {
  it('refuses without config', async () => {
    const { gate, fetch } = setup([], {
      config: () => ({ baseUrl: '', tenantId: '', appId: '', apiKey: '' }),
    });
    const execute = jest.fn();
    await expect(run(gate, execute)).rejects.toThrow(
      /approval service not configured/
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('gates when the surface is undefined or mcp, skips only for app', async () => {
    const wrapped = (gate: any, execute: any) =>
      gate.withApproval({
        toolName: 'deletePostTool',
        approval: () => 'x',
        execute,
      });
    const { gate } = setup([created(), json({ status: 'PENDING' })]);
    const execute = jest.fn(async () => 'ran');

    const noSurface = await runWithContext(
      { requestId: 'r', auth: undefined } as any,
      () => wrapped(gate, execute)(args, { mcp: { extra: { authInfo: { id: 'org1' } } } })
    );
    expect((noSurface as any).output.errors).toMatch(/Waiting/);

    const outsideContext = await wrapped(gate, execute)(args, {
      mcp: { extra: { authInfo: { id: 'org1' } } },
    });
    expect((outsideContext as any).output.errors).toMatch(/waiting/i);
    expect(execute).not.toHaveBeenCalled();

    const app = await runWithContext(
      { requestId: 'r', auth: undefined, surface: 'app' },
      () => wrapped(gate, execute)(args, {})
    );
    expect(app).toBe('ran');
  });

  it('does not ask when the tool says no approval is needed', async () => {
    const { gate, fetch } = setup([]);
    const execute = jest.fn(async () => 'ran');
    const result = await runWithContext(
      { requestId: 'r', auth: undefined, surface: 'mcp' },
      () =>
        gate.withApproval({
          toolName: 'deletePostTool',
          approval: () => null,
          execute,
        })(args, {})
    );
    expect(result).toBe('ran');
    expect(fetch).not.toHaveBeenCalled();
  });
});
