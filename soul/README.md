# SOUL fork of Postiz

This repo is a fork of `gitroomhq/postiz-app` running at
https://postiz.sudiptadhara.in on asus-rog-nuc, from `/mnt/projects/Postiz`.

We build and run our own image. We do not use `ghcr.io/gitroomhq/postiz-app`,
because our customizations only exist in this repo and a pulled image would
silently drop them. That was a real bug: the LinkedIn dual-app support was
configured in `.env` for weeks while no running code read it.

## Syncing with upstream

```bash
./soul/sync-upstream.sh     # tag, fetch, merge, check for the Mastra trap
./soul/build-deploy.sh      # build, verify, deploy, auto-rollback on failure
```

Undo a sync entirely: `git reset --hard presync-<stamp>` (the tag the sync
script creates before touching anything).

Roll back a deploy: `./soul/rollback.sh <image-tag>`, or with no argument to
reach the last known-good upstream image.

**Merge, never rebase.** Rebasing rewrites the commits our built images came
from, and then nobody can tell what is actually running.

## What we changed, and why

Kept deliberately small, and kept out of files upstream edits often.

| Change | Where | Why | Conflict risk |
|---|---|---|---|
| Our deployment | `docker-compose.soul.yaml` | Own image, `.env` secrets, port 4007, `./config` bind mount, healthcheck, autoheal | **None.** Upstream's `docker-compose.yaml` is untouched. `.env` sets `COMPOSE_FILE` so plain `docker compose` picks ours up. |
| Secrets and config | `.env` (untracked) | Real credentials never enter git | None |
| Mastra schema patch | `schema.prisma`, models `mastra_ai_spans` and `mastra_scorers` | See "The Mastra trap" | Medium. Upstream may edit these models. Keep both sides. |
| LinkedIn dual-app | `linkedin.page.provider.ts`, `linkedin.provider.ts`, `facebook.provider.ts` | Post as a personal profile or a company page using separate OAuth apps (`LINKEDIN_PAGE_CLIENT_ID` / `_SECRET`) | Medium. Keep both sides. |
| This tooling | `soul/` | Nothing upstream will ever create | None |

`.env.example` is deliberately left identical to upstream so it never
conflicts. Our extra variables are documented here instead:

```
LINKEDIN_PAGE_CLIENT_ID=       # second LinkedIn OAuth app, for company pages
LINKEDIN_PAGE_CLIENT_SECRET=
COMPOSE_FILE=docker-compose.soul.yaml
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

## Known issue, not fixed

`db push` also drops **21 `mastra_*` tables** that are absent from
`schema.prisma` entirely (agents, datasets, skills, observational_memory,
mcp_servers, workspaces, prompt_blocks, experiments and friends). Mastra
recreates them empty, so any state those features hold is lost on every
restart. This is upstream behaviour and predates our fork. It is not fatal,
which is why it is still open.

The clean fix is to give Mastra its own Postgres schema, so Prisma never
manages its tables at all. `PgStore` accepts a `schemaName`. That is a
code change in how Postiz constructs its Mastra storage, so it needs its
own piece of work.

## Backups

`/mnt/projects/backups/postiz-20260903/` holds a verified set from the day of
the incident: database dump, config, uploads volume, a full git bundle, and a
1.2 GB save of the last upstream image. See the restore card in that folder's
sibling notes, or the project doc `Postiz_Mastra_1600_Columns_Fix.md`.
