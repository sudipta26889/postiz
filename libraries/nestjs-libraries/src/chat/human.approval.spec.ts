import {
  approvalKey,
  canonicalJson,
  createApprovalGate,
  publishNowReason,
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
      set: async (k: string, v: string, ...o: any[]) => {
        if (o.includes('NX') && data.has(k)) return null;
        data.set(k, v);
        return 'OK';
      },
      del: async (k: string) => (data.delete(k) ? 1 : 0),
      expire: async () => 1,
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

describe('publishNowReason (shared trigger rule)', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  const at = (m: number) => new Date(now + m * 60_000).toISOString();

  it('gates now, a past date, within 5 minutes, and unparseable dates', () => {
    expect(publishNowReason([{ type: 'now', date: at(60) }], now)).toBeTruthy();
    for (const m of [-60, 0, 5]) {
      expect(publishNowReason([{ type: 'schedule', date: at(m) }], now)).toBeTruthy();
    }
    expect(publishNowReason([{ type: 'schedule', date: 'soon' }], now)).toBeTruthy();
    expect(publishNowReason([{ type: 'schedule' }], now)).toBeTruthy();
  });

  it('lets a future date and drafts through', () => {
    expect(publishNowReason([{ type: 'schedule', date: at(6) }], now)).toBeNull();
    expect(publishNowReason([{ type: 'draft', date: at(-60) }], now)).toBeNull();
    expect(publishNowReason(undefined, now)).toBeNull();
  });
});
