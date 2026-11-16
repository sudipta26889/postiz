import {
  approvalKey,
  canonicalJson,
  createApprovalGate,
  publishReason,
} from '@gitroom/nestjs-libraries/chat/human.approval';

const expiresAt = new Date(Date.now() + 3600_000).toISOString();
const json = (body: any, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

const setup = (answers: any[], hasRedis = true) => {
  const data = new Map<string, string>();
  const queue = [...answers];
  const gate = createApprovalGate({
    fetch: (async () => queue.shift() ?? json({})) as any,
    redis: {
      get: async (k: string) => data.get(k) ?? null,
      // the lock release script: delete only if the token still matches
      eval: async (_script: string, _n: number, k: string, token: string) => (data.get(k) === token ? (data.delete(k), 1) : 0),
      set: async (k: string, v: string, ...o: any[]) => {
        if (o.includes('NX') && data.has(k)) return null;
        data.set(k, v);
        return 'OK';
      },
      del: async (k: string) => (data.delete(k) ? 1 : 0),
      expire: async () => 1,
      // sets (the pending approvals the sweep carries out)
      sadd: async (k: string, v: string) => { const set = new Set(JSON.parse((globalThis as any).__sets?.[k] ?? '[]')); set.add(v); ((globalThis as any).__sets ??= {})[k] = JSON.stringify([...set]); return 1; },
      srem: async (k: string, v: string) => { const set = new Set(JSON.parse((globalThis as any).__sets?.[k] ?? '[]')); set.delete(v); ((globalThis as any).__sets ??= {})[k] = JSON.stringify([...set]); return 1; },
      smembers: async (k: string) => JSON.parse((globalThis as any).__sets?.[k] ?? '[]'),
    } as any,
    hasRedis: () => hasRedis,
    config: () => ({ baseUrl: 'https://hil', tenantId: 't', appId: 'a', apiKey: 'k' }),
  });
  return { gate, data };
};

const created = json({
  request_id: 'req1',
  version: 1,
  status: 'PENDING',
  expires_at: expiresAt,
});
const approved = json({
  status: 'APPROVED',
  last_decision_by: { email: 'owner@example.test' },
  version: 2,
  metadata: { org: 'org1', tool: 'public.posts.delete' },
  approved_args: { id: 'p1' },
});

const input = (execute: jest.Mock) => ({
  action: 'public.posts.delete',
  org: 'org1',
  args: { id: 'p1' },
  reason: 'Deleting a post',
  execute,
});

describe('approval key', () => {
  it('is stable across key order and differs by args and org', () => {
    const a = approvalKey('org1', 'tool', { a: 1, b: { c: 2, d: 3 } });
    expect(approvalKey('org1', 'tool', { b: { d: 3, c: 2 }, a: 1 })).toBe(a);
    expect(approvalKey('org1', 'tool', { a: 2, b: { c: 2, d: 3 } })).not.toBe(a);
    expect(approvalKey('org2', 'tool', { a: 1, b: { c: 2, d: 3 } })).not.toBe(a);
    expect(a).toMatch(/^postiz:org1:tool:[0-9a-f]{24}$/);
  });

  it('sorts keys when serialising', () => {
    expect(canonicalJson({ b: [{ z: 1, a: 2 }], a: null })).toBe(
      '{"a":null,"b":[{"a":2,"z":1}]}'
    );
  });
});

describe('decide returns a transport-neutral decision', () => {
  it('pending, then done after the approved call ran once', async () => {
    const { gate } = setup([created, approved, json({}), approved]);
    const execute = jest.fn(async () => ({ deleted: true }));

    expect(await gate.decide(input(execute))).toMatchObject({
      status: 'pending',
      requestId: 'req1',
      expiresAt,
    });
    expect(await gate.decide(input(execute))).toEqual({
      status: 'executed',
      result: { deleted: true },
    });
    expect(await gate.decide(input(execute))).toMatchObject({
      status: 'done',
      requestId: 'req1',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reports running when a claim exists without a result', async () => {
    const { gate, data } = setup([created, approved]);
    const execute = jest.fn();
    await gate.decide(input(execute));
    data.set('hil:exec:req1', 'running');
    expect(await gate.decide(input(execute))).toMatchObject({
      status: 'running',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses on a rejection, without config and without Redis', async () => {
    const rejected = setup([created, json({ status: 'REJECTED' })]);
    const execute = jest.fn();
    await rejected.gate.decide(input(execute));
    expect(await rejected.gate.decide(input(execute))).toMatchObject({
      status: 'refused',
    });

    const noRedis = setup([], false);
    expect(await noRedis.gate.decide(input(execute))).toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/Redis/),
    });

    const noConfig = createApprovalGate({
      config: () => ({ baseUrl: '', tenantId: '', appId: '', apiKey: '' }),
      hasRedis: () => true,
    });
    expect(await noConfig.decide(input(execute))).toMatchObject({
      status: 'refused',
      message: expect.stringMatching(/not configured/),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('releases the claim when the action fails before any side effect', async () => {
    const { gate, data } = setup([created, approved, approved]);
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce('ok');
    await gate.decide({ ...input(execute), releaseOnError: () => true });
    await expect(
      gate.decide({ ...input(execute), releaseOnError: () => true })
    ).rejects.toThrow('not found');
    expect(data.has('hil:exec:req1')).toBe(false);
    expect(
      await gate.decide({ ...input(execute), releaseOnError: () => true })
    ).toEqual({ status: 'executed', result: 'ok' });
  });
});

describe('publishReason (shared trigger rule)', () => {
  it('gates anything that will be posted: now, scheduled near or far, unknown type', () => {
    expect(publishReason([{ type: 'now' }])).toBeTruthy();
    expect(publishReason([{ type: 'schedule' }])).toBeTruthy();
    expect(publishReason([{ type: 'update' }])).toBeTruthy();
    expect(publishReason([{}])).toBeTruthy();
    expect(publishReason([{ type: 'draft' }, { type: 'schedule' }])).toBeTruthy();
  });

  it('fails closed on a missing or empty list', () => {
    expect(publishReason(undefined)).toBeTruthy();
    expect(publishReason([])).toBeTruthy();
  });

  it('lets only drafts through', () => {
    expect(publishReason([{ type: 'draft' }, { type: 'draft' }])).toBeNull();
  });
});

describe('sweep: Postiz carries out an approved action itself', () => {
  beforeEach(() => {
    (globalThis as any).__sets = {};
  });

  const executor = () => {
    const run = jest.fn(async (_org: string, args: any) => ({ deleted: args.id }));
    return { run, executor: { execute: run } };
  };

  it('runs it once a person approves, with the approved args, without any agent retry', async () => {
    const { gate } = setup([created, approved, json({})]);
    const { run, executor: ex } = executor();
    gate.registerExecutor('public.posts.delete', ex);
    const neverCalled = jest.fn();

    expect((await gate.decide(input(neverCalled))).status).toBe('pending');
    await gate.sweep();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('org1', { id: 'p1' });
    expect(neverCalled).not.toHaveBeenCalled();

    // nothing left to sweep
    await gate.sweep();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting while the request is still pending', async () => {
    const { gate } = setup([created, json({ status: 'PENDING' })]);
    const { run, executor: ex } = executor();
    gate.registerExecutor('public.posts.delete', ex);
    await gate.decide(input(jest.fn()));
    await gate.sweep();
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse((globalThis as any).__sets['hil:pending'])).toEqual(['req1']);
  });

  it('drops a rejected request without running it', async () => {
    const { gate } = setup([created, json({ status: 'REJECTED' })]);
    const { run, executor: ex } = executor();
    gate.registerExecutor('public.posts.delete', ex);
    await gate.decide(input(jest.fn()));
    await gate.sweep();
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse((globalThis as any).__sets['hil:pending'])).toEqual([]);
  });

  it('never runs an approval twice: an agent repeating the call afterwards gets "already done"', async () => {
    const { gate } = setup([created, approved, json({}), approved]);
    const { run, executor: ex } = executor();
    gate.registerExecutor('public.posts.delete', ex);
    const agentExecute = jest.fn();
    await gate.decide(input(agentExecute));
    await gate.sweep();
    const again = await gate.decide(input(agentExecute));
    expect(again.status).toBe('done');
    expect(agentExecute).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses an approval with no named person, even in the sweep', async () => {
    const { gate } = setup([
      created,
      json({ status: 'APPROVED', version: 2, metadata: { org: 'org1', tool: 'public.posts.delete' } }),
    ]);
    const { run, executor: ex } = executor();
    gate.registerExecutor('public.posts.delete', ex);
    await gate.decide(input(jest.fn()));
    await gate.sweep();
    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing without config or Redis', async () => {
    const { gate } = setup([], false);
    await expect(gate.sweep()).resolves.toBeUndefined();
  });
});

describe('sweep robustness', () => {
  beforeEach(() => {
    (globalThis as any).__sets = {};
  });

  it('drops an unreadable pending entry and still runs the others', async () => {
    const { gate, data } = setup([created, approved, json({})]);
    const run = jest.fn(async () => 'ok');
    gate.registerExecutor('public.posts.delete', { execute: run });
    await gate.decide(input(jest.fn()));
    // a corrupt entry next to the good one
    (globalThis as any).__sets['hil:pending'] = JSON.stringify(['bad', 'req1']);
    data.set('hil:pending:bad', '{not json');
    await gate.sweep();
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse((globalThis as any).__sets['hil:pending'])).toEqual([]);
  });
});

describe('duplicate guard (G4 v3)', () => {
  beforeEach(() => {
    (globalThis as any).__sets = {};
  });

  // a gate whose fetch calls can be inspected
  const guardedSetup = (answers: any[]) => {
    const data = new Map<string, string>();
    const queue = [...answers];
    const fetch = jest.fn(async () => queue.shift() ?? json({}));
    const gate = createApprovalGate({
      fetch: fetch as any,
      redis: {
        get: async (k: string) => data.get(k) ?? null,
        eval: async (_s: string, _n: number, k: string, token: string) =>
          data.get(k) === token ? (data.delete(k), 1) : 0,
        set: async (k: string, v: string, ...o: any[]) => {
          if (o.includes('NX') && data.has(k)) return null;
          data.set(k, v);
          return 'OK';
        },
        del: async (k: string) => (data.delete(k) ? 1 : 0),
        expire: async () => 1,
        sadd: async (k: string, v: string) => {
          const set = new Set(JSON.parse((globalThis as any).__sets?.[k] ?? '[]'));
          set.add(v);
          ((globalThis as any).__sets ??= {})[k] = JSON.stringify([...set]);
          return 1;
        },
        srem: async (k: string, v: string) => {
          const set = new Set(JSON.parse((globalThis as any).__sets?.[k] ?? '[]'));
          set.delete(v);
          ((globalThis as any).__sets ??= {})[k] = JSON.stringify([...set]);
          return 1;
        },
        smembers: async (k: string) => JSON.parse((globalThis as any).__sets?.[k] ?? '[]'),
      } as any,
      hasRedis: () => true,
      config: () => ({ baseUrl: 'https://hil', tenantId: 't', appId: 'a', apiKey: 'k' }),
    });
    const filed = () =>
      fetch.mock.calls.filter(
        ([url, init]: any) => init?.method === 'POST' && url.endsWith('/v1/requests')
      );
    const reportedNotExecuted = () =>
      fetch.mock.calls.filter(
        ([url, init]: any) =>
          url.endsWith('/executed') && JSON.parse(init.body).executed === false
      );
    return { gate, data, fetch, filed, reportedNotExecuted };
  };

  const approvedPost = (extra: any = {}) =>
    json({
      status: 'APPROVED',
      last_decision_by: { email: 'owner@example.test' },
      version: 2,
      metadata: { org: 'org1', tool: 'public.posts.create' },
      ...extra,
    });

  const guard = (opts: {
    fingerprint?: string | null;
    request?: any;
    execute?: any;
  } = {}) => ({
    fingerprint: jest.fn(() => opts.fingerprint ?? 'fp-1'),
    locks: jest.fn(() => ['post:org1:loose-1']),
    check: jest.fn(async (_a: any, _o: string, phase: string) =>
      phase === 'request' ? opts.request ?? {} : opts.execute ?? {}
    ),
  });

  const postInput = (g: any, args: any = { text: 'hello' }, execute = jest.fn(async () => 'posted')) => ({
    action: 'public.posts.create',
    org: 'org1',
    args,
    reason: 'Publishing or scheduling a post',
    guard: g,
    execute,
  });

  it('refuses an exact copy at request time and files nothing', async () => {
    const { gate, filed } = guardedSetup([]);
    const result = await gate.decide(
      postInput(guard({ request: { refuse: 'This exact post already exists: post X' } }))
    );
    expect(result).toMatchObject({ status: 'refused', duplicate: true });
    expect((result as any).message).toMatch(/already exists/);
    expect(filed()).toHaveLength(0);
  });

  it('files a look-alike with the warning first and remembers what was shown', async () => {
    const { gate, filed, data } = guardedSetup([created]);
    await gate.decide(
      postInput(guard({ request: { warn: '⚠ Resembles post X', shown: ['X'] } }))
    );
    const body = JSON.parse((filed()[0] as any)[1].body);
    expect(body.context_summary).toMatch(/^⚠ Resembles post X/);
    expect(JSON.parse(data.get('hil:pending:req1')!).shown).toEqual(['X']);
  });

  it('joins a reworded retry to the identical request still waiting', async () => {
    const { gate, filed } = guardedSetup([created, json({ status: 'PENDING' })]);
    await gate.decide(postInput(guard(), { text: 'hello' }));
    const again = await gate.decide(postInput(guard(), { text: 'HELLO ', extra: 1 }));
    expect(again).toMatchObject({ status: 'pending', requestId: 'req1' });
    expect((again as any).message).toMatch(/Identical to request req1/);
    expect(filed()).toHaveLength(1);
  });

  it('does not join a request that was rejected meanwhile: files a new one', async () => {
    const created2 = json({ request_id: 'req2', version: 1, status: 'PENDING', expires_at: expiresAt });
    const { gate, filed } = guardedSetup([created, json({ status: 'REJECTED' }), created2]);
    await gate.decide(postInput(guard(), { text: 'hello' }));
    const again = await gate.decide(postInput(guard(), { text: 'hello', v: 2 }));
    expect(again).toMatchObject({ status: 'pending', requestId: 'req2' });
    expect(filed()).toHaveLength(2);
  });

  it('never runs a duplicate at execution: reports not executed, runs nothing', async () => {
    const { gate, reportedNotExecuted } = guardedSetup([created, approvedPost(), json({})]);
    const run = jest.fn();
    const g = guard({ execute: { refuse: 'This exact post already exists: post X. Nothing was posted.' } });
    gate.registerExecutor('public.posts.create', { execute: run, guard: g });
    await gate.decide(postInput(g));
    await gate.sweep();
    expect(run).not.toHaveBeenCalled();
    expect(reportedNotExecuted()).toHaveLength(1);
    expect(JSON.parse((globalThis as any).__sets['hil:pending'])).toEqual([]);
  });

  it('waits (never runs, never refuses) while another run holds the lock', async () => {
    const { gate, data } = guardedSetup([created, approvedPost(), approvedPost(), json({})]);
    const run = jest.fn(async () => 'posted');
    const g = guard();
    gate.registerExecutor('public.posts.create', { execute: run, guard: g });
    await gate.decide(postInput(g));
    data.set('hil:lock:post:org1:loose-1', 'someone-else');
    await gate.sweep();
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse((globalThis as any).__sets['hil:pending'])).toEqual(['req1']);

    data.delete('hil:lock:post:org1:loose-1');
    await gate.sweep();
    expect(run).toHaveBeenCalledTimes(1);
    // our lock is released afterwards
    expect(data.has('hil:lock:post:org1:loose-1')).toBe(false);
  });

  it('decides with what the approver was shown, and runs the args they saw', async () => {
    const { gate } = guardedSetup([created, approvedPost(), json({})]);
    const run = jest.fn(async () => 'posted');
    const g = guard({ request: { warn: '⚠ Resembles post X', shown: ['X'] } });
    gate.registerExecutor('public.posts.create', { execute: run, guard: g });
    await gate.decide(postInput(g, { text: 'as filed' }));
    await gate.sweep();
    expect(g.check).toHaveBeenLastCalledWith({ text: 'as filed' }, 'org1', 'execute', ['X']);
    // no approved_args from DharaHIL: the stored, filed args run
    expect(run).toHaveBeenCalledWith('org1', { text: 'as filed' });
  });
});
