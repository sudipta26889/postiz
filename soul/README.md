# SOUL fork of Postiz

This repo is a fork of `gitroomhq/postiz-app` running at
https://postiz.sudiptadhara.in on asus-rog-nuc, as a Git-backed Portainer stack
(`soul/stack.yml`, NAS Portainer, endpoint 11). Development happens on the Mac.

We build and run our own image, `ghcr.io/sudipta26889/postiz-app`. We do not use
`ghcr.io/gitroomhq/postiz-app`, because our customizations only exist in this
repo and a pulled image would silently drop them. That was a real bug: the
LinkedIn dual-app support was configured in `.env` for weeks while no running
code read it.

## Deploying

Push to `main`. `.github/workflows/soul-deploy.yml` builds from `Dockerfile.dev`,
checks the image still has the Mastra patch and LinkedIn dual-app code, pushes
`:latest` and `:<short-sha>` to GHCR, then fires the Portainer webhook.
The webhook step does nothing until the `PORTAINER_WEBHOOK_URL` secret is set.

Every deploy restarts the container, which reruns `prisma db push
--accept-data-loss` against production. `/api` returning 200 afterwards does not
prove the new image is live, because it reports no build SHA. The old script's
check for Mastra errors in the logs and its automatic rollback have no CI
equivalent, so check the container logs in Portainer after a schema change.

## Syncing with upstream

```bash
./soul/sync-upstream.sh     # tag, fetch, merge, check for the Mastra trap
git push origin main        # CI builds, verifies and deploys
./soul/build-deploy.sh      # only to re-run CI for what is already on main
```

**Run `soul/check-mastra-drift.sh` before merging any upstream sync or
`@mastra/pg` bump into `main`**, because every push to `main` deploys and reruns
`db push` on production. The script only runs read-only queries, so it is the one
thing allowed against production from a development machine, and only for this
purpose. `sync-upstream.sh` runs it after its local merge, before anything is pushed.

Undo a sync entirely: `git reset --hard presync-<stamp>` (the tag the sync
script creates before touching anything).

Roll back a deploy: `./soul/rollback.sh <short-sha>`, which sets out the Portainer
steps and then waits for `/api`. The boot command applies that image's schema, so
going back past a schema change can drop newer columns.

## Stack environment

Every env key must be listed in `soul/stack.yml` as `${KEY:-}` and have its value
in the Portainer stack Env. A new key goes in `.env`, `.env.example`, the stack
file and the stack Env. To compare the stack file with a `.env`, by key names only:

```bash
comm -3 <(grep -oE '^[A-Z_0-9]+=' .env | tr -d = | sort -u) \
        <(grep -oE '^  [A-Z_0-9]+: \$\{' soul/stack.yml | tr -d ' :${' | sort -u)
```

The left column is keys missing from the stack, and the indented right column is
stack keys that `.env` does not have. Paste values with `pbcopy`, never by
retyping. A percent-encoded `REDIS_URL` loses its meaning if it gets decoded.

**Merge, never rebase.** Rebasing rewrites the commits our built images came
from, and then nobody can tell what is actually running.

## What we changed, and why

Kept deliberately small, and kept out of files upstream edits often.

| Change | Where | Why | Conflict risk |
|---|---|---|---|
| Our deployment | `soul/stack.yml`, `.github/workflows/soul-deploy.yml` | Own image from GHCR, stack Env secrets, port 4007, external uploads volume, healthcheck, autoheal | **None.** Upstream's `docker-compose.yaml` is untouched. |
| Secrets and config | Portainer stack Env, `.env` (untracked) | Real credentials never enter git or an image (`.dockerignore`) | Low. Keep our lines in `.dockerignore`. |
| Mastra schema patch | `schema.prisma`, models `mastra_ai_spans` and `mastra_scorers` | See "The Mastra trap" | Medium. Upstream may edit these models. Keep both sides. |
| LinkedIn dual-app | `linkedin.page.provider.ts`, `linkedin.provider.ts`, `facebook.provider.ts` | Post as a personal profile or a company page using separate OAuth apps (`LINKEDIN_PAGE_CLIENT_ID` / `_SECRET`) | Medium. Keep both sides. |
| This tooling | `soul/` | Nothing upstream will ever create | None |

`.env` and `.env.example` keep the same key set, so a new key goes in
`.env.example` too. Our extra variables:

```
LINKEDIN_PAGE_CLIENT_ID=       # second LinkedIn OAuth app, for company pages
LINKEDIN_PAGE_CLIENT_SECRET=
POSTIZ_IMAGE_TAG=              # stack Env only, and only while rolled back
```

## The Mastra trap

This is the one that will bite again. Read it before dismissing a
`check-mastra-drift.sh` failure.

Upstream's boot command runs `prisma db push --accept-data-loss` on **every**
container start. `schema.prisma` contains hand-modelled copies of Mastra's
tables. When the bundled `@mastra/pg` creates a column that `schema.prisma`
does not declare, `db push` drops it on boot and Mastra re-adds it moments
later. Postgres counts dropped columns toward its hard limit of 1600 columns
per table, so after enough restarts the table is full and the backend cannot
start. It crash-loops, autoheal restarts it, and `/api` returns 502.

That is exactly what happened on 2026-09-03: `mastra_ai_spans` and
`mastra_scorers` had roughly 1570 dropped columns each.

**Recovery** (rebuild the table; `VACUUM FULL` does not reset the count):

```sql
begin;
create table mastra_scorers_new (like mastra_scorers including all);
insert into mastra_scorers_new select * from mastra_scorers;
drop table mastra_scorers;
alter table mastra_scorers_new rename to mastra_scorers;
commit;
```

Afterwards drop the duplicate `*_new_*` indexes that `INCLUDING ALL` leaves.

**Prevention**: `soul/check-mastra-drift.sh` compares every live Mastra table
against `schema.prisma` and exits non-zero when a column is missing. The sync
script runs it automatically. If it fails, add the missing columns to the
model and re-run, then deploy.

## Mastra tables outside the schema

`db push` drops any `mastra_*` table that `schema.prisma` does not model, and
Mastra recreates it empty, losing its state on every restart. On 2026-11-08 the
live database had 45 Mastra tables and all 45 were modelled, so nothing is
dropped today. A Mastra upgrade can add tables: `check-mastra-drift.sh` reports
those as `TABLE ... absent from schema.prisma`.

The clean long-term fix is to give Mastra its own Postgres schema, so Prisma
never manages its tables. `PgStore` accepts a `schemaName`.

## Backups

`/mnt/projects/backups/postiz-20260903/` holds a verified set from the day of
the incident: database dump, config, uploads volume, a full git bundle, and a
1.2 GB save of the last upstream image. See the restore card in that folder's
sibling notes, or the project doc `Postiz_Mastra_1600_Columns_Fix.md`.
