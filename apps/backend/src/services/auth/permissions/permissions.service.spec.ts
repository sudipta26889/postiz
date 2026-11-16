import 'reflect-metadata';

for (const path of [
  '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  '@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.service',
]) {
  jest.doMock(path, () => new Proxy({}, { get: () => class {} }));
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PermissionsService } = require('@gitroom/backend/services/auth/permissions/permissions.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AuthorizationActions, Sections } = require('@gitroom/backend/services/auth/permissions/permission.exception.class');

describe('admin-only actions without billing (no Stripe key)', () => {
  const saved = process.env.STRIPE_PUBLISHABLE_KEY;
  beforeAll(() => delete process.env.STRIPE_PUBLISHABLE_KEY);
  afterAll(() => {
    if (saved !== undefined) process.env.STRIPE_PUBLISHABLE_KEY = saved;
  });

  const svc = new PermissionsService({} as any, {} as any, {} as any, {} as any);
  const can = async (role: string, section: any) =>
    (
      await svc.check('o1', new Date(), role, [[AuthorizationActions.Create, section]])
    ).can(AuthorizationActions.Create, section);

  it('a plain member is refused admin-only actions', async () => {
    expect(await can('USER', Sections.ADMIN)).toBe(false);
  });

  it('admins and the owner keep them', async () => {
    expect(await can('ADMIN', Sections.ADMIN)).toBe(true);
    expect(await can('SUPERADMIN', Sections.ADMIN)).toBe(true);
  });

  it('plan limits stay lifted for everyone', async () => {
    expect(await can('USER', Sections.CHANNEL)).toBe(true);
    expect(await can('USER', Sections.TEAM_MEMBERS)).toBe(true);
  });
});
