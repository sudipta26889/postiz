import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { OAuthRepository } from '@gitroom/nestjs-libraries/database/prisma/oauth/oauth.repository';
import { CreateOAuthAppDto } from '@gitroom/nestjs-libraries/dtos/oauth/create-oauth-app.dto';
import { UpdateOAuthAppDto } from '@gitroom/nestjs-libraries/dtos/oauth/update-oauth-app.dto';
import { RegisterClientDto } from '@gitroom/nestjs-libraries/dtos/oauth/register-client.dto';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { extractBearerToken } from '@gitroom/nestjs-libraries/chat/oauth-types';
import { createHash, timingSafeEqual } from 'crypto';
import { ssrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { OAuthApp } from '@prisma/client';
import type { SelfHostedInstance } from '@gitroom/nestjs-libraries/chat/mcp.relay.service';

const openAiOAuthClientId = () =>
  process.env.OPENAI_OAUTH_CLIENT_ID?.trim();

const enableOidcEmailClaims = () => Boolean(openAiOAuthClientId());

// The static app HubSpot agents connect with (created under Settings >
// Developers). HubSpot's MCP connector sends no client secret and requires a
// refresh token, see isPublicClient and refreshFields
const hubspotOAuthClientId = () =>
  process.env.HUBSPOT_OAUTH_CLIENT_ID?.trim();

// Postiz access tokens never expire, but HubSpot wants an expires_in: ten
// years (a hundred would not fit in a 32-bit integer)
const hubspotTokenExpiresIn = 10 * 365 * 24 * 60 * 60;

// MCP (dynamically registered) clients: short-lived access tokens and
// rotating refresh tokens, stored only as sha256 (design: mcp-oauth.md, H2)
const accessTokenTtlMs = 60 * 60 * 1000;
const refreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000;
// two refreshes sent together by one client: the second one within this
// window gets a new pair instead of being treated as a stolen-token replay
const refreshGraceMs = 30 * 1000;
// A registered redirect matches exactly, except that a loopback http
// callback may use any port (RFC 8252 §7.3): native clients such as Claude
// Code register http://localhost/callback and listen on a random port
const isLoopbackHttp = (url: URL) =>
  url.protocol === 'http:' &&
  ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const redirectAllowed = (registered: string[], requested: string) => {
  if (registered.includes(requested)) {
    return true;
  }
  let asked: URL;
  try {
    asked = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(asked)) {
    return false;
  }
  return registered.some((uri) => {
    try {
      const known = new URL(uri);
      return (
        isLoopbackHttp(known) &&
        known.hostname === asked.hostname &&
        known.pathname === asked.pathname &&
        known.search === asked.search
      );
    } catch {
      return false;
    }
  });
};

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

// The MCP resources a token may be bound to (RFC 8707), exactly as the
// protected-resource metadata advertises them (start.mcp.ts)
const canonicalMcpResources = () =>
  ['/mcp-oauth-dynamic', '/mcp-oauth-claude', '/mcp-oauth-chatgpt', '/mcp-oauth'].map(
    (path) => new URL(path, process.env.NEXT_PUBLIC_BACKEND_URL).toString()
  );
const sameResource = (a: string, b: string) =>
  a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

// The HubSpot app itself (HubSpot project > app > Auth tab), not the Postiz
// app above: its redirect URL finishes the install, see completeHubspotInstall
const hubspotAppClientId = () => process.env.HUBSPOT_APP_CLIENT_ID?.trim();
const hubspotAppClientSecret = () =>
  process.env.HUBSPOT_APP_CLIENT_SECRET?.trim();
const hubspotInstallRedirectUri = () =>
  `${process.env.NEXT_PUBLIC_BACKEND_URL}/oauth/hubspot/callback`;

// The link that installs the HubSpot app in a HubSpot account (listed in
// Settings > Integrations), undefined when the install can't be completed here
export const hubspotInstallUrl = () => {
  const clientId = hubspotAppClientId();
  if (!clientId || !hubspotAppClientSecret()) {
    return undefined;
  }

  const url = new URL('https://app.hubspot.com/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', hubspotInstallRedirectUri());
  url.searchParams.set('scope', 'oauth');
  return url.toString();
};

// Postiz Cloud only, a self-hosted install has nothing to relay to
export const selfHostedRelayEnabled = () =>
  process.env.MCP_SELF_HOSTED_RELAY === 'true';

// Verified-domain match: exact host or a subdomain of it (spoof-safe, the
// leading dot means evilclaude.ai and claude.ai.evil.com are both rejected)
const isVerifiedHost = (host: string, verifiedDomains: string[]) =>
  verifiedDomains.some(
    (domain) => host === domain || host.endsWith('.' + domain)
  );

type EmailClaimsApp = Pick<OAuthApp, 'clientId' | 'dynamic' | 'redirectUris'>;

// Schemes a browser would execute instead of navigating away from the
// consent screen, so they can never be a redirect_uri
const browserSchemes = [
  'javascript:',
  'data:',
  'blob:',
  'file:',
  'vbscript:',
  'about:',
];

@Injectable()
export class OAuthService {
  constructor(private _oauthRepository: OAuthRepository) {}

  async getApp(orgId: string) {
    const app = await this._oauthRepository.getAppByOrgId(orgId);
    if (!app) return false;
    const { clientSecret, ...rest } = app;
    return rest;
  }

  async createApp(orgId: string, dto: CreateOAuthAppDto) {
    const existing = await this._oauthRepository.getAppByOrgId(orgId);
    if (existing) {
      throw new HttpException(
        'You can only have one OAuth application per organization',
        HttpStatus.BAD_REQUEST
      );
    }

    const clientId = 'pca_' + makeSecureId(32);
    const clientSecret = 'pcs_' + makeSecureId(48);
    const encryptedSecret = AuthService.fixedEncryption(clientSecret);

    const app = await this._oauthRepository.createApp(orgId, {
      name: dto.name,
      description: dto.description,
      pictureId: dto.pictureId,
      redirectUrl: dto.redirectUrl,
      clientId,
      clientSecret: encryptedSecret,
    });

    return { ...app, clientSecret };
  }

  async updateApp(orgId: string, dto: UpdateOAuthAppDto) {
    return this._oauthRepository.updateApp(orgId, {
      ...(dto.name && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.pictureId !== undefined && { pictureId: dto.pictureId }),
      ...(dto.redirectUrl && { redirectUrl: dto.redirectUrl }),
    });
  }

  async deleteApp(orgId: string) {
    const app = await this._oauthRepository.getAppByOrgId(orgId);
    if (!app) {
      throw new HttpException('No OAuth app found', HttpStatus.NOT_FOUND);
    }
    await this._oauthRepository.revokeAllForApp(app.id);
    await this._oauthRepository.deleteApp(orgId);
    return { success: true };
  }

  async rotateSecret(orgId: string) {
    const app = await this._oauthRepository.getAppByOrgId(orgId);
    if (!app) {
      throw new HttpException('No OAuth app found', HttpStatus.NOT_FOUND);
    }

    const newSecret = 'pcs_' + makeSecureId(48);
    const encrypted = AuthService.fixedEncryption(newSecret);
    await this._oauthRepository.updateClientSecret(orgId, encrypted);
    return { clientSecret: newSecret };
  }

  // Domains allowed to receive DCR redirect_uris, from the
  // DCR_VERIFIED_DOMAINS env (comma separated). An empty list
  // means open registration (self-hosted default)
  private verifiedDomainList() {
    return (process.env.DCR_VERIFIED_DOMAINS || '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean);
  }

  // The redirect rules every registration follows (DCR and CIMD): https,
  // loopback http, or a private-use scheme; web hosts held to the verified
  // domain list when one is set
  private assertRedirectUris(redirectUris: string[]) {
    const verifiedDomains = this.verifiedDomainList();
    for (const uri of redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new HttpException(
          { error: 'invalid_redirect_uri', error_description: `Invalid redirect_uri: ${uri}` },
          HttpStatus.BAD_REQUEST
        );
      }

      // The consent screen navigates to the redirect_uri, so schemes the
      // browser would execute in our origin can never be a callback
      if (browserSchemes.includes(parsed.protocol)) {
        throw new HttpException(
          { error: 'invalid_redirect_uri', error_description: `redirect_uri scheme "${parsed.protocol}" is not allowed` },
          HttpStatus.BAD_REQUEST
        );
      }

      const isLoopback =
        parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      // Private-use schemes (RFC 8252 §7.1), e.g.
      // cursor://anysphere.cursor-mcp/oauth/callback
      const isPrivateScheme = !['http:', 'https:'].includes(parsed.protocol);
      if (parsed.protocol === 'http:' && !isLoopback) {
        throw new HttpException(
          { error: 'invalid_redirect_uri', error_description: 'redirect_uris must use https or a private-use scheme (http is allowed for loopback only)' },
          HttpStatus.BAD_REQUEST
        );
      }

      // Loopback and private-use callbacks never leave the user's machine
      // (native clients like Cursor, Grok and Claude Code), so only web
      // callbacks are held to the verified domain list
      if (isLoopback || isPrivateScheme || !verifiedDomains.length) {
        continue;
      }

      const host = parsed.hostname.toLowerCase();
      if (!isVerifiedHost(host, verifiedDomains)) {
        throw new HttpException(
          {
            error: 'invalid_redirect_uri',
            error_description: `redirect_uri host "${host}" is not a verified domain`,
          },
          HttpStatus.BAD_REQUEST
        );
      }
    }

  }

  // CIMD (client ID metadata document): a client_id that is an https URL is
  // the address of the client's own metadata. It is fetched safely (https,
  // public addresses only, no redirects, 5 s, 64 KB), must name itself, and
  // becomes a public dynamic client; everything after that is the normal flow
  private async clientFromMetadataDocument(clientId: string) {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return null;
    }
    if (
      url.protocol !== 'https:' ||
      url.pathname === '/' ||
      url.hash ||
      url.username ||
      url.password ||
      !(await isSafePublicHttpsUrl(clientId))
    ) {
      return null;
    }

    // first sight of unknown clients creates rows: prune the abandoned ones
    this._oauthRepository
      .deleteStaleDynamicApps(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
      .catch(() => {});

    let doc: any;
    try {
      const res = await fetch(clientId, {
        dispatcher: ssrfSafeDispatcher,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      } as any);
      if (
        !res.ok ||
        !res.body ||
        Number(res.headers.get('content-length') || 0) > 65536
      ) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      // the cap holds while reading, whatever the server declares (chunked)
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > 65536) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
      doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    }

    const refuse = (description: string) => {
      throw new HttpException(
        { error: 'invalid_client', error_description: description },
        HttpStatus.BAD_REQUEST
      );
    };
    if (doc?.client_id !== clientId) {
      refuse('client_id in the metadata document must equal its URL');
    }
    if (
      doc.token_endpoint_auth_method &&
      doc.token_endpoint_auth_method !== 'none'
    ) {
      refuse('a metadata-document client must be public (no client secret)');
    }
    const redirectUris: string[] = (
      Array.isArray(doc.redirect_uris) ? doc.redirect_uris : []
    )
      .filter((uri: unknown): uri is string => typeof uri === 'string')
      .map((uri: string) => uri.trim())
      .filter(Boolean);
    if (!redirectUris.length) {
      refuse('the metadata document lists no redirect_uris');
    }
    this.assertRedirectUris(redirectUris);

    try {
      await this._oauthRepository.createDynamicApp({
        name:
          (typeof doc.client_name === 'string' && doc.client_name.trim().slice(0, 100)) ||
          url.hostname,
        redirectUrl: redirectUris[0],
        redirectUris: JSON.stringify(redirectUris),
        clientId,
        tokenEndpointAuthMethod: 'none',
      });
    } catch {
      // two first requests at once: the other one created it
    }
    // read back like any client (same shape, picture included)
    return this._oauthRepository.getAppByClientId(clientId);
  }

  // A known client, or a metadata-document client seen for the first time
  private async appByClientId(clientId: string) {
    return (
      (await this._oauthRepository.getAppByClientId(clientId)) ||
      (await this.clientFromMetadataDocument(clientId))
    );
  }

  async registerDynamicClient(dto: RegisterClientDto) {
    const redirectUris = dto.redirect_uris.map((uri) => uri.trim());
    this.assertRedirectUris(redirectUris);

    if (dto.grant_types?.length && !dto.grant_types.includes('authorization_code')) {
      throw new HttpException(
        { error: 'invalid_client_metadata', error_description: 'Only the authorization_code grant type is supported' },
        HttpStatus.BAD_REQUEST
      );
    }

    // Registration happens before consent, so abandoned flows leave orphan
    // clients behind; opportunistically prune the ones nobody ever authorized
    this._oauthRepository
      .deleteStaleDynamicApps(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
      .catch(() => {});

    const isPublicClient = dto.token_endpoint_auth_method === 'none';
    // The token endpoint accepts the secret from either place; the stored
    // method only mirrors back what the client asked for
    const tokenEndpointAuthMethod = isPublicClient
      ? 'none'
      : dto.token_endpoint_auth_method === 'client_secret_basic'
      ? 'client_secret_basic'
      : 'client_secret_post';
    const clientId = 'pcd_' + makeSecureId(32);
    const clientSecret = isPublicClient ? undefined : 'pcs_' + makeSecureId(48);

    const app = await this._oauthRepository.createDynamicApp({
      name: dto.client_name?.trim().slice(0, 100) || 'MCP Client',
      redirectUrl: redirectUris[0],
      redirectUris: JSON.stringify(redirectUris),
      clientId,
      clientSecret: clientSecret && AuthService.fixedEncryption(clientSecret),
      tokenEndpointAuthMethod,
    });

    return {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(app.createdAt.getTime() / 1000),
      client_name: app.name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp:read mcp:write',
    };
  }

  // Email claims (openid/email scope + userinfo) go to the static ChatGPT app
  // and to dynamically registered clients whose web callbacks all live on a
  // verified domain (DCR_VERIFIED_DOMAINS). Everything else, including every
  // dynamic client on a self-hosted install with no verified domains, only
  // gets the mcp scopes
  private allowsEmailClaims(app: EmailClaimsApp) {
    if (!enableOidcEmailClaims()) {
      return false;
    }
    if (app.clientId === openAiOAuthClientId()) {
      return true;
    }
    if (!app.dynamic) {
      return false;
    }

    const verifiedDomains = this.verifiedDomainList();
    if (!verifiedDomains.length) {
      return false;
    }

    const webHosts: string[] = [];
    for (const uri of JSON.parse(app.redirectUris || '[]') as string[]) {
      try {
        const parsed = new URL(uri);
        if (parsed.protocol === 'https:') {
          webHosts.push(parsed.hostname.toLowerCase());
        }
      } catch {
        return false;
      }
    }

    return (
      webHosts.length > 0 &&
      webHosts.every((host) => isVerifiedHost(host, verifiedDomains))
    );
  }

  private grantedScope(app: EmailClaimsApp) {
    return [
      ...(this.allowsEmailClaims(app) ? ['openid', 'email'] : []),
      'mcp:read',
      'mcp:write',
    ].join(' ');
  }

  // Only MCP connections can be relayed to an instance: dynamically registered
  // clients (registration is only advertised to MCP clients), the ChatGPT app,
  // or a client asking for one of the /mcp-oauth resources (RFC 8707). Apps
  // that use Postiz OAuth for the public API never get the option, a relayed
  // token doesn't work there
  allowsSelfHosted(
    app: Pick<OAuthApp, 'clientId' | 'dynamic'>,
    resource?: string
  ) {
    if (!selfHostedRelayEnabled()) {
      return false;
    }
    if (app.dynamic || app.clientId === openAiOAuthClientId()) {
      return true;
    }
    try {
      return !!resource && new URL(resource).pathname.startsWith('/mcp-oauth');
    } catch {
      return false;
    }
  }

  // The ChatGPT app reads the email from userinfo; a self-hosted connection
  // has no cloud user to take it from, so the consent screen asks for one
  selfHostedRequiresEmail(app: Pick<OAuthApp, 'clientId'>) {
    return enableOidcEmailClaims() && app.clientId === openAiOAuthClientId();
  }

  // On top of validateAuthorizationRequest, for a self-hosted connection
  validateSelfHostedRequest(
    app: Pick<OAuthApp, 'clientId' | 'dynamic'>,
    options: { resource?: string; email?: string }
  ) {
    if (!this.allowsSelfHosted(app, options.resource)) {
      throw new HttpException(
        'This application can not connect to a self-hosted instance',
        HttpStatus.BAD_REQUEST
      );
    }

    if (!options.email && this.selfHostedRequiresEmail(app)) {
      throw new HttpException(
        'Enter your email address',
        HttpStatus.BAD_REQUEST
      );
    }
  }

  async validateAuthorizationRequest(
    clientId: string,
    options?: {
      redirectUri?: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
    }
  ) {
    const app = await this.appByClientId(clientId);
    if (!app) {
      throw new HttpException('Invalid client_id', HttpStatus.BAD_REQUEST);
    }

    // Dynamically registered clients must use their registered redirect_uris
    // and PKCE; statically registered apps keep the existing lenient flow,
    // except a public one (HubSpot), which has no secret and needs PKCE too
    if (app.dynamic) {
      const registered: string[] = JSON.parse(app.redirectUris || '[]');
      if (!options?.redirectUri || !redirectAllowed(registered, options.redirectUri)) {
        throw new HttpException('Invalid redirect_uri', HttpStatus.BAD_REQUEST);
      }
    }

    // Every MCP client (dynamic registration) and every public client must
    // use PKCE with S256 (OAuth 2.1, MCP auth spec): a confidential dynamic
    // client is no exception, and a missing method means "plain" (RFC 7636)
    const isPublicClient = this.isPublicClient(app);
    if (app.dynamic || isPublicClient) {
      if (!options?.codeChallenge) {
        throw new HttpException(
          'code_challenge is required for this client',
          HttpStatus.BAD_REQUEST
        );
      }
      if (options.codeChallengeMethod !== 'S256') {
        throw new HttpException(
          'Only the S256 code_challenge_method is supported',
          HttpStatus.BAD_REQUEST
        );
      }
    }

    return app;
  }

  // Clients that authenticate with PKCE instead of a client secret: dynamic
  // registrations with token_endpoint_auth_method=none, and HubSpot, whose
  // MCP connector only takes a client id
  private isPublicClient(
    app: Pick<OAuthApp, 'clientId' | 'dynamic' | 'tokenEndpointAuthMethod'>
  ) {
    return (
      (app.dynamic && app.tokenEndpointAuthMethod === 'none') ||
      app.clientId === hubspotOAuthClientId()
    );
  }

  // What an authorization code is bound to: a dynamic client's PKCE challenge
  // and redirect_uri, a public static app's PKCE challenge only (static apps
  // always redirect to their stored redirectUrl). Other static apps keep the
  // lenient flow and bind nothing
  pkceBinding(
    app: Pick<OAuthApp, 'clientId' | 'dynamic' | 'tokenEndpointAuthMethod'>,
    request: {
      codeChallenge?: string;
      codeChallengeMethod?: string;
      redirectUri?: string;
    }
  ) {
    if (app.dynamic) {
      return request;
    }
    if (this.isPublicClient(app)) {
      return {
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: request.codeChallengeMethod,
      };
    }
    return undefined;
  }

  async createAuthorizationCode(
    oauthAppId: string,
    userId: string,
    organizationId: string,
    pkce?: {
      codeChallenge?: string;
      codeChallengeMethod?: string;
      redirectUri?: string;
    }
  ) {
    const code = makeSecureId(32);
    const encryptedCode = AuthService.fixedEncryption(code);
    const codeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const authorization = await this._oauthRepository.createAuthorization({
      oauthAppId,
      userId,
      organizationId,
      authorizationCode: encryptedCode,
      codeExpiresAt,
      codeChallenge: pkce?.codeChallenge,
      codeChallengeMethod: pkce?.codeChallengeMethod,
      redirectUri: pkce?.redirectUri,
    });
    // re-consent re-opens the grant: every token issued before it ends
    await this._oauthRepository.revokeTokensOfAuthorization(authorization.id);

    return code;
  }

  async createSelfHostedAuthorizationCode(
    oauthAppId: string,
    instance: SelfHostedInstance & { email?: string },
    pkce?: {
      codeChallenge?: string;
      codeChallengeMethod?: string;
      redirectUri?: string;
    }
  ) {
    this._oauthRepository
      .deleteAbandonedSelfHostedAuthorizations(
        new Date(Date.now() - 24 * 60 * 60 * 1000)
      )
      .catch(() => {});

    // The prefix sends the code to the self-hosted table at the token
    // endpoint (regular codes use the same alphabet, without an underscore)
    const code = 'psc_' + makeSecureId(32);

    await this._oauthRepository.createSelfHostedAuthorization({
      oauthAppId,
      mcpUrl: instance.mcpUrl,
      apiKey: AuthService.fixedEncryption(instance.apiKey),
      email: instance.email,
      authorizationCode: AuthService.fixedEncryption(code),
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      codeChallenge: pkce?.codeChallenge,
      codeChallengeMethod: pkce?.codeChallengeMethod,
      redirectUri: pkce?.redirectUri,
    });

    return code;
  }

  async exchangeCodeForToken(
    code: string,
    clientId: string,
    clientSecret?: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: string
  ) {
    const app = await this._oauthRepository.getAppByClientId(clientId);
    if (!app) {
      throw new HttpException(
        { error: 'invalid_client' },
        HttpStatus.UNAUTHORIZED
      );
    }

    if (!this.isPublicClient(app)) {
      if (
        !this.secretMatches(app, clientSecret)
      ) {
        throw new HttpException(
          { error: 'invalid_client' },
          HttpStatus.UNAUTHORIZED
        );
      }
    }

    if (code.startsWith('psc_')) {
      return this.exchangeSelfHostedCodeForToken(
        app,
        code,
        codeVerifier,
        redirectUri
      );
    }

    const encryptedCode = AuthService.fixedEncryption(code);
    const auth = await this._oauthRepository.findByCode(encryptedCode);
    if (!auth || auth.oauthAppId !== app.id) {
      throw new HttpException(
        { error: 'invalid_grant' },
        HttpStatus.BAD_REQUEST
      );
    }

    this.verifyCodeGrant(auth, codeVerifier, redirectUri);

    // MCP clients get short-lived, hashed, rotating tokens; the code can be
    // exchanged exactly once (a conditional update, safe under races)
    if (app.dynamic) {
      const boundTo = this.checkResource(resource);
      if (!(await this._oauthRepository.consumeCode(auth.id, encryptedCode))) {
        throw new HttpException(
          { error: 'invalid_grant' },
          HttpStatus.BAD_REQUEST
        );
      }
      const { tokens, response } = this.issueTokenFamily(
        auth.id,
        this.grantedScope(app),
        boundTo
      );
      await this._oauthRepository.issueTokens(tokens);
      // long-expired tokens go, opportunistically (like stale apps)
      this._oauthRepository
        .pruneExpiredTokens(new Date(Date.now() - refreshTokenTtlMs))
        .catch(() => {});
      return {
        id: auth.organizationId,
        cus: auth.organization?.paymentId,
        ...response,
      };
    }

    const token = 'pos_' + makeSecureId(40);
    const encryptedToken = AuthService.fixedEncryption(token);
    const {
      organizationId,
      organization: { paymentId },
    } = await this._oauthRepository.exchangeCodeForToken(
      auth.id,
      encryptedToken
    );

    return {
      id: organizationId,
      cus: paymentId,
      access_token: token,
      token_type: 'bearer',
      scope: this.grantedScope(app),
      ...this.refreshFields(app, token),
    };
  }

  // Expiry, PKCE and redirect_uri checks of an authorization code, shared by
  // cloud and self-hosted authorizations
  private verifyCodeGrant(
    auth: {
      codeExpiresAt: Date | null;
      codeChallenge: string | null;
      redirectUri: string | null;
    },
    codeVerifier?: string,
    redirectUri?: string
  ) {
    if (!auth.codeExpiresAt || new Date() > auth.codeExpiresAt) {
      throw new HttpException(
        { error: 'invalid_grant', error_description: 'Code has expired' },
        HttpStatus.BAD_REQUEST
      );
    }

    if (auth.codeChallenge) {
      if (!codeVerifier) {
        throw new HttpException(
          { error: 'invalid_grant', error_description: 'code_verifier is required' },
          HttpStatus.BAD_REQUEST
        );
      }
      const hashed = createHash('sha256').update(codeVerifier).digest('base64url');
      if (hashed !== auth.codeChallenge) {
        throw new HttpException(
          { error: 'invalid_grant', error_description: 'Invalid code_verifier' },
          HttpStatus.BAD_REQUEST
        );
      }
    }

    if (auth.redirectUri && redirectUri !== auth.redirectUri) {
      throw new HttpException(
        { error: 'invalid_grant', error_description: 'redirect_uri does not match the authorization request' },
        HttpStatus.BAD_REQUEST
      );
    }
  }

  // A self-hosted connection has no organization (or payment) to return,
  // only the token
  private async exchangeSelfHostedCodeForToken(
    app: OAuthApp,
    code: string,
    codeVerifier?: string,
    redirectUri?: string
  ) {
    const auth = await this._oauthRepository.findSelfHostedByCode(
      AuthService.fixedEncryption(code)
    );
    if (!auth || auth.oauthAppId !== app.id) {
      throw new HttpException(
        { error: 'invalid_grant' },
        HttpStatus.BAD_REQUEST
      );
    }

    this.verifyCodeGrant(auth, codeVerifier, redirectUri);

    const token = 'psh_' + makeSecureId(40);
    await this._oauthRepository.exchangeSelfHostedCodeForToken(
      auth.id,
      AuthService.fixedEncryption(token)
    );

    return {
      access_token: token,
      token_type: 'bearer',
      scope: this.grantedScope(app),
      ...this.refreshFields(app, token),
    };
  }

  // HubSpot refuses a token response without a refresh token. Postiz access
  // tokens never expire, so the refresh token is the access token itself:
  // refreshing hands it back unchanged, and it stops working exactly when the
  // access token does. No other client gets these fields
  // A confidential client's secret, compared in constant time so the time
  // taken says nothing about how much of a guess was right
  private secretMatches(
    app: Pick<OAuthApp, 'clientSecret'>,
    clientSecret?: string
  ) {
    if (!clientSecret || !app.clientSecret) {
      return false;
    }
    const expected = Buffer.from(app.clientSecret);
    const given = Buffer.from(AuthService.fixedEncryption(clientSecret));
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private invalidGrant(): never {
    throw new HttpException({ error: 'invalid_grant' }, HttpStatus.BAD_REQUEST);
  }

  // Rotation for MCP clients (design H2): every refresh gives a new pair in
  // the same family; a refresh token used again after the grace window means
  // it leaked, so the family and the grant end
  private async refreshDynamic(
    app: OAuthApp,
    refreshToken?: string,
    clientSecret?: string,
    resource?: string
  ) {
    if (
      !this.isPublicClient(app) &&
      !this.secretMatches(app, clientSecret)
    ) {
      throw new HttpException(
        { error: 'invalid_client' },
        HttpStatus.UNAUTHORIZED
      );
    }
    if (!refreshToken) {
      throw new HttpException(
        { error: 'invalid_request', error_description: 'refresh_token is required' },
        HttpStatus.BAD_REQUEST
      );
    }

    const old = await this._oauthRepository.findTokenByHash(
      hashToken(refreshToken)
    );
    if (old) {
      const grant = old.authorization;
      // a refresh token already spent (rotated, or its one grace pair taken)
      // coming back means it leaked: its family ends
      if (old.kind === 'refresh' && old.revokedAt && old.usedAt) {
        await this._oauthRepository.revokeFamily(old.familyId);
        this.invalidGrant();
      }
      if (
        old.kind !== 'refresh' ||
        grant.oauthAppId !== app.id ||
        old.revokedAt ||
        grant.revokedAt ||
        old.expiresAt.getTime() <= Date.now() ||
        !(await this._oauthRepository.isActiveMember(
          grant.userId,
          grant.organizationId
        ))
      ) {
        this.invalidGrant();
      }
      // the audience can't be switched on refresh
      if (resource) {
        const asked = this.checkResource(resource);
        if (old.resource && !sameResource(old.resource, asked!)) {
          throw new HttpException(
            { error: 'invalid_target' },
            HttpStatus.BAD_REQUEST
          );
        }
      }
      // scopes are the token's own, minted from the grant (never widened)
      const { tokens, response } = this.issueTokenFamily(
        grant.id,
        old.scope,
        old.resource,
        old.familyId
      );
      const graceSince = new Date(Date.now() - refreshGraceMs);
      if (old.usedAt && old.usedAt < graceSince) {
        await this._oauthRepository.revokeFamilyAndGrant(old.familyId, grant.id);
        this.invalidGrant();
      }
      if (await this._oauthRepository.rotateRefresh(old.id, tokens)) {
        return response;
      }
      // used a moment ago (the same client refreshing twice at once): one
      // extra pair, atomically, and only if nothing revoked it meanwhile
      if (await this._oauthRepository.graceReissue(old.id, graceSince, tokens)) {
        return response;
      }
      this.invalidGrant();
    }

    // a long-lived token from before rotation: moved once onto a family,
    // then it stops working
    const legacy = await this._oauthRepository.findByAccessToken(
      AuthService.fixedEncryption(refreshToken)
    );
    if (
      !legacy ||
      legacy.oauthAppId !== app.id ||
      !(await this._oauthRepository.isActiveMember(
        legacy.userId,
        legacy.organizationId
      ))
    ) {
      this.invalidGrant();
    }
    const { tokens, response } = this.issueTokenFamily(
      legacy.id,
      this.grantedScope(app),
      resource ? this.checkResource(resource) : null
    );
    await this._oauthRepository.issueTokens(tokens);
    await this._oauthRepository.clearLegacyAccessToken(legacy.id);
    return response;
  }

  // RFC 7009: a client revokes one of its own tokens. The client
  // authenticates like at /token; whatever the token is (unknown, expired,
  // someone else's), the answer is the same 200, so nothing leaks. A rotating
  // token ends its family, a legacy long-lived one its grant
  async revokeToken(clientId?: string, clientSecret?: string, token?: string) {
    const app = clientId
      ? await this._oauthRepository.getAppByClientId(clientId)
      : null;
    if (
      !app ||
      (!this.isPublicClient(app) &&
        !this.secretMatches(app, clientSecret))
    ) {
      throw new HttpException(
        { error: 'invalid_client' },
        HttpStatus.UNAUTHORIZED
      );
    }
    if (!token) {
      return;
    }

    const rotating = await this._oauthRepository.findTokenByHash(
      hashToken(token)
    );
    if (rotating) {
      if (rotating.authorization.oauthAppId === app.id) {
        await this._oauthRepository.revokeFamily(rotating.familyId);
      }
      return;
    }

    const legacy = await this._oauthRepository.findByAccessToken(
      AuthService.fixedEncryption(token)
    );
    if (legacy && legacy.oauthAppId === app.id) {
      await this._oauthRepository.revokeAuthorizationById(legacy.id);
    }
  }

  // RFC 8707: a token is bound to the MCP resource it was asked for; any
  // other resource is invalid_target
  private checkResource(resource?: string) {
    if (!resource) {
      return null;
    }
    const match = canonicalMcpResources().find((r) => sameResource(r, resource));
    if (!match) {
      throw new HttpException(
        {
          error: 'invalid_target',
          error_description: 'resource is not an MCP resource of this server',
        },
        HttpStatus.BAD_REQUEST
      );
    }
    return match;
  }

  // A new pair of an access token (1 h) and a refresh token (30 d), in the
  // given family (a new one at code exchange, the same one on rotation)
  private issueTokenFamily(
    authorizationId: string,
    scope: string,
    resource: string | null,
    familyId: string = makeSecureId(24)
  ) {
    const access = 'pos_' + makeSecureId(40);
    const refresh = 'posr_' + makeSecureId(48);
    const tokens = {
      authorizationId,
      familyId,
      scope,
      resource,
      access: {
        hash: hashToken(access),
        expiresAt: new Date(Date.now() + accessTokenTtlMs),
      },
      refresh: {
        hash: hashToken(refresh),
        expiresAt: new Date(Date.now() + refreshTokenTtlMs),
      },
    };
    return {
      tokens,
      response: {
        access_token: access,
        token_type: 'bearer',
        expires_in: accessTokenTtlMs / 1000,
        refresh_token: refresh,
        scope,
      },
    };
  }

  private refreshFields(app: Pick<OAuthApp, 'clientId'>, token: string) {
    if (app.clientId !== hubspotOAuthClientId()) {
      return {};
    }

    return {
      refresh_token: token,
      expires_in: hubspotTokenExpiresIn,
    };
  }

  // The refresh_token grant. MCP (dynamic) clients rotate (refreshDynamic);
  // HubSpot keeps its static flow (see refreshFields): the refresh token is
  // looked up like an access token and handed back while it is valid
  async refreshAccessToken(
    clientId?: string,
    refreshToken?: string,
    clientSecret?: string,
    resource?: string
  ) {
    const caller = clientId
      ? await this._oauthRepository.getAppByClientId(clientId)
      : null;
    if (caller?.dynamic) {
      return this.refreshDynamic(caller, refreshToken, clientSecret, resource);
    }

    if (!clientId || clientId !== hubspotOAuthClientId()) {
      throw new HttpException(
        { error: 'unsupported_grant_type' },
        HttpStatus.BAD_REQUEST
      );
    }

    const app = await this._oauthRepository.getAppByClientId(clientId);
    if (!app) {
      throw new HttpException(
        { error: 'invalid_client' },
        HttpStatus.UNAUTHORIZED
      );
    }

    if (!refreshToken) {
      throw new HttpException(
        { error: 'invalid_request', error_description: 'refresh_token is required' },
        HttpStatus.BAD_REQUEST
      );
    }

    // a self-hosted connection only works while the relay is on
    const encryptedToken = AuthService.fixedEncryption(refreshToken);
    const authorization = refreshToken.startsWith('psh_')
      ? selfHostedRelayEnabled()
        ? await this._oauthRepository.findSelfHostedByAccessToken(encryptedToken)
        : null
      : await this._oauthRepository.findByAccessToken(encryptedToken);
    if (!authorization || authorization.oauthAppId !== app.id) {
      throw new HttpException(
        { error: 'invalid_grant' },
        HttpStatus.BAD_REQUEST
      );
    }

    return {
      access_token: refreshToken,
      token_type: 'bearer',
      scope: this.grantedScope(app),
      ...this.refreshFields(app, refreshToken),
    };
  }

  // HubSpot only counts an install of the HubSpot app once its code is
  // exchanged. Postiz makes no HubSpot API calls, so the tokens are not kept
  async completeHubspotInstall(code: string) {
    const clientId = hubspotAppClientId();
    const clientSecret = hubspotAppClientSecret();
    if (!clientId || !clientSecret) {
      throw new HttpException('Not found', HttpStatus.NOT_FOUND);
    }

    let response: Response;
    try {
      response = await fetch('https://api.hubapi.com/oauth/v3/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: hubspotInstallRedirectUri(),
          code,
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      // timeout or network failure, fetch rejects instead of answering
      throw new HttpException(
        'Could not reach HubSpot to finish installing Postiz, please try again',
        HttpStatus.BAD_GATEWAY,
        { cause: err }
      );
    }

    if (!response.ok) {
      const value = await response.json().catch(() => null);
      throw new HttpException(
        `Could not finish installing Postiz in HubSpot${
          value?.message ? `: ${value.message}` : ''
        }`,
        HttpStatus.BAD_REQUEST
      );
    }

    await response.body?.cancel();
  }

  // null when the relay is off or the token is unknown or revoked
  async getSelfHostedByAccessToken(token: string) {
    if (!selfHostedRelayEnabled()) {
      return null;
    }

    const authorization =
      await this._oauthRepository.findSelfHostedByAccessToken(
        AuthService.fixedEncryption(token)
      );
    if (!authorization) {
      return null;
    }

    return {
      id: authorization.id,
      mcpUrl: authorization.mcpUrl,
      apiKey: AuthService.fixedDecryption(authorization.apiKey),
    };
  }

  deleteSelfHostedAuthorization(id: string) {
    return this._oauthRepository.deleteSelfHostedAuthorization(id);
  }

  // `resource` is where the token is being used (an MCP path), undefined for
  // the public API and /api/mcp. A token bound to a resource works only there
  async getOrgByOAuthToken(token: string, resource?: string) {
    const rotating = await this._oauthRepository.findTokenByHash(
      hashToken(token)
    );
    if (rotating) {
      const grant = rotating.authorization;
      if (
        rotating.kind !== 'access' ||
        rotating.revokedAt ||
        rotating.expiresAt.getTime() <= Date.now() ||
        grant.revokedAt ||
        (rotating.resource &&
          !(resource && sameResource(rotating.resource, resource))) ||
        !(await this._oauthRepository.isActiveMember(
          grant.userId,
          grant.organizationId
        ))
      ) {
        return null;
      }
      return grant;
    }

    const encrypted = AuthService.fixedEncryption(token);
    const authorization = await this._oauthRepository.findByAccessToken(
      encrypted
    );
    // re-checked on every use: removing someone from the organization cuts
    // off every OAuth client they connected
    if (
      !authorization ||
      !(await this._oauthRepository.isActiveMember(
        authorization.userId,
        authorization.organizationId
      ))
    ) {
      return null;
    }
    return authorization;
  }

  async getUserInfo(authorization?: string) {
    if (!enableOidcEmailClaims()) {
      throw new HttpException(
        {
          error: 'not_found',
          error_description: 'OIDC email claims are not enabled',
        },
        HttpStatus.NOT_FOUND
      );
    }

    const token = extractBearerToken(authorization);
    if (!token) {
      throw new HttpException(
        { error: 'invalid_token', error_description: 'Bearer token required' },
        HttpStatus.UNAUTHORIZED
      );
    }

    if (token.startsWith('psh_')) {
      return this.getSelfHostedUserInfo(token);
    }

    const authorizationRecord = await this.getOrgByOAuthToken(token);
    if (!authorizationRecord) {
      throw new HttpException(
        { error: 'invalid_token', error_description: 'Token is invalid or revoked' },
        HttpStatus.UNAUTHORIZED
      );
    }

    if (!this.allowsEmailClaims(authorizationRecord.oauthApp)) {
      throw new HttpException(
        {
          error: 'insufficient_scope',
          error_description:
            'This OAuth client is not authorized to access email claims',
        },
        HttpStatus.FORBIDDEN
      );
    }

    const { user } = authorizationRecord;
    return {
      sub: user.id,
      email: user.email,
      email_verified: user.activated,
    };
  }

  // A self-hosted connection has no cloud user: the subject is the connection
  // and the email is the one typed on the consent screen, which nobody verified
  private async getSelfHostedUserInfo(token: string) {
    const selfHosted = selfHostedRelayEnabled()
      ? await this._oauthRepository.findSelfHostedUserInfo(
          AuthService.fixedEncryption(token)
        )
      : null;
    if (!selfHosted) {
      throw new HttpException(
        { error: 'invalid_token', error_description: 'Token is invalid or revoked' },
        HttpStatus.UNAUTHORIZED
      );
    }

    if (!this.allowsEmailClaims(selfHosted.oauthApp)) {
      throw new HttpException(
        {
          error: 'insufficient_scope',
          error_description:
            'This OAuth client is not authorized to access email claims',
        },
        HttpStatus.FORBIDDEN
      );
    }

    return {
      sub: selfHosted.id,
      ...(selfHosted.email
        ? { email: selfHosted.email, email_verified: false }
        : {}),
    };
  }

  async getApprovedApps(userId: string) {
    return this._oauthRepository.getApprovedApps(userId);
  }

  async revokeApp(userId: string, authId: string) {
    const { count } = await this._oauthRepository.revokeAuthorization(
      userId,
      authId
    );
    // its rotating tokens end with it
    if (count) {
      await this._oauthRepository.revokeTokensOfAuthorization(authId);
    }
    return { success: true, revoked: count > 0 };
  }

  getOrganizationConnections(organizationId: string) {
    return this._oauthRepository.getOrganizationConnections(organizationId);
  }

  async revokeOrganizationConnection(organizationId: string, authId: string) {
    const { count } =
      await this._oauthRepository.revokeOrganizationConnection(
        organizationId,
        authId
      );
    if (count) {
      await this._oauthRepository.revokeTokensOfAuthorization(authId);
    }
    return { success: true, revoked: count > 0 };
  }

}
