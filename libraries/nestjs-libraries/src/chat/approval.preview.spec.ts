import { approvalKey, createApprovalGate } from '@gitroom/nestjs-libraries/chat/human.approval';

// design: docs/designs/approval-preview.md
const expiresAt = new Date(Date.now() + 3600_000).toISOString();
const json = (body: any, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

const setup = (answers: any[], hasRedis = true) => {
  const data = new Map<string, string>();
  const queue = [...answers];
  const sent: { url: string; method: string; body: any }[] = [];
  const gate = createApprovalGate({
    fetch: (async (url: string, init: any) => {
      sent.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
      return queue.shift() ?? json({});
    }) as any,
    redis: {
      get: async (k: string) => (k.endsWith(':index') ? ((globalThis as any).__sets ?? {})[k] ?? null : data.get(k) ?? null),
      // the lock release script: delete only if the token still matches
      eval: async (script: string, _n: number, k: string, arg: string) => { const g = ((globalThis as any).__sets ??= {}); if (script.includes('table.insert(t, ARGV[1])')) { const list: string[] = JSON.parse(g[k] ?? '[]'); if (list.includes(arg)) return 0; list.push(arg); g[k] = JSON.stringify(list); return 1; } if (script.includes('x ~= ARGV[1]')) { const list: string[] = JSON.parse(g[k] ?? '[]'); g[k] = JSON.stringify(list.filter((x) => x !== arg)); return 1; } return data.get(k) === arg ? (data.delete(k), 1) : 0; },
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
  return { gate, data, sent };
};


const created = json({ request_id: 'req1', version: 1, status: 'PENDING', expires_at: expiresAt });
const staged = [{ postId: 'd1', hash: 'h1', schedule: true }];
const preview = jest.fn(async (args: any, _org: string, previous: any) =>
  previous ?? {
    args: { ...args, staged },
    links: [{ label: 'ProDevs (x), planned 2027-06-01 10:00 UTC', url: 'https://postiz.test/p/d1?share=true' }],
  }
);
const input = (execute = jest.fn()) => ({
  action: 'public.posts.create',
  org: 'org1',
  args: { type: 'schedule', posts: [{ text: 'hi' }] },
  reason: 'Publishing a post',
  preview,
  execute,
});

beforeEach(() => {
  preview.mockClear();
  (globalThis as any).__sets = {};
});

describe('approval preview: the approver opens the real post', () => {
  it('files the staged args, a url field per link and the links in the summary', async () => {
    const { gate, sent } = setup([created]);
    expect(await gate.decide(input())).toMatchObject({ status: 'pending', requestId: 'req1' });

    const filed = sent.find((s) => s.method === 'POST' && s.url.endsWith('/v1/requests'))!.body;
    expect(filed.tool_args.staged).toEqual(staged);
    expect(filed.tool_args_redacted.preview_1).toBe('https://postiz.test/p/d1?share=true');
    expect(filed.display_hints.sections[0].fields).toEqual([
      { key: 'preview_1', label: 'ProDevs (x), planned 2027-06-01 10:00 UTC', type: 'url' },
    ]);
    expect(filed.context_summary).toContain('https://postiz.test/p/d1?share=true');
    // DharaHIL refuses (422) any metadata value that is not a string
    expect(filed.metadata.staged).toBe('true');
    for (const value of Object.values(filed.metadata)) {
      expect(typeof value).toBe('string');
    }
  });

  it('an identical call stages nothing again, and the approved run gets the staged args', async () => {
    const approved = json({
      status: 'APPROVED',
      last_decision_by: { email: 'owner@example.test' },
      version: 2,
      metadata: { org: 'org1', tool: 'public.posts.create' },
    });
    const { gate } = setup([created, approved, json({})]);
    const execute = jest.fn(async () => ({ ok: true }));
    await gate.decide(input(execute));
    await gate.decide(input(execute));

    expect(preview).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ staged }));
  });

  it('after a refusal a new request reuses the kept staging (no second draft)', async () => {
    const rejected = json({ status: 'REJECTED', version: 2, metadata: { org: 'org1', tool: 'public.posts.create' } });
    const { gate } = setup([created, rejected, json({ ...JSON.parse('{}'), request_id: 'req2', version: 1, status: 'PENDING', expires_at: expiresAt })]);
    await gate.decide(input());
    expect((await gate.decide(input())).status).toBe('refused');
    await gate.decide(input());

    expect(preview).toHaveBeenCalledTimes(2);
    // the second staging call was handed the first one's result to reuse
    expect((preview.mock.calls[1] as any)[2]?.args?.staged).toEqual(staged);
  });

  it('an error that says nothing was done releases the claim and says so', async () => {
    const approved = json({
      status: 'APPROVED',
      last_decision_by: { email: 'owner@example.test' },
      version: 2,
      metadata: { org: 'org1', tool: 'public.posts.create' },
    });
    const { gate, data, sent } = setup([created, approved]);
    const err: any = new Error('planned time passed');
    err.getResponse = () => ({ nothingDone: true });
    await gate.decide(input());
    await expect(gate.decide(input(jest.fn(async () => { throw err; })))).rejects.toThrow('planned time passed');

    expect(data.get('hil:exec:req1')).toBeUndefined();
    const report = sent.find((s) => s.url.endsWith('/v1/requests/req1/executed'));
    expect(JSON.stringify(report?.body)).toContain('nothing was done');
  });

  it('a staged request never runs raw args, even from a caller that joined it', async () => {
    const approved = json({
      status: 'APPROVED',
      last_decision_by: { email: 'owner@example.test' },
      version: 2,
      metadata: { org: 'org1', tool: 'public.posts.create', staged: 'true' },
    });
    // a differently worded caller mapped to the request; its pending entry
    // and the staging are gone (another key, or expired)
    const { gate, data } = setup([approved]);
    const execute = jest.fn();
    const other = { ...input(execute), args: { type: 'schedule', posts: [{ text: 'hi there' }] } };
    data.set(`hil:req:${approvalKey('org1', 'public.posts.create', other.args)}`, 'req9');

    const result: any = await gate.decide(other);
    expect(result.status).toBe('refused');
    expect(result.message).toContain('could not be found');
    expect(execute).not.toHaveBeenCalled();
  });

  it('an edit made in DharaHIL to a staged request is refused, not silently dropped', async () => {
    const edited = json({
      status: 'APPROVED',
      last_decision_by: { email: 'owner@example.test' },
      version: 2,
      metadata: { org: 'org1', tool: 'public.posts.create', staged: 'true' },
      approved_args: { type: 'schedule', posts: [{ text: 'edited by the approver' }], staged },
    });
    const { gate } = setup([created, edited]);
    const execute = jest.fn();
    await gate.decide(input(execute));
    const result: any = await gate.decide(input(execute));
    expect(result.message).toContain('edited in DharaHIL');
    expect(execute).not.toHaveBeenCalled();
  });

  it('two identical calls at the same moment stage only once', async () => {
    const { gate } = setup([created]);
    let release: () => void = () => undefined;
    const slow = jest.fn(
      (args: any) =>
        new Promise<any>((resolve) => {
          release = () => resolve({ args: { ...args, staged }, links: [] });
        })
    );
    const first = gate.decide({ ...input(), preview: slow });
    await new Promise((r) => setTimeout(r, 0));
    const second: any = await gate.decide({ ...input(), preview: slow });
    release();
    await first;
    expect(second.status).toBe('refused');
    expect(second.message).toContain('being filed right now');
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
