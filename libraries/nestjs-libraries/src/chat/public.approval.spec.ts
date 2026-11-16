import { HttpException } from '@nestjs/common';
import { createApprovalGate } from '@gitroom/nestjs-libraries/chat/human.approval';
import { createPublicApproval } from '@gitroom/nestjs-libraries/chat/public.approval';

const expiresAt = new Date(Date.now() + 3600_000).toISOString();
const json = (body: any, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

const setup = (answers: any[], hasRedis = true, configured = true) => {
  const data = new Map<string, string>();
  const queue = [...answers];
  const fetch = jest.fn(async () => queue.shift() ?? json({}));
  const approval = createPublicApproval(
    createApprovalGate({
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
      } as any,
      hasRedis: () => hasRedis,
      config: () =>
        configured
          ? { baseUrl: 'https://hil', tenantId: 't', appId: 'a', apiKey: 'k' }
          : { baseUrl: '', tenantId: '', appId: '', apiKey: '' },
    })
  );
  return { approval, fetch, data };
};

const created = json({
  request_id: 'req1',
  version: 1,
  status: 'PENDING',
  expires_at: expiresAt,
});
const approved = (action: string, args: any) =>
  json({
    status: 'APPROVED',
    version: 1,
    metadata: { org: 'org1', tool: action },
    approved_args: args,
  });

const call = (approval: any, action: string, args: any, execute: jest.Mock) =>
  approval.run({
    action,
    org: 'org1',
    args,
    reason: 'because',
    execute,
  });

const status = async (p: Promise<any>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    return { code: (err as HttpException).getStatus(), body: (err as HttpException).getResponse() as any };
  }
  throw new Error('expected an HttpException');
};

describe.each([
  ['public.posts.create', { type: 'now', date: '2026-01-01T00:00:00Z', posts: [] }],
  ['public.posts.delete', { id: 'p1' }],
  ['public.posts.deleteGroup', { group: 'g1' }],
])('public API gate for %s', (action, args) => {
  it('answers 428 first, the normal result after approval, 409 on repeat', async () => {
    const { approval } = setup([
      created,
      approved(action, args),
      json({}),
      approved(action, args),
    ]);
    const execute = jest.fn(async () => ({ ok: true }));

    const first = await status(call(approval, action, args, execute));
    expect(first.code).toBe(428);
    expect(first.body).toMatchObject({
      status: 'approval_pending',
      requestId: 'req1',
      expiresAt,
      message: expect.stringMatching(/identical request/),
    });
    expect(execute).not.toHaveBeenCalled();

    await expect(call(approval, action, args, execute)).resolves.toEqual({
      ok: true,
    });

    const again = await status(call(approval, action, args, execute));
    expect(again.code).toBe(409);
    expect(JSON.stringify(again.body)).toMatch(/already done \(request req1\)/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('answers 409 with the unknown-result text when a claim is running', async () => {
    const { approval, data } = setup([created, approved(action, args)]);
    const execute = jest.fn();
    await status(call(approval, action, args, execute));
    data.set('hil:exec:req1', 'running');
    const running = await status(call(approval, action, args, execute));
    expect(running.code).toBe(409);
    expect(JSON.stringify(running.body)).toMatch(/result is unknown/);
  });

  it('answers 403 when rejected', async () => {
    const { approval } = setup([created, json({ status: 'REJECTED' })]);
    await status(call(approval, action, args, jest.fn()));
    const rejected = await status(call(approval, action, args, jest.fn()));
    expect(rejected.code).toBe(403);
  });

  it('answers 403 with no config or no Redis', async () => {
    const execute = jest.fn();
    const noConfig = setup([], true, false);
    expect((await status(call(noConfig.approval, action, args, execute))).code).toBe(403);
    const noRedis = setup([], false);
    expect((await status(call(noRedis.approval, action, args, execute))).code).toBe(403);
    expect(noConfig.fetch).not.toHaveBeenCalled();
    expect(noRedis.fetch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs the edited args a human approved', async () => {
    const edited = { ...args, edited: true };
    const { approval } = setup([created, approved(action, edited), json({})]);
    const execute = jest.fn(async () => 'ok');
    await status(call(approval, action, args, execute));
    await call(approval, action, args, execute);
    expect(execute).toHaveBeenCalledWith(edited);
  });

  it('releases the claim when a 4xx stops the action before it did anything', async () => {
    const { approval } = setup([
      created,
      approved(action, args),
      approved(action, args),
      json({}),
    ]);
    const execute = jest
      .fn()
      .mockRejectedValueOnce(new HttpException('bad request', 400))
      .mockResolvedValueOnce('ok');
    await status(call(approval, action, args, execute));
    await expect(call(approval, action, args, execute)).rejects.toThrow(
      'bad request'
    );
    await expect(call(approval, action, args, execute)).resolves.toBe('ok');
  });
});
