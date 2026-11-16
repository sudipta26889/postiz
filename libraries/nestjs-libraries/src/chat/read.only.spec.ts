import 'reflect-metadata';

// LoadToolsService's collaborators are not needed for the read-only check
for (const path of [
  '@mastra/core/agent',
  '@ai-sdk/openai',
  '@mastra/memory',
  '@gitroom/nestjs-libraries/chat/mastra.store',
  '@gitroom/nestjs-libraries/chat/tools/tool.list',
  '@gitroom/nestjs-libraries/chat/mcp.approval',
  '@gitroom/nestjs-libraries/chat/human.approval',
  '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service',
  '@mastra/core/di',
]) {
  jest.doMock(path, () => new Proxy({}, { get: () => ({}) }));
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LoadToolsService } = require('@gitroom/nestjs-libraries/chat/load.tools.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runWithContext } = require('@gitroom/nestjs-libraries/chat/async.storage');

const tool = (readOnlyHint: boolean) => ({
  id: readOnlyHint ? 'listPosts' : 'schedulePost',
  mcp: { annotations: { readOnlyHint } },
  execute: jest.fn(async () => 'ran'),
});
const guard = (t: any) => (new LoadToolsService({} as any) as any).readOnlyGuard(t);
const as = (scope: string | undefined, fn: () => Promise<any>) =>
  runWithContext({ requestId: 'r', auth: undefined, surface: 'mcp', scope }, fn);

describe('read-only connections in MCP tools', () => {
  it('refuse a tool that changes data, with a reason', async () => {
    const write = guard(tool(false));
    await expect(as('mcp:read', () => write.execute({}, {}))).rejects.toThrow(/read-only.*schedulePost changes data/);
  });

  it('still run read-only tools', async () => {
    const read = guard(tool(true));
    await expect(as('mcp:read', () => read.execute({}, {}))).resolves.toBe('ran');
  });

  it('change nothing for read-and-write connections, API keys and the in-app chat', async () => {
    const write = guard(tool(false));
    await expect(as('mcp:read mcp:write', () => write.execute({}, {}))).resolves.toBe('ran');
    await expect(as(undefined, () => write.execute({}, {}))).resolves.toBe('ran');
  });
});

describe('read-only is checked before the approval gate', () => {
  it('a gated write under mcp:read is refused without filing an approval', async () => {
    const svc: any = new LoadToolsService({} as any);
    const decide = jest.fn(async () => ({ status: 'pending' }));
    svc.gate = (_p: any, t: any) => ({ ...t, execute: async (...a: any[]) => { await decide(); return t.execute(...a); } });
    const wrapped = svc.readOnlyGuard(svc.gate({}, tool(false)));
    await expect(as('mcp:read', () => wrapped.execute({}, {}))).rejects.toThrow(/read-only/);
    expect(decide).not.toHaveBeenCalled();
  });

  it('fails closed with no request context unless it is the in-app chat', async () => {
    const write = guard(tool(false));
    await expect(write.execute({}, {})).rejects.toThrow(/could not be identified/);
    const ui = { requestContext: { get: (k: string) => (k === 'ui' ? 'true' : undefined) } };
    await expect(write.execute({}, ui)).resolves.toBe('ran');
  });
});

