import 'reflect-metadata';

// ESM-only sanitiser pulled in through the DTOs: not used by the duplicate
// decision under test
jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (v: string) => v,
}));
// collaborators the duplicate decision doesn't use (social providers, the
// AI and upload services, Temporal, image processing)
for (const path of [
  '@gitroom/nestjs-libraries/integrations/integration.manager',
  '@gitroom/nestjs-libraries/integrations/refresh.integration.service',
  '@gitroom/nestjs-libraries/integrations/social.abstract',
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository',
  '@gitroom/nestjs-libraries/openai/openai.service',
  '@gitroom/nestjs-libraries/short-linking/short.link.service',
  '@gitroom/nestjs-libraries/upload/upload.factory',
  '@gitroom/nestjs-libraries/redis/redis.service',
  '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher',
  'nestjs-temporal-core',
  'sharp',
]) {
  jest.doMock(path, () => new Proxy({}, { get: () => class {} }));
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PostsService } = require('@gitroom/nestjs-libraries/database/prisma/posts/posts.service');

// PostsService has many collaborators; the duplicate decision only needs the
// repository read, so it is tested on a bare instance
const serviceWith = (
  posts: any[],
  states: { id: string; state: string }[] = [],
  groups: Record<string, { id: string; state: string }[]> = {}
) => {
  const service = Object.create(PostsService.prototype);
  const getRecentChannelPosts = jest.fn(async () => posts);
  const getPostStates = jest.fn(async (_org: string, ids: string[]) =>
    states.filter((p) => ids.includes(p.id))
  );
  const getPostIdsInGroup = jest.fn(async (_org: string, group: string) => groups[group] || []);
  (service as any)._postRepository = { getRecentChannelPosts, getPostStates, getPostIdsInGroup };
  return { service, getRecentChannelPosts, getPostStates };
};

const stored = (extra: any = {}) => ({
  id: 'p-old',
  integrationId: 'chan-1',
  content: '<p>Hello world</p>',
  image: JSON.stringify([{ id: 'm1', path: 'https://cdn/x.png' }]),
  state: 'QUEUE',
  publishDate: new Date('2026-11-17T10:00:00Z'),
  ...extra,
});
const item = (extra: any = {}) => ({
  integrationId: 'chan-1',
  content: '<p>Hello world</p>',
  media: [{ id: 'new-id', path: 'https://cdn/x.png' }],
  ...extra,
});

describe('approval duplicate decision (PostsService, G4 v3)', () => {
  it('treats formatting, entities, zero-width characters and case as the same post', async () => {
    const { service } = serviceWith([stored()]);
    const retry = item({
      content: '<p>HELLO&nbsp;&nbsp;</p><p>​world</p>',
    });
    const verdict = await service.approvalDuplicateCheck('org1', [retry], 'request');
    expect(verdict.refuse).toMatch(/This exact post already exists: post p-old/);
  });

  it('matches MCP attachments (url strings) and REST media ({id, path}) by path, never id', () => {
    const { service } = serviceWith([]);
    expect(
      service.approvalFingerprints(item({ media: ['https://cdn/x.png'] })).exact
    ).toBe(service.approvalFingerprints(item()).exact);
  });

  it('calls a copy with different links or re-saved images a near match, not a duplicate', async () => {
    for (const post of [
      stored({ content: '<p>Hello world https://short.ly/a</p>' }),
      stored({ image: JSON.stringify([{ path: 'https://cdn/converted.jpg' }]) }),
    ]) {
      const { service } = serviceWith([post]);
      const ask = await service.approvalDuplicateCheck(
        'org1',
        [item({ content: '<p>Hello world https://example.com/a</p>' })],
        'request'
      );
      expect(ask.refuse).toBeUndefined();
      expect(ask.warn).toMatch(/^⚠ Resembles post p-old/);
      expect(ask.shown).toEqual(['p-old']);
    }
  });

  it('treats a failed (ERROR) earlier post as a near match, so a person decides', async () => {
    const { service } = serviceWith([stored({ state: 'ERROR' })]);
    const ask = await service.approvalDuplicateCheck('org1', [item()], 'request');
    expect(ask.refuse).toBeUndefined();
    expect(ask.shown).toEqual(['p-old']);
  });

  it('never matches a genuinely different post on the same channel', async () => {
    const { service } = serviceWith([stored()]);
    const verdict = await service.approvalDuplicateCheck(
      'org1',
      [item({ content: '<p>Something else entirely</p>' })],
      'execute'
    );
    expect(verdict).toEqual({});
  });

  it('at execution runs a near match only if the approver was shown it', async () => {
    const { service } = serviceWith([stored({ state: 'ERROR' })]);
    expect(
      (await service.approvalDuplicateCheck('org1', [item()], 'execute', [])).refuse
    ).toMatch(/approver was not shown/);
    expect(
      await service.approvalDuplicateCheck('org1', [item()], 'execute', ['p-old'])
    ).toEqual({});
  });

  it('names the channels that were not posted when only some are duplicates', async () => {
    const { service } = serviceWith([stored()]);
    const verdict = await service.approvalDuplicateCheck(
      'org1',
      [item(), item({ integrationId: 'chan-2' })],
      'execute'
    );
    expect(verdict.refuse).toMatch(/not posted either: channel chan-2 \(resend those alone\)/);
  });

  it('looks only at this org and these channels, excluding the draft itself', async () => {
    const { service, getRecentChannelPosts } = serviceWith([], [{ id: 'draft-1', state: 'DRAFT' }]);
    await service.approvalDuplicateCheck('org1', [item()], 'execute', [], ['draft-1']);
    expect(getRecentChannelPosts).toHaveBeenCalledWith(
      'org1',
      ['chan-1'],
      expect.any(Date),
      ['draft-1']
    );
  });

  it('gives the same join fingerprint however the items are ordered', () => {
    const { service } = serviceWith([]);
    const a = item();
    const b = item({ integrationId: 'chan-2' });
    expect(service.approvalFingerprint([a, b])).toBe(service.approvalFingerprint([b, a]));
  });

  it('names each post that was not posted, by its label, even on one channel', async () => {
    const { service } = serviceWith([stored()]);
    const verdict = await service.approvalDuplicateCheck(
      'org1',
      [
        item({ label: 'chan-1 Monday' }),
        item({ label: 'chan-1 Tuesday', content: '<p>Another day</p>' }),
      ],
      'execute'
    );
    expect(verdict.refuse).toMatch(/not posted either: chan-1 Tuesday/);
    expect(verdict.refuse).not.toMatch(/chan-1 Monday \(resend/);
  });

  it('does not count a queued post as a copy of itself when it is being edited', async () => {
    const { service, getRecentChannelPosts } = serviceWith([], [{ id: 'p-old', state: 'QUEUE' }]);
    await service.approvalDuplicateCheck('org1', [item()], 'request', [], ['p-old']);
    expect(getRecentChannelPosts).toHaveBeenCalledWith('org1', ['chan-1'], expect.any(Date), ['p-old']);
  });

  it('refuses an "edit" of a post that already went out or failed (it would post again)', async () => {
    for (const state of ['PUBLISHED', 'ERROR']) {
      const { service, getRecentChannelPosts } = serviceWith([stored({ state })], [{ id: 'p-old', state }]);
      const verdict = await service.approvalDuplicateCheck('org1', [item()], 'execute', [], ['p-old']);
      expect(verdict.refuse).toMatch(new RegExp(`edits post p-old \\(${state}\\).*would post it again`));
      expect(getRecentChannelPosts).not.toHaveBeenCalled();
    }
  });

  it('never excludes an id from another organization (not found = not excluded)', async () => {
    const { service, getRecentChannelPosts } = serviceWith([stored()], []);
    const verdict = await service.approvalDuplicateCheck('org1', [item()], 'execute', [], ['p-old']);
    expect(getRecentChannelPosts).toHaveBeenCalledWith('org1', ['chan-1'], expect.any(Date), []);
    expect(verdict.refuse).toMatch(/This exact post already exists/);
  });

  it('schedules only a draft: a queued or published post gives no items to approve', async () => {
    const { service } = serviceWith([]);
    for (const state of ['QUEUE', 'PUBLISHED', 'ERROR']) {
      (service as any).getPostsRecursively = jest.fn(async () => [stored({ state })]);
      expect(await service.approvalItemsOfPost('org1', 'p-old')).toEqual([]);
    }
    (service as any).getPostsRecursively = jest.fn(async () => [stored({ state: 'DRAFT' })]);
    expect(await service.approvalItemsOfPost('org1', 'p-old')).toHaveLength(1);
  });

  it('refuses saving a draft over a post that already went out (draft-then-schedule would post it again)', async () => {
    for (const state of ['PUBLISHED', 'ERROR']) {
      const { service } = serviceWith([], [{ id: 'p-pub', state }]);
      const edits = await service.approvalEditCheck('org1', ['p-pub'], 'draft');
      expect(edits.refuse).toMatch(new RegExp(`edits post p-pub \\(${state}\\).*Nothing was saved`));
    }
    const { service } = serviceWith([], [{ id: 'p-q', state: 'QUEUE' }, { id: 'p-d', state: 'DRAFT' }]);
    expect(await service.approvalEditCheck('org1', ['p-q', 'p-d', 'brand-new'], 'draft')).toEqual({
      editable: ['p-q', 'p-d'],
    });
  });

  it('refuses a save into an existing group that would delete the posts it does not name', async () => {
    const group = { G: [{ id: 'q1', state: 'QUEUE' }, { id: 'pub1', state: 'PUBLISHED' }] };
    const { service } = serviceWith([], [], group);
    // a "draft" with group G and no ids: saving it would delete q1 and pub1
    const edits = await service.approvalEditCheck('org1', [], 'draft', 'G');
    expect(edits.refuse).toMatch(/would delete post q1 \(QUEUE\), post pub1 \(PUBLISHED\) of group G.*approved delete route.*Nothing was saved/);
  });

  it('allows a save into a group that names every post in it (a real edit of drafts/queued posts)', async () => {
    const group = { G: [{ id: 'q1', state: 'QUEUE' }, { id: 'd1', state: 'DRAFT' }] };
    const { service } = serviceWith([], [{ id: 'q1', state: 'QUEUE' }, { id: 'd1', state: 'DRAFT' }], group);
    expect(await service.approvalEditCheck('org1', ['q1', 'd1'], 'draft', 'G')).toEqual({
      editable: ['q1', 'd1'],
    });
  });

  it('a new group (nothing in it) is an ordinary create', async () => {
    const { service } = serviceWith([]);
    expect(await service.approvalEditCheck('org1', [], 'draft', 'fresh-group')).toEqual({ editable: [] });
  });
});
