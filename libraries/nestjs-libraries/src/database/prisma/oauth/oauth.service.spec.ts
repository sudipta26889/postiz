import 'reflect-metadata';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.repository',
  () => ({ OAuthRepository: class {} })
);
jest.mock('@gitroom/helpers/auth/auth.service', () => ({
  AuthService: { fixedEncryption: (v: string) => `enc(${v})` },
}));

import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';

const dynamicApp = (tokenEndpointAuthMethod: string) => ({
  id: 'app1',
  clientId: 'pca_dyn',
  dynamic: true,
  tokenEndpointAuthMethod,
  redirectUris: JSON.stringify(['https://client.example/cb']),
  redirectUrl: '',
});
const staticApp = {
  id: 'app2',
  clientId: 'pca_static',
  dynamic: false,
  tokenEndpointAuthMethod: null,
  redirectUris: null,
  redirectUrl: 'https://integrator.example/cb',
};

const service = (app: any, repo: any = {}) =>
  new OAuthService({
    getAppByClientId: jest.fn(async () => app),
    ...repo,
  } as any);

const statusOf = async (p: Promise<any>) => {
  try {
    await p;
    return 200;
  } catch (err: any) {
    return err.getStatus();
  }
};

describe('PKCE S256 is required for every MCP (dynamic) client', () => {
  const redirectUri = 'https://client.example/cb';

  it.each(['none', 'client_secret_post', 'client_secret_basic'])(
    'refuses a %s dynamic client without a code_challenge',
    async (method) => {
      expect(
        await statusOf(
          service(dynamicApp(method)).validateAuthorizationRequest('pca_dyn', {
            redirectUri,
          })
        )
      ).toBe(400);
    }
  );

  it('refuses plain, and a missing method (which means plain)', async () => {
    for (const codeChallengeMethod of ['plain', undefined]) {
      expect(
        await statusOf(
          service(dynamicApp('client_secret_post')).validateAuthorizationRequest(
            'pca_dyn',
            { redirectUri, codeChallenge: 'abc', codeChallengeMethod }
          )
        )
      ).toBe(400);
    }
  });

  it('accepts S256', async () => {
    expect(
      await statusOf(
        service(dynamicApp('client_secret_post')).validateAuthorizationRequest(
          'pca_dyn',
          { redirectUri, codeChallenge: 'abc', codeChallengeMethod: 'S256' }
        )
      )
    ).toBe(200);
  });

  it('keeps the lenient flow for a confidential static org app', async () => {
    expect(
      await statusOf(service(staticApp).validateAuthorizationRequest('pca_static'))
    ).toBe(200);
  });
});

describe('an OAuth token works only while its user is an active member', () => {
  const grant = { userId: 'u1', organizationId: 'o1', organization: { id: 'o1' } };

  it('resolves the grant for an active member', async () => {
    const isActiveMember = jest.fn(async () => true);
    const svc = service(null, {
      findByAccessToken: jest.fn(async () => grant),
      isActiveMember,
    });
    expect(await svc.getOrgByOAuthToken('pos_x')).toBe(grant);
    expect(isActiveMember).toHaveBeenCalledWith('u1', 'o1');
  });

  it('refuses the token once the user is removed, disabled or deleted', async () => {
    const svc = service(null, {
      findByAccessToken: jest.fn(async () => grant),
      isActiveMember: jest.fn(async () => false),
    });
    expect(await svc.getOrgByOAuthToken('pos_x')).toBeNull();
  });

  it('refuses an unknown or revoked token without a membership lookup', async () => {
    const isActiveMember = jest.fn();
    const svc = service(null, {
      findByAccessToken: jest.fn(async () => null),
      isActiveMember,
    });
    expect(await svc.getOrgByOAuthToken('pos_x')).toBeNull();
    expect(isActiveMember).not.toHaveBeenCalled();
  });
});
