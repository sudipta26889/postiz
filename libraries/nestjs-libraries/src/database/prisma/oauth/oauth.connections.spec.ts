import 'reflect-metadata';

jest.mock('@gitroom/helpers/auth/auth.service', () => ({
  AuthService: { fixedEncryption: (v: string) => `enc(${v})` },
}));

import { OAuthRepository } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.repository';
import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';

// a repository over fake Prisma models that records every query
const recordingRepository = (count = 1) => {
  const oAuthAuthorization = {
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count })),
  };
  const oAuthToken = { updateMany: jest.fn(async () => ({ count: 2 })) };
  const model = (m: any) => ({ model: m });
  const repo = new OAuthRepository(
    model({}) as any,
    model({ oAuthAuthorization }) as any,
    model({}) as any,
    model({}) as any,
    model({ oAuthToken }) as any,
    model({}) as any
  );
  return { repo, oAuthAuthorization, oAuthToken };
};

const secretsIn = (query: any) =>
  JSON.stringify(query.select).match(/accessToken|authorizationCode|clientSecret|codeChallenge|apiKey/g);

describe('connection lists never carry a credential', () => {
  it("a user's approved apps: only display fields, live connections incl. rotating (H2) ones", async () => {
    const { repo, oAuthAuthorization } = recordingRepository();
    await repo.getApprovedApps('u1');
    const query = (oAuthAuthorization.findMany.mock.calls[0] as any)[0];
    expect(secretsIn(query)).toBeNull();
    expect(query.where).toMatchObject({ userId: 'u1', revokedAt: null });
    // a legacy token, or a still-valid rotating token
    expect(JSON.stringify(query.where.OR)).toContain('"tokens"');
    expect(JSON.stringify(query.where.OR)).toContain('"accessToken"');
  });

  it("an organization's connections: also who made each, still no credential", async () => {
    const { repo, oAuthAuthorization } = recordingRepository();
    await repo.getOrganizationConnections('o1');
    const query = (oAuthAuthorization.findMany.mock.calls[0] as any)[0];
    expect(secretsIn(query)).toBeNull();
    expect(query.where).toMatchObject({ organizationId: 'o1', revokedAt: null });
    expect(query.select.user).toEqual({ select: { name: true, email: true } });
  });
});

describe('revoking a connection', () => {
  it('an admin can revoke only within their own organization, and its tokens end too', async () => {
    const { repo, oAuthAuthorization, oAuthToken } = recordingRepository(1);
    const svc = new OAuthService(repo);
    expect(await svc.revokeOrganizationConnection('o1', 'auth1')).toEqual({ success: true, revoked: true });
    expect((oAuthAuthorization.updateMany.mock.calls[0] as any)[0].where).toEqual({ id: 'auth1', organizationId: 'o1' });
    expect((oAuthToken.updateMany.mock.calls[0] as any)[0].where).toMatchObject({ authorizationId: 'auth1' });
  });

  it("another organization's connection: nothing revoked, no tokens touched", async () => {
    const { repo, oAuthToken } = recordingRepository(0);
    const svc = new OAuthService(repo);
    expect(await svc.revokeOrganizationConnection('o1', 'foreign')).toEqual({ success: true, revoked: false });
    expect(oAuthToken.updateMany).not.toHaveBeenCalled();
  });

  it("a user revokes only their own grant, and its rotating tokens end", async () => {
    const { repo, oAuthAuthorization, oAuthToken } = recordingRepository(1);
    const svc = new OAuthService(repo);
    await svc.revokeApp('u1', 'auth1');
    expect((oAuthAuthorization.updateMany.mock.calls[0] as any)[0].where).toEqual({ id: 'auth1', userId: 'u1' });
    expect(oAuthToken.updateMany).toHaveBeenCalled();
  });
});
