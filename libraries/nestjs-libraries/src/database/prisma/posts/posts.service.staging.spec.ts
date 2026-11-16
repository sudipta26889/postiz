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


// design: docs/designs/approval-preview.md. Staged drafts are tested on a
// bare instance: the post reads and the status change are stubbed
const draft = (id: string, extra: any = {}) => ({
  id,
  state: 'DRAFT',
  content: '<p>Hello</p>',
  settings: '{}',
  image: '[]',
  integrationId: 'chan-1',
  publishDate: new Date(Date.now() + 3600_000),
  integration: { name: 'ProDevs', providerIdentifier: 'x' },
  ...extra,
});
const serviceWith = (posts: Record<string, any>) => {
  const service = Object.create(PostsService.prototype);
  service.getPostsRecursively = jest.fn(async (id: string) => (posts[id] ? [posts[id]] : []));
  service.changePostStatus = jest.fn(async (_org: string, id: string) => ({ id, state: 'QUEUE' }));
  return service;
};
const errorOf = async (p: Promise<any>) => {
  try {
    await p;
    return null;
  } catch (err: any) {
    return err.getResponse();
  }
};

describe('a staged draft is scheduled exactly as previewed', () => {
  it('schedules the unchanged drafts, and leaves a "keep as draft" item alone', async () => {
    const posts = { d1: draft('d1'), d2: draft('d2') };
    const service = serviceWith(posts);
    const staged = await service.approvalStage('o1', [
      { postId: 'd1', schedule: true },
      { postId: 'd2', schedule: false },
    ]);
    const result = await service.approvalScheduleStaged('o1', staged);

    expect(service.changePostStatus).toHaveBeenCalledTimes(1);
    expect(service.changePostStatus).toHaveBeenCalledWith('o1', 'd1', 'schedule');
    expect(result[0]).toMatchObject({ postId: 'd1', state: 'QUEUE' });
  });

  it('refuses all of them, scheduling nothing, when one changed after filing', async () => {
    const posts: any = { d1: draft('d1'), d2: draft('d2') };
    const service = serviceWith(posts);
    const staged = await service.approvalStage('o1', [
      { postId: 'd1', schedule: true },
      { postId: 'd2', schedule: true },
    ]);
    posts.d2 = draft('d2', { content: '<p>Swapped after the request</p>' });

    expect(await errorOf(service.approvalScheduleStaged('o1', staged))).toMatchObject({ nothingDone: true });
    expect(service.changePostStatus).not.toHaveBeenCalled();
  });

  it('refuses a draft that is no longer a draft (scheduled or deleted meanwhile)', async () => {
    const posts: any = { d1: draft('d1') };
    const service = serviceWith(posts);
    const staged = await service.approvalStage('o1', [{ postId: 'd1', schedule: true }]);
    posts.d1 = draft('d1', { state: 'QUEUE' });
    expect(await errorOf(service.approvalScheduleStaged('o1', staged))).toMatchObject({ nothingDone: true });
    delete posts.d1;
    expect(await errorOf(service.approvalScheduleStaged('o1', staged))).toMatchObject({ nothingDone: true });
    expect(service.changePostStatus).not.toHaveBeenCalled();
  });

  it('never posts a scheduled post whose planned time passed while waiting', async () => {
    const past = new Date(Date.now() - 3 * 3600_000);
    const service = serviceWith({ d1: draft('d1', { publishDate: past }) });
    const staged = await service.approvalStage('o1', [{ postId: 'd1', schedule: true }]);

    const err = await errorOf(service.approvalScheduleStaged('o1', staged));
    expect(err).toMatchObject({ nothingDone: true });
    expect(err.msg).toContain('passed before the approval');
    expect(service.changePostStatus).not.toHaveBeenCalled();
  });

  it('a "post now" request goes out on approval, however late', async () => {
    const service = serviceWith({ d1: draft('d1', { publishDate: new Date(Date.now() - 3 * 3600_000) }) });
    const staged = await service.approvalStage('o1', [{ postId: 'd1', schedule: true, now: true }]);
    await service.approvalScheduleStaged('o1', staged);
    expect(service.changePostStatus).toHaveBeenCalledWith('o1', 'd1', 'schedule');
  });

  it('labels each link with its channel and planned time', async () => {
    process.env.FRONTEND_URL = 'https://postiz.test';
    const service = serviceWith({ d1: draft('d1', { publishDate: new Date('2027-06-01T10:00:00Z') }) });
    expect(await service.approvalLinks('o1', ['d1'])).toEqual([
      { label: 'ProDevs (x), planned 2027-06-01 10:00 UTC', url: 'https://postiz.test/p/d1?share=true' },
    ]);
  });
});
