import { createOAuthMiddleware } from '@gitroom/nestjs-libraries/chat/oauth-middleware';

const fakeRes = () => {
  const res: any = { headers: {}, status: 0, body: '' };
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.status = status;
    res.headers = headers;
  };
  res.end = (body?: string) => {
    res.body = body ?? '';
  };
  return res;
};

const middleware = createOAuthMiddleware({
  oauth: {
    resource: 'https://postiz.example/mcp-oauth-dynamic',
    authorizationServers: ['https://postiz.example/mcp-oauth-dynamic'],
    scopesSupported: ['mcp:read', 'mcp:write'],
    validateToken: async () => ({
      valid: false,
      error: 'invalid_token',
      errorDescription: 'Invalid API Key or OAuth token',
    }),
  },
  mcpPath: '/mcp-oauth-dynamic',
});

const url = new URL('https://postiz.example/mcp-oauth-dynamic');

describe('401 challenge (MCP auth spec)', () => {
  it('names the resource metadata and the scopes when no token is sent', async () => {
    const res = fakeRes();
    await middleware({ method: 'POST', headers: {} } as any, res, url);
    expect(res.status).toBe(401);
    expect(res.headers['WWW-Authenticate']).toBe(
      'Bearer resource_metadata="https://postiz.example/.well-known/oauth-protected-resource/mcp-oauth-dynamic", scope="mcp:read mcp:write"'
    );
  });

  it('adds error="invalid_token" and keeps the scopes for a bad token', async () => {
    const res = fakeRes();
    await middleware(
      { method: 'POST', headers: { authorization: 'Bearer nope' } } as any,
      res,
      url
    );
    expect(res.status).toBe(401);
    expect(res.headers['WWW-Authenticate']).toContain('scope="mcp:read mcp:write"');
    expect(res.headers['WWW-Authenticate']).toContain('error="invalid_token"');
  });
});
