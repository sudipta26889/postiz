import 'reflect-metadata';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.repository',
  () => ({ OAuthRepository: class {} })
);
jest.mock('@gitroom/helpers/auth/auth.service', () => ({
  AuthService: { fixedEncryption: (v: string) => `enc(${v})` },
}));

import { createHash } from 'crypto';
import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';

// the canonical MCP resources are built from this (start.mcp.ts does the same)
process.env.NEXT_PUBLIC_BACKEND_URL = 'https://postiz.example/api';
const RESOURCE = 'https://postiz.example/mcp-oauth-dynamic';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

const dynamicPublic = {
  id: 'app1',
  clientId: 'pca_dyn',
  dynamic: true,
  tokenEndpointAuthMethod: 'none',
  clientSecret: null,
  redirectUris: JSON.stringify(['https://client.example/cb']),
  redirectUrl: '',
};

const grant = {
  id: 'auth1',
  oauthAppId: 'app1',
  userId: 'u1',
  organizationId: 'o1',
  revokedAt: null,
  organization: { id: 'o1', paymentId: 'cus_1' },
};

const repoWith = (over: any = {}) => ({
  getAppByClientId: jest.fn(async () => dynamicPublic),
  findByCode: jest.fn(async () => ({
    ...grant,
    codeExpiresAt: new Date(Date.now() + 60_000),
    codeChallenge: null,
    codeChallengeMethod: null,
    redirectUri: null,
  })),
  consumeCode: jest.fn(async () => true),
  issueTokens: jest.fn(async () => ({ count: 2 })),
  findTokenByHash: jest.fn(async () => null),
  rotateRefresh: jest.fn(async () => true),
  graceReissue: jest.fn(async () => true),
  pruneExpiredTokens: jest.fn(async () => ({ count: 0 })),
  revokeFamilyAndGrant: jest.fn(async () => undefined),
  isActiveMember: jest.fn(async () => true),
  findByAccessToken: jest.fn(async () => null),
  clearLegacyAccessToken: jest.fn(async () => ({ id: 'auth1' })),
  createAuthorization: jest.fn(async () => ({ id: 'auth1' })),
  revokeTokensOfAuthorization: jest.fn(async () => ({ count: 0 })),
  ...over,
});
const service = (repo: any) => {
  const svc = new OAuthService(repo as any);
  // PKCE and redirect checks are H1's; these tests are about the tokens
  (svc as any).verifyCodeGrant = () => undefined;
  return svc;
};
const errorOf = async (p: Promise<any>) => {
  try {
    await p;
    return null;
  } catch (err: any) {
    return { status: err.getStatus(), body: err.getResponse() };
  }
};

describe('code exchange for MCP (dynamic) clients', () => {
  it('issues a 1 h access token and a refresh token, storing only their hashes', async () => {
    const repo = repoWith();
    const res: any = await service(repo).exchangeCodeForToken('code', 'pca_dyn', undefined, 'v', undefined, RESOURCE);
    expect(res).toMatchObject({ id: 'o1', cus: 'cus_1', token_type: 'bearer', expires_in: 3600 });
    expect(res.access_token).toMatch(/^pos_/);
    expect(res.refresh_token).toMatch(/^posr_/);
    const stored = repo.issueTokens.mock.calls[0][0];
    expect(stored.access.hash).toBe(sha(res.access_token));
    expect(stored.refresh.hash).toBe(sha(res.refresh_token));
    expect(JSON.stringify(stored)).not.toContain(res.access_token);
    expect(stored.resource).toBe(RESOURCE);
  });

  it('exchanges a code exactly once (a lost race is invalid_grant, no tokens)', async () => {
    const repo = repoWith({ consumeCode: jest.fn(async () => false) });
    expect(await errorOf(service(repo).exchangeCodeForToken('code', 'pca_dyn'))).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant' },
    });
    expect(repo.issueTokens).not.toHaveBeenCalled();
  });

  it('refuses a resource that is not one of our MCP resources (invalid_target)', async () => {
    const repo = repoWith();
    expect(
      await errorOf(service(repo).exchangeCodeForToken('code', 'pca_dyn', undefined, 'v', undefined, 'https://evil.example/mcp'))
    ).toMatchObject({ body: { error: 'invalid_target' } });
    expect(repo.consumeCode).not.toHaveBeenCalled();
  });

  it('re-consent revokes every token issued on the grant before', async () => {
    const repo = repoWith();
    await service(repo).createAuthorizationCode('app1', 'u1', 'o1');
    expect(repo.revokeTokensOfAuthorization).toHaveBeenCalledWith('auth1');
  });
});

describe('refresh rotation for MCP clients', () => {
  const refreshRow = (over: any = {}) => ({
    id: 'tok-r',
    kind: 'refresh',
    familyId: 'fam1',
    scope: 'mcp:read mcp:write',
    resource: RESOURCE,
    expiresAt: new Date(Date.now() + 86_400_000),
    usedAt: null,
    revokedAt: null,
    authorization: grant,
    ...over,
  });

  it('rotates: a new pair in the same family, old token marked used in one transaction', async () => {
    const repo = repoWith({ findTokenByHash: jest.fn(async () => refreshRow()) });
    const res: any = await service(repo).refreshAccessToken('pca_dyn', 'posr_old');
    expect(repo.rotateRefresh).toHaveBeenCalledWith('tok-r', expect.objectContaining({ familyId: 'fam1' }));
    expect(res.refresh_token).toMatch(/^posr_/);
    expect(res.scope).toBe('mcp:read mcp:write');
  });

  it('a second refresh within the grace window gets one pair, atomically (one client double-sending)', async () => {
    const repo = repoWith({
      findTokenByHash: jest.fn(async () => refreshRow({ usedAt: new Date(Date.now() - 5_000) })),
      // already used, so the normal rotation can't take it
      rotateRefresh: jest.fn(async () => false),
    });
    const res: any = await service(repo).refreshAccessToken('pca_dyn', 'posr_old');
    expect(res.access_token).toMatch(/^pos_/);
    expect(repo.graceReissue).toHaveBeenCalledWith('tok-r', expect.any(Date), expect.objectContaining({ familyId: 'fam1' }));
    expect(repo.issueTokens).not.toHaveBeenCalled();
    expect(repo.revokeFamilyAndGrant).not.toHaveBeenCalled();
  });

  it('no late pair when a revoke or re-consent landed meanwhile, or the grace pair was already taken', async () => {
    const repo = repoWith({
      findTokenByHash: jest.fn(async () => refreshRow({ usedAt: new Date(Date.now() - 5_000) })),
      rotateRefresh: jest.fn(async () => false),
      graceReissue: jest.fn(async () => false),
    });
    expect(await errorOf(service(repo).refreshAccessToken('pca_dyn', 'posr_old'))).toMatchObject({
      body: { error: 'invalid_grant' },
    });
    expect(repo.issueTokens).not.toHaveBeenCalled();
  });

  it('a replay after the grace window revokes the family and the grant', async () => {
    const repo = repoWith({
      findTokenByHash: jest.fn(async () => refreshRow({ usedAt: new Date(Date.now() - 120_000) })),
    });
    expect(await errorOf(service(repo).refreshAccessToken('pca_dyn', 'posr_old'))).toMatchObject({
      body: { error: 'invalid_grant' },
    });
    expect(repo.revokeFamilyAndGrant).toHaveBeenCalledWith('fam1', 'auth1');
  });

  it.each([
    ['an expired refresh token', { expiresAt: new Date(Date.now() - 1) }],
    ['a revoked token', { revokedAt: new Date() }],
    ['a revoked grant', { authorization: { ...grant, revokedAt: new Date() } }],
    ['another app', { authorization: { ...grant, oauthAppId: 'other' } }],
    ['an access token used as refresh', { kind: 'access' }],
  ])('refuses %s', async (_name, over) => {
    const repo = repoWith({ findTokenByHash: jest.fn(async () => refreshRow(over)) });
    expect(await errorOf(service(repo).refreshAccessToken('pca_dyn', 'posr_old'))).toMatchObject({
      body: { error: 'invalid_grant' },
    });
  });

  it('refuses once the user is no longer an active member', async () => {
    const repo = repoWith({
      findTokenByHash: jest.fn(async () => refreshRow()),
      isActiveMember: jest.fn(async () => false),
    });
    expect(await errorOf(service(repo).refreshAccessToken('pca_dyn', 'posr_old'))).toMatchObject({
      body: { error: 'invalid_grant' },
    });
  });

  it('can not switch the audience on refresh', async () => {
    const repo = repoWith({ findTokenByHash: jest.fn(async () => refreshRow()) });
    expect(
      await errorOf(
        service(repo).refreshAccessToken('pca_dyn', 'posr_old', undefined, 'https://postiz.example/mcp-oauth-claude')
      )
    ).toMatchObject({ body: { error: 'invalid_target' } });
  });

  it('a confidential MCP client must authenticate to refresh', async () => {
    const repo = repoWith({
      getAppByClientId: jest.fn(async () => ({
        ...dynamicPublic,
        tokenEndpointAuthMethod: 'client_secret_post',
        clientSecret: 'enc(secret)',
      })),
      findTokenByHash: jest.fn(async () => refreshRow()),
    });
    expect(await errorOf(service(repo).refreshAccessToken('pca_dyn', 'posr_old'))).toMatchObject({
      status: 401,
      body: { error: 'invalid_client' },
    });
    const ok: any = await service(repo).refreshAccessToken('pca_dyn', 'posr_old', 'secret');
    expect(ok.access_token).toMatch(/^pos_/);
  });

  it('moves a legacy long-lived token once onto a rotating family, then it stops', async () => {
    const repo = repoWith({ findByAccessToken: jest.fn(async () => ({ ...grant, id: 'auth1' })) });
    const res: any = await service(repo).refreshAccessToken('pca_dyn', 'pos_legacy');
    expect(res.refresh_token).toMatch(/^posr_/);
    expect(repo.issueTokens).toHaveBeenCalled();
    expect(repo.clearLegacyAccessToken).toHaveBeenCalledWith('auth1');
  });
});

describe('using a rotating access token', () => {
  const accessRow = (over: any = {}) => ({
    id: 'tok-a',
    kind: 'access',
    familyId: 'fam1',
    scope: 'mcp:read mcp:write',
    resource: RESOURCE,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    revokedAt: null,
    authorization: grant,
    ...over,
  });

  it('works on the MCP resource it is bound to', async () => {
    const repo = repoWith({ findTokenByHash: jest.fn(async () => accessRow()) });
    expect(await service(repo).getOrgByOAuthToken('pos_x', RESOURCE)).toBe(grant);
  });

  it('is refused elsewhere: another MCP path, /api/mcp or the public API (audience)', async () => {
    const repo = repoWith({ findTokenByHash: jest.fn(async () => accessRow()) });
    expect(await service(repo).getOrgByOAuthToken('pos_x', 'https://postiz.example/mcp-oauth-claude')).toBeNull();
    expect(await service(repo).getOrgByOAuthToken('pos_x')).toBeNull();
  });

  it('an unbound token (the client sent no resource) works like before', async () => {
    const repo = repoWith({ findTokenByHash: jest.fn(async () => accessRow({ resource: null })) });
    expect(await service(repo).getOrgByOAuthToken('pos_x')).toBe(grant);
  });

  it.each([
    ['expired', { expiresAt: new Date(Date.now() - 1) }],
    ['revoked', { revokedAt: new Date() }],
    ['on a revoked grant', { authorization: { ...grant, revokedAt: new Date() } }],
    ['a refresh token used as access', { kind: 'refresh' }],
  ])('is refused when %s', async (_name, over) => {
    const repo = repoWith({ findTokenByHash: jest.fn(async () => accessRow(over)) });
    expect(await service(repo).getOrgByOAuthToken('pos_x', RESOURCE)).toBeNull();
  });

  it('falls back to a legacy token when the hash is unknown', async () => {
    const legacy = { ...grant, id: 'auth-legacy' };
    const repo = repoWith({ findByAccessToken: jest.fn(async () => legacy) });
    expect(await service(repo).getOrgByOAuthToken('pos_old')).toBe(legacy);
  });
});
