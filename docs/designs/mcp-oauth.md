# MCP OAuth for claude.ai and ChatGPT (fleet standard)

Status: revised after Goldfish review (design, codebase-details, zoom-out), 2026-11-16. Owner: Postiz lead.
Inputs: `~/fleet-tasks/studio-mcp-oauth-standard.md` (the standard) and
`~/fleet-tasks/postiz-to-guardian-mcp-oauth.md` (the audit, with a verdict and evidence for every item).

## Problem

Postiz ships a full OAuth 2.1 authorization server and four OAuth-protected MCP endpoints, inherited from upstream
gitroomhq (`libraries/nestjs-libraries/src/chat/start.mcp.ts`, `oauth-middleware.ts`,
`apps/backend/src/api/routes/oauth.controller.ts`, `.../prisma/oauth/oauth.service.ts`). None of it works from
claude.ai on our deployment:

- The container serves the backend under `/api/` and everything else from Next.js (`var/docker/nginx.conf:20,53`).
- The backend builds `resource_metadata`, `resource` and `issuer` as `new URL('/<path>', NEXT_PUBLIC_BACKEND_URL)`,
  which drops `/api` (`start.mcp.ts:207,212,254,321,379`). Token and register endpoints keep `/api` (`:232-235`).
- The root paths it advertises reach Next.js, which redirects them to `/auth` (live: 307). Discovery dies there.

Every self-hosted Postiz on the upstream image has the same nginx layout, so it has the same failure.

## Definition of done

1. `POST https://postiz.sudiptadhara.in/mcp-oauth-dynamic` with no token returns 401 with
   `WWW-Authenticate: Bearer resource_metadata="https://postiz.sudiptadhara.in/.well-known/oauth-protected-resource/mcp-oauth-dynamic"`.
2. That URL returns 200 JSON with `resource == https://postiz.sudiptadhara.in/mcp-oauth-dynamic`.
3. `https://postiz.sudiptadhara.in/.well-known/oauth-authorization-server/mcp-oauth-dynamic` returns 200 JSON,
   `issuer == https://postiz.sudiptadhara.in/mcp-oauth-dynamic`, with S256 and `none`.
4. The owner adds `https://postiz.sudiptadhara.in/mcp-oauth-dynamic` as a claude.ai custom connector, signs in, and
   a read-only tool (list channels) answers.
5. Key clients are unchanged: `/api/mcp` (Bearer key), `/api/mcp/<key>`, `/api/sse/<key>`, the public API, and the
   grihatek-postiz agent's normal flow. The root forms `/mcp/<key>` etc. work as well (needed by 6).
6. The Postiz settings and onboarding screens show `https://postiz.sudiptadhara.in/mcp-oauth-dynamic` and key URLs
   that work.
7. `http://` is redirected to `https://` before reaching the app, and the edge proxy doesn't intercept
   `/.well-known/*`.

## Design: Phase A, routing at the edge plus one env key (no app code)

The smallest change that meets all seven checks touches no upstream-owned file.

**1. Edge routes (Guardian's openresty in front of `:4007`).** Prefix rules that proxy to the container at
`/api` + the same path. The container's `location /api/` strips `/api` (`nginx.conf:20-21`), so the backend sees
exactly the path it mounts:

| Public path (prefix) | Proxied to | Why |
|---|---|---|
| `/.well-known/oauth-protected-resource/` (with trailing slash) | `:4007/api/.well-known/oauth-protected-resource/…` | PRM per MCP path (`start.mcp.ts:311`) |
| `/.well-known/oauth-authorization-server/` | `:4007/api/.well-known/oauth-authorization-server/…` | AS metadata per issuer (`:325`) |
| `/mcp-oauth` | `:4007/api/mcp-oauth…` | the four OAuth MCP endpoints (`:370`) |
| `/mcp` (exact) and `/mcp/` | `:4007/api/mcp…` | key URLs once `MCP_URL` is the origin |
| `/sse/`, `/message/` | `:4007/api/sse/…`, `/api/message/…` | legacy SSE key URLs, same reason |

- Use the same proxy settings openresty already uses for `/api`. Test before adding streaming tweaks: MCP runs
  `serverless: true` (`:401`) and listen streams close after 10 s (`:36`).
- The bare root `/.well-known/oauth-protected-resource` is **not** routed. Upstream deliberately doesn't answer it,
  so key-based `/mcp` isn't forced into OAuth (`:311-319`).
- `/.well-known/openid-configuration/` isn't routed: it's only served when `OPENAI_OAUTH_CLIENT_ID` is set
  (`:348`), and it isn't set here.
- Next.js owns none of these paths today. They all 307 to `/auth`, and the frontend has no `.well-known`, `mcp`,
  `sse` or `message` routes.
- In the same request: redirect HTTP → HTTPS, and confirm `/.well-known/*` passes through (no ACME intercept).

**2. `MCP_URL=https://postiz.sudiptadhara.in`.** This is upstream's existing setting
(`apps/frontend/src/app/(app)/layout.tsx:69`). The UI uses `mcpBase = mcpUrl || backendUrl`
(`public.component.tsx:761`, `onboarding.modal.tsx:310`) for both the OAuth URL (`:75`) and the key URLs
(`:100,106,268,335`). Add it to `soul/stack.yml`, `.env.example` (key set rule, `soul/README.md`), `.env`, and the
Portainer stack Env.
**Order matters: only after the edge routes are live.** Otherwise the UI shows key URLs that 307 to `/auth`.

Not needed: `NEXT_PUBLIC_OVERRIDE_BACKEND_URL` is unset in the stack, so the issuer and the token endpoint share
one base.

Known effect: clients pointed at `/api/mcp-oauth-*` keep a mismatched `resource` after this change. Discovery never
worked on those URLs, so no working client is affected.

Rejected alternative: the same routes in the container's `var/docker/nginx.conf`. That works for the LAN URL too, but
it's an upstream-owned file (a conflict on every sync) and it duplicates the edge. Keep it as an upstream PR idea
instead (owner's yes needed).

### Rollout and verification

1. Guardian adds the edge routes, the HTTPS redirect and the pass-through check (owner approves Guardian's change).
2. Curl checks 1, 2, 3 and 7, plus the key paths from check 5 at root and under `/api`. All read-only.
3. A PR on our repo adds `MCP_URL` to `soul/stack.yml` and `.env.example`; set the Portainer Env too. The owner
   merges, which deploys. Verify check 6 in the UI.
4. The owner does check 4 in claude.ai. Update the reply file to Guardian with the result.

Rollback: remove the edge routes and unset `MCP_URL`. No app code, data or schema is touched.

## Not in this design (follow-ups, each needs an owner decision)

These gaps from the audit are real, but none is needed for checks 1 to 7. Each one patches upstream-owned code,
which means a conflict on every sync.

- **Hardening (audit items):** `scope=` in the 401 challenge; `Cache-Control: no-store` on all `/oauth/token`
  responses, errors included; `iss` on all three authorize redirects (`oauth.controller.ts:120-122,228-230,
  247-249`); PKCE for every DCR client (`oauth.service.ts:372-387`); consent page frame-ancestors + CSRF; token
  expiry, rotating refresh and sha256 storage (today the tokens are deterministic AES and never expire;
  `pos_` OAuth and `psh_` self-hosted tokens both); RFC 8707 audience binding; scope enforcement; membership
  re-check. **Proposal: one upstream issue/PR to gitroomhq** ("spec-required hardening for every self-hosted
  install"). The fork carries nothing. Opening it is outward-facing, so the owner says yes first.
  Audience binding is not cheap locally: it needs a new nullable column on the grant (an additive schema change,
  applied by `prisma db push` at boot), a policy for existing grants without one, and a check in every per-path
  handler, because `pos_` tokens are also accepted on `/api/mcp` (`start.mcp.ts:58,434`).

- **Human-gated tools under the fleet rule:** `deletePostTool`, and `schedulePostTool` type `now` (publish
  immediately) are exposed on every surface. If the owner wants them gated, gate on **how the caller
  authenticated**, not on the mount path, because a `pos_` OAuth token also works on `/api/mcp`:
  - put `authMethod: 'oauth'` into the async context (`async.storage.ts`, the same way `relay` is carried and read
    through `getRelay()`) whenever the token starts with `pos_`, on both `start.mcp.ts:396` and `:446`;
  - have the two tools refuse delete and `now` for that method (undefined context = in-app agent = allowed);
  - for relayed `psh_` calls, refuse in the relay wrapper (`mcp.relay.service.ts`), not on the remote instance.

  Key-based agents keep today's behaviour. Owner decides: gate for OAuth only (recommended), for every surface, or
  keep as is.
