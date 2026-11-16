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
const serviceWith = (posts: any[]) => {
  const service = Object.create(PostsService.prototype);
  const getRecentChannelPosts = jest.fn(async () => posts);
  (service as any)._postRepository = { getRecentChannelPosts };
  return { service, getRecentChannelPosts };
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
    expect(verdict.refuse).toMatch(/channels not posted: chan-2 \(resend those alone\)/);
  });

  it('looks only at this org and these channels, excluding the draft itself', async () => {
    const { service, getRecentChannelPosts } = serviceWith([]);
    await service.approvalDuplicateCheck('org1', [item()], 'execute', [], 'draft-1');
    expect(getRecentChannelPosts).toHaveBeenCalledWith(
      'org1',
      ['chan-1'],
      expect.any(Date),
      'draft-1'
    );
  });

  it('gives the same join fingerprint however the items are ordered', () => {
    const { service } = serviceWith([]);
    const a = item();
    const b = item({ integrationId: 'chan-2' });
    expect(service.approvalFingerprint([a, b])).toBe(service.approvalFingerprint([b, a]));
  });
});
