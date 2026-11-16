import {
  approvalKey,
  canonicalJson,
  postTarget,
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
  const fetch = jest.fn(async () => queue.shift() ?? json({}));
  const gate = createApprovalGate({
    fetch: fetch as any,
    redis: {
      get: async (k: string) => data.get(k) ?? null,
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
  return { gate, data, fetch };
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

describe('duplicates: a target is approved and carried out once', () => {
  beforeEach(() => {
    (globalThis as any).__sets = {};
  });

  const withTarget = (args: any, execute = jest.fn()) => ({
    ...input(execute),
    args,
    target: 'post:p1',
  });
  const posts = (fetch: jest.Mock) =>
    fetch.mock.calls.filter(
      ([url, init]: any) => init?.method === 'POST' && url.endsWith('/v1/requests')
    ).length;

  it('joins a reworded retry to the request already waiting, filing nothing new', async () => {
    const { gate, fetch } = setup([created]);
    const first = await gate.decide(withTarget({ id: 'p1' }));
    const reworded = await gate.decide(withTarget({ id: 'p1', note: 'please' }));
    expect(first).toMatchObject({ status: 'pending', requestId: 'req1' });
    expect(reworded).toMatchObject({ status: 'pending', requestId: 'req1' });
    expect((reworded as any).message).toMatch(/no duplicate was filed/);
    expect(posts(fetch)).toBe(1);
  });

  it('does not ask again once the target was carried out', async () => {
    const { gate, fetch } = setup([created, approved, json({})]);
    const run = jest.fn(async () => 'ok');
    gate.registerExecutor('public.posts.delete', { execute: run });
    await gate.decide(withTarget({ id: 'p1' }));
    await gate.sweep();
    expect(run).toHaveBeenCalledTimes(1);

    const later = await gate.decide(withTarget({ id: 'p1', note: 'again' }));
    expect(later.status).toBe('done');
    expect(posts(fetch)).toBe(1);
  });

  it('runs only one of two separately filed requests for the same target', async () => {
    const created2 = json({
      request_id: 'req2',
      version: 1,
      status: 'PENDING',
      expires_at: expiresAt,
    });
    const approved2 = json({
      status: 'APPROVED',
      last_decision_by: { email: 'owner@example.test' },
      version: 2,
      metadata: { org: 'org1', tool: 'public.posts.delete' },
      approved_args: { id: 'p1', note: 'x' },
    });
    const { gate, data } = setup([created, created2, approved, json({}), approved2]);
    const run = jest.fn(async () => 'ok');
    gate.registerExecutor('public.posts.delete', { execute: run });

    await gate.decide(withTarget({ id: 'p1' }));
    // the first request's target index expired: a second request gets filed
    for (const k of [...data.keys()]) {
      if (k.startsWith('hil:target:pending:')) data.delete(k);
    }
    expect((await gate.decide(withTarget({ id: 'p1', note: 'x' }))).requestId).toBe('req2');

    await gate.sweep();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('postTarget', () => {
  it('ignores date format and item order, and keeps channel, minute and type', () => {
    const a = postTarget([
      { integrationId: 'i2', date: '2026-12-01T10:00:00Z', type: 'schedule' },
      { integrationId: 'i1', date: '2026-12-01T10:00:30.000Z', type: 'schedule' },
    ]);
    const b = postTarget([
      { integrationId: 'i1', date: '2026-12-01T15:30:00+05:30', type: 'schedule' },
      { integrationId: 'i2', date: 'Tue, 01 Dec 2026 10:00:00 GMT', type: 'schedule' },
    ]);
    expect(b).toBe(a);
    expect(
      postTarget([{ integrationId: 'i1', date: '2026-12-01T10:01:00Z', type: 'schedule' }])
    ).not.toBe(
      postTarget([{ integrationId: 'i1', date: '2026-12-01T10:00:00Z', type: 'schedule' }])
    );
  });
});
