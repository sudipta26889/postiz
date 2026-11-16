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

## Owner decisions (2026-11-16)

1. Delete and publish-now tools **stay**, and every MCP call to them goes through **DharaHIL** human approval and
   fails closed. This is the TaskPilot / ERPNext pattern. → Phase G.
2. OAuth hardening: **do it properly, in this fork** (Postiz already has an authorization server that only needs
   fixing, so the fleet rule doesn't make us wait for Studio). → Phases H1 to H3.
3. Guardian's edge routing: approved. → Phase A.

Phases ship one PR each, in this order: A → G0+G → H1 → H2 → H3. Each PR comes with its own tests (jest; the repo has no
tests today, so each phase adds them next to the code). The developer builds, the lead reviews, and the owner merges.

## Phase G0: a test harness that runs

There are no tests in the repo. `jest.config.ts` and `jest.preset.js` need `@nx/jest`, which isn't installed. `jest`
29 and `ts-jest` are installed.

- Replace the root `jest.config.ts` with a plain ts-jest config: `testMatch: **/*.spec.ts` under `libraries/` and
  `apps/backend`, and a `moduleNameMapper` for `@gitroom/*` built from `tsconfig.base.json` paths. Delete
  `jest.preset.js` if nothing else uses it.
- Check: `pnpm test` runs one trivial spec and passes. This ships inside the Phase G PR.

## Phase G: DharaHIL approval for delete and publish-now over MCP (revised after review)

Facts the design rests on (verified):
- The gateway reuses a request for the same `idempotency_key` **only while it is PENDING**
  (`DharaHIL/gateway/app/services/approvals.py:89-96`). After any terminal state, the same key opens a new request.
- `ALLOW` and `AUTO_ALLOWED` come back with no `request_id`. `REQUIRE_APPROVAL` comes back with a `status`.
  Standing grants match on `run_id` (`approvals.py:226-247`).
- `/executed` is an unconditional write, and the request stays `APPROVED` until it is reported.
- A post with `type: "schedule"` and a date at or before now is created and its workflow starts at once
  (`posts.service.ts:1205-1234`), so it's a publish-now in practice.

**What is gated.** Each tool declares `approval?: (args) => string | null` (a reason, or null for no approval).
One generic wrapper enforces it, so the helper never names a tool.
- `deletePostTool` (`tools/delete.post.tool.ts:45`) is always gated.
- `schedulePostTool` (`tools/integration.schedule.post.ts:173`) is gated when **any** `socialPost` item has
  `type == "now"`, or a date at or before now + 5 minutes. The whole call is gated, after validation (`:181-247`)
  and before the `createPost` loop (`:249`).

**Where it applies: fail closed.** Every `runWithContext` call in `start.mcp.ts` (`:396`, `:446`, `:486`, `:525`) sets
`surface: 'mcp'`. The in-app chat (`copilot.controller.ts:85-92`) wraps its run in
`runWithContext({ surface: 'app' })`. The gate is skipped **only** when `surface === 'app'`, so a new entry point that
forgets the marker is gated. Relayed `psh_` calls (cloud only, `MCP_SELF_HOSTED_RELAY`, off in our deployment) refuse
gated actions outright with "not available through the relay".

**The approval loop** (generic helper `libraries/nestjs-libraries/src/chat/human.approval.ts`, mirroring TaskPilot's
`apps/mcp/src/a2a/dharahil.ts`):
1. `key = postiz:<orgId>:<toolName>:<sha256(canonicalJSON(args))[:24]>`. Canonical JSON uses sorted keys, like
   the DharaHIL SDK.
2. Redis is the existing `ioRedis` client. It adds `postiz:` itself (`redis.service.ts:44`), so keys are written
   without it. `hil:req:<key>` → `requestId`, TTL until `expires_at`, extended by 7 days once the request is seen
   APPROVED so a late caller doesn't lose the approval. **If `REDIS_URL` is unset**, the client is `MockRedis`, whose
   `set` ignores `NX` (`redis.service.ts:11-14,39-46`). Then gated actions are refused (`isError`), because the
   at-most-once claim can't be guaranteed.
3. With no mapping, `POST /v1/requests` with `run_id = key` (so standing grants never spread to other calls),
   `risk_level HIGH`, `metadata {org, tool, post_id?}`, and the redacted args.
   - `ALLOW` / `AUTO_ALLOWED` (policy said yes): run with the original args.
   - `REQUIRE_APPROVAL`: store the mapping and return a normal result: "Waiting for human approval in DharaHIL
     (request <id>, expires <time>). Call this tool again with the same arguments once approved."
   - `DENY`, or any error: return an `isError` result.
4. With a mapping, `GET /v1/requests/{id}`.
   - `PENDING`: return "still waiting".
   - `APPROVED`: the GET response has no `tool_name` (`DharaHIL/gateway/app/schemas/requests.py:79-103`), so check
     `metadata.org == orgId` and `metadata.tool == toolName`. Run with `approved_args`. If the human edited them,
     they go through the tool's **full** checks again: the zod schema, `validatePosts`
     (`integration.schedule.post.ts:181-247`), the org-scoped integration lookup, and the trigger rule. Only then
     **claim**:
     - `SET hil:exec:<requestId> running NX` (TTL 30 days); the first claim runs the action.
     - After the action, set `done` and report `/executed` (best effort, logged on failure).
     - A failed claim answers from the stored value: `done` → "already done (request <id>)", `running` →
       "started earlier and its result is unknown; check before retrying (request <id>)".
     - The claim comes before execution: at most once, never twice.
   - `EXECUTED`: "already done".
   - `REJECTED`, `AUTO_DENIED`, `EXPIRED`, `REVISE_REQUESTED`, `DENY` or any unknown status: delete the mapping and
     return `isError` with the reason. A later call starts a fresh request.
   - Any `date` that doesn't parse counts as publish-now (gated).
   - In-app chat check on dev: `copilot.controller.ts:85-113` sets a Mastra `requestContext`. Confirm that ALS
     `surface: 'app'` reaches the tools through CopilotRuntime. If it doesn't, in-app delete gets gated, which fails
     closed but must be fixed before release.
5. Config: `DHARAHIL_BASE_URL`, `DHARAHIL_TENANT_ID`, `DHARAHIL_APP_ID`, `DHARAHIL_API_KEY`. The gate is **always
   on**; there is no off switch. With config missing, gated actions return `isError` "approval service not configured".
   Add the keys to `soul/stack.yml`, `.env.example` and the Portainer Env.

**Not gated:** future scheduling, drafts, edits and reads. This is the owner's scope: delete and publish-now only.

**Rollout dependency:** the DharaHIL `postiz` app must exist before this deploys. Otherwise every MCP delete or
publish-now is refused, which changes behaviour for the key-based agents that use them today.

**Checks (jest):**
- Key stability: canonical order gives the same key; different args or a different org give a different key.
- The decision mapping for every gateway answer.
- The claim, against a mocked ioredis that honours NX: a second execution is refused; `running` and `done` give
  different messages; a missing `REDIS_URL` (MockRedis) refuses.
- Edited `approved_args` that fail validation, or that point at another org's integration, are refused.
- The trigger: `now`, a past date and a date within 5 minutes are gated; a future date and drafts are not.
- Fail closed: no config gives an error, and an undefined surface is gated.
- Dev-instance run-through: delete → waiting → approve → deleted → call again → "already done".

## Phase G2: the same gate on the public REST API (ships in the same PR as G)

Gap: the org API key (and `pos_` tokens, `public.auth.middleware.ts:32-38`) also works on the public API
(`apps/backend/src/public-api/routes/v1/public.integrations.controller.ts`). Without a gate there, the MCP-only gate
is bypassed by calling REST. The grihatek agents post through a Paperclip "postiz-api-key-shim" over this API.

Gated routes (owner's scope: delete and publish-now):
- `POST /public/v1/posts` (`:147`) when any post is `type: "now"`, or dated at or before now + 5 min, or has an
  unparseable date. The trigger rule is the one from Phase G, shared.
- `DELETE /public/v1/posts/:id` (`:234`) and `DELETE /public/v1/posts/group/:group` (`:244`).

How: the same `human.approval.ts` helper, called from the controller (or its service) with a generic action name
(`public.posts.create`, `public.posts.delete`, `public.posts.deleteGroup`) and the request body/params as args.
Same key, Redis map, claim and fail-closed rules.

HTTP answers. A pending approval must never look like success to a REST client:
- Pending → **HTTP 428 Precondition Required**, JSON `{ status: "approval_pending", requestId, expiresAt,
  message: "Repeat the identical request after approval in DharaHIL" }`.
- Rejected, expired, denied or misconfigured → **403** with the reason.
- `done` claim on a repeat → **409** "already done (request <id>)". `running` → **409** with the "result unknown" text.
- Approved and first claim → the normal success response.

Not gated: the frontend's own `/posts` routes (a signed-in person, same as the in-app chat), future scheduling,
drafts, edits, reads. Deleting a channel (`DELETE /public/v1/integrations/:id`, `:583`) is outside the owner's
scope as stated; it's listed for the owner to decide.

Effect on the grihatek agents: they get Paperclip's approval **and then** DharaHIL's. Their shim must treat 428 as
"wait and retry", not as a failure. The Paperclip owner must be told before release (through Guardian).

Checks (jest): each gated route returns 428 on first call, the success response after approval, 409 on repeat;
ungated cases (a future date, drafts) pass straight through; no config or no Redis → 403.

## Phase H1: hardening with no schema change (revised)

| Gap | Change |
|---|---|
| `scope=` missing from the 401 | add `scope="mcp:read mcp:write"` to both challenges (`oauth-middleware.ts:91-94,111-122`) |
| no-store on `/oauth/token` | `Cache-Control: no-store`, `Pragma: no-cache` on every response of the route, errors included (an interceptor or filter scoped to the route) |
| PKCE | S256 required for **dynamic** apps (DCR, and CIMD later), not only public ones (`oauth.service.ts:372-387`). Static `pca_` apps keep today's lenient flow (`pkceBinding`, `:410-428`), because org integrations depend on it |
| CORS | `*` without credentials on `/oauth/token` and `/oauth/register` only |
| Consent CSRF | the backend accepts the cookie alone (`auth.middleware.ts:35`), so `POST /oauth/authorize` (approve and deny) and `/authorize/self-hosted` reject when `Origin` (or `Referer`) isn't the frontend origin |
| Consent framing | `frame-ancestors 'none'` and `X-Frame-Options: DENY` on the `/oauth/authorize` page; show the redirect host |
| Membership | a new repository query: the grant's user is still in the org (`UserOrganization`, not disabled), and neither user nor org is deleted. Checked on every OAuth-token MCP call and on public-API `pos_` use (`public.auth.middleware.ts:32-38`) |
| Origin | on `/mcp-oauth*`: a present `Origin` that isn't allowlisted (`https://claude.ai`, `https://chatgpt.com`, our origin; extend with `MCP_ALLOWED_ORIGINS`) → 403 |
| Protocol version | on `/mcp-oauth*`: an `MCP-Protocol-Version` outside {2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28} → 400 |

`iss` moves to H2: three issuers share one authorize endpoint, and only H2's `resource` tells us which one the client
discovered.

## Phase H2: token model for MCP clients (additive schema, revised)

**Scope:** dynamic (DCR/CIMD) apps, which means MCP clients. Static `pca_` apps (org-built integrations on the
public API) and HubSpot keep today's long-lived tokens unchanged; that's an owner-visible choice, listed below.
Self-hosted `psh_` grants are out of scope, because the relay is off here.

Schema (all additive, created by `prisma db push`):
- `OAuthToken`: `id`, `authorizationId` (FK `OAuthAuthorization`), `kind` (`access` | `refresh`),
  `tokenHash` (unique), `resource`, `scope`, `familyId`, `expiresAt`, `usedAt?`, `revokedAt?`, `createdAt`.
- `OAuthAuthorization` gains nullable `resource`, `scope`, `codeHash`, `codeConsumedAt`, `lastUsedAt`.
  Existing rows stay NULL, and NULL scope reads as `mcp:read mcp:write`.

Flow:
- **Authorize**: `resource` is carried through `ApproveOAuthDto`, the consent frontend and `createAuthorizationCode`.
  For dynamic apps it must equal a canonical MCP URL (`<origin>/mcp-oauth-dynamic|-claude|-chatgpt`, legacy
  `/mcp-oauth`), otherwise `invalid_target`. When it's absent, default to the resource of the issuer the request came
  in on. The code is stored as `codeHash`, with a 5 min TTL (down from 10, `oauth.service.ts:442,483`).
- **Redirect**: `iss` = the issuer that matches `resource`, on all three redirect paths (`oauth.controller.ts:120-122,
  228-230,247-249`).
- **Code exchange**: in one transaction, a conditional update `where codeHash = h and codeConsumedAt IS NULL`.
  - `count == 0` and the hash matches a consumed row: reuse, so revoke the grant and all its token families.
  - Otherwise, issue a 1 h access token and a 30 day refresh token (random; only the sha256 hash is stored;
    lookup by hash).
- **Refresh**: in one transaction, mark the old token used with a conditional `usedAt IS NULL` update and insert the
  new pair.
  - Replay outside a 30 s grace window revokes the family and the grant.
  - Inside the window, return the pair already issued.
  - Advertise `refresh_token` on every issuer; DCR accepts and returns it (`oauth.service.ts:207,247`).
- **Re-consent**: the upsert (`oauth.repository.ts:170-197`) also revokes every earlier family of that grant.
- **Validation**: for an `/mcp-oauth*` path, hash the token, then look it up in `OAuthToken` (kind access, not
  expired or revoked), then require `resource == this path's canonical URL`, then run the membership check
  (from H1), then update `lastUsedAt` (throttled).
  - New-model tokens are refused on `/api/mcp` and on the public API.
  - When a hash isn't found, fall back to the legacy column for the transition.
- **Legacy dynamic tokens** (old column, deterministic AES, no expiry):
  - They keep working until `OAUTH_LEGACY_DYNAMIC_UNTIL`.
  - One `refresh_token` grant that presents the legacy token is accepted, which moves the client onto a new family
    without re-consent.
  - Before the date is set, the owner gets a read-only count of legacy dynamic grants per client.
- **Scope**: the plumbing stores and checks scope, but consent grants both scopes (`oauth.service.ts:292-298`).
  The HTTP 403 `insufficient_scope` needs the JSON-RPC body read before Mastra, which means buffering the stream
  (MCP handlers run before Nest's body parser, `main.ts:62`). That's a spike in H3, paired with a "read-only" option
  on the consent page, since enforcing it before then changes nothing.

## Phase H3: client registration, scope, and the admin view

- **CIMD**: an https `client_id` is fetched with the existing `ssrfSafeDispatcher` and `isSafePublicHttpsUrl`
  (`mcp.relay.service.ts:14-15`), no redirects, a 64 KB cap and a 5 s timeout. `client_id` in the document must equal
  the URL, and the redirect URI must be listed. It's upserted as a dynamic `OAuthApp` row keyed by the URL, so the
  existing FKs hold. Advertise `client_id_metadata_document_supported: true`.
- **DCR**: new registrations are public only (`none`). Existing confidential dynamic apps and private-scheme
  redirects (e.g. Grok, `oauth.service.ts:189`) keep working.
- **Revocation**: `/oauth/revoke` (RFC 7009), advertised in the metadata.
- **Scope**: a "read-only" option on the consent page, plus the stream pre-parse that returns 403
  `insufficient_scope` for a `tools/call` of a tool without `readOnlyHint` (`tools[name].mcp.annotations`).
  Spike first: confirm Mastra's `startHTTP` accepts a re-streamed body.
- **Org admin view**: Settings lists the org's OAuth connections (app, user, created, `lastUsedAt`) with revoke.

## Owner-visible choices made in this revision

- Static OAuth apps and HubSpot keep long-lived tokens. Only MCP clients get the 1 h / rotating model.
- The gate has no off switch. If DharaHIL is missing or down, MCP delete and publish-now are refused.
- "Publish now" includes a schedule dated within 5 minutes of now.
- Gated actions through a self-hosted relay are refused (the relay is not used here).

## Upstream

All of G and H is generic and would help every Postiz install. After it has run in our production for a while,
offer it to gitroomhq as PRs (the owner says yes first: it's an outward post).

