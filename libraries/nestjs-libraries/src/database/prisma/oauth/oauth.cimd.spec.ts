import 'reflect-metadata';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.repository',
  () => ({ OAuthRepository: class {} })
);
jest.mock('@gitroom/helpers/auth/auth.service', () => ({
  AuthService: { fixedEncryption: (v: string) => `enc(${v})` },
}));
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher', () => ({
  ssrfSafeDispatcher: { safe: true },
}));
const isSafe = jest.fn(async (_url: string) => true);
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator', () => ({
  isSafePublicHttpsUrl: (url: string) => isSafe(url),
}));

import { OAuthService } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.service';

const CLIENT = 'https://client.example/oauth/client.json';
const doc = (over: any = {}) => ({
  client_id: CLIENT,
  client_name: 'Example MCP Client',
  redirect_uris: ['https://client.example/callback'],
  token_endpoint_auth_method: 'none',
  ...over,
});
const answer = (body: any, init: { status?: number; length?: number } = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (h: string) => (h === 'content-length' ? String(init.length ?? text.length) : null) },
    arrayBuffer: async () => Buffer.from(text),
  };
};

const created = {
  id: 'app-cimd',
  clientId: CLIENT,
  dynamic: true,
  tokenEndpointAuthMethod: 'none',
  redirectUris: JSON.stringify(['https://client.example/callback']),
  name: 'Example MCP Client',
};

const setup = (fetchAnswer: any) => {
  let stored: any = null;
  const repo = {
    getAppByClientId: jest.fn(async () => stored),
    createDynamicApp: jest.fn(async (data: any) => {
      stored = { ...created, ...data, dynamic: true };
      return stored;
    }),
  };
  const fetchMock = jest.fn(async () =>
    fetchAnswer instanceof Error ? Promise.reject(fetchAnswer) : fetchAnswer
  );
  (globalThis as any).fetch = fetchMock;
  return { svc: new OAuthService(repo as any), repo, fetchMock };
};

const authorize = (svc: OAuthService, clientId = CLIENT, redirectUri = 'https://client.example/callback') =>
  svc.validateAuthorizationRequest(clientId, {
    redirectUri,
    codeChallenge: 'abc',
    codeChallengeMethod: 'S256',
  });
const errorOf = async (p: Promise<any>) => {
  try {
    await p;
    return null;
  } catch (err: any) {
    return { status: err.getStatus(), body: err.getResponse() };
  }
};

beforeEach(() => isSafe.mockClear().mockResolvedValue(true));

describe('CIMD: a client_id that is the URL of its own metadata', () => {
  it('fetches it safely once and registers a public dynamic client', async () => {
    const { svc, repo, fetchMock } = setup(answer(doc()));
    const app: any = await authorize(svc);
    expect(app.clientId).toBe(CLIENT);
    expect(repo.createDynamicApp).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: CLIENT, tokenEndpointAuthMethod: 'none', name: 'Example MCP Client' })
    );
    const [, init] = (fetchMock.mock.calls[0] as any);
    expect(init).toMatchObject({ redirect: 'error', dispatcher: { safe: true } });

    // known from now on: no second fetch
    await authorize(svc);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never fetches an http:// client_id, or one on an unsafe address', async () => {
    const plain = setup(answer(doc()));
    expect(await errorOf(authorize(plain.svc, 'http://client.example/c.json'))).toMatchObject({ status: 400 });
    expect(plain.fetchMock).not.toHaveBeenCalled();

    isSafe.mockResolvedValue(false);
    const internal = setup(answer(doc()));
    expect(await errorOf(authorize(internal.svc, 'https://10.0.0.5/c.json'))).toMatchObject({ status: 400 });
    expect(internal.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a document that names another client_id', async () => {
    const { svc, repo } = setup(answer(doc({ client_id: 'https://other.example/c.json' })));
    expect(await errorOf(authorize(svc))).toMatchObject({ status: 400, body: { error: 'invalid_client' } });
    expect(repo.createDynamicApp).not.toHaveBeenCalled();
  });

  it('refuses a confidential (secret-based) document client', async () => {
    const { svc } = setup(answer(doc({ token_endpoint_auth_method: 'client_secret_post' })));
    expect(await errorOf(authorize(svc))).toMatchObject({ body: { error: 'invalid_client' } });
  });

  it('applies the same redirect rules as DCR', async () => {
    const { svc } = setup(answer(doc({ redirect_uris: ['http://client.example/callback'] })));
    expect(await errorOf(authorize(svc))).toMatchObject({ body: { error: 'invalid_redirect_uri' } });
  });

  it('refuses the redirect the document does not list (exact match)', async () => {
    const { svc } = setup(answer(doc()));
    expect(await errorOf(authorize(svc, CLIENT, 'https://client.example/elsewhere'))).toMatchObject({ status: 400 });
  });

  it('treats an oversize, non-JSON, failing or unreachable document as an unknown client', async () => {
    for (const bad of [
      answer(doc(), { length: 70_000 }),
      answer('not json'),
      answer(doc(), { status: 404 }),
      new Error('timeout'),
    ]) {
      const { svc, repo } = setup(bad);
      expect(await errorOf(authorize(svc))).toMatchObject({ status: 400 });
      expect(repo.createDynamicApp).not.toHaveBeenCalled();
    }
  });
});
