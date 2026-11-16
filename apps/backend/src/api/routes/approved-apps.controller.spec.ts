import 'reflect-metadata';

jest.mock('@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service', () => ({
  OAuthService: class {},
}));
jest.mock('@gitroom/backend/services/auth/permissions/permissions.ability', () => ({
  CheckPolicies: () => () => undefined,
}));

import { ApprovedAppsController } from '@gitroom/backend/api/routes/approved-apps.controller';

const orgAs = (role: string) => ({ id: 'o1', users: [{ role }] }) as any;
const statusOf = async (p: Promise<any>) => {
  try {
    await p;
    return 200;
  } catch (err: any) {
    return err.getStatus();
  }
};

describe('organization connections are admin-only, even when billing (Stripe) is off', () => {
  const service = {
    getOrganizationConnections: jest.fn(async () => []),
    revokeOrganizationConnection: jest.fn(async () => ({ success: true, revoked: true })),
  };
  const controller = new ApprovedAppsController(service as any);

  it('a plain member gets 403 on list and revoke, and nothing is read or revoked', async () => {
    expect(await statusOf(controller.organizationConnections(orgAs('USER')))).toBe(403);
    expect(await statusOf(controller.revokeOrganizationConnection(orgAs('USER'), 'auth1'))).toBe(403);
    expect(service.getOrganizationConnections).not.toHaveBeenCalled();
    expect(service.revokeOrganizationConnection).not.toHaveBeenCalled();
  });

  it('an ADMIN or SUPERADMIN gets through', async () => {
    for (const role of ['ADMIN', 'SUPERADMIN']) {
      expect(await statusOf(controller.organizationConnections(orgAs(role)))).toBe(200);
    }
    expect(await statusOf(controller.revokeOrganizationConnection(orgAs('ADMIN'), 'auth1'))).toBe(200);
  });
});
