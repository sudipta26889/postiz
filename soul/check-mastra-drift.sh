#!/usr/bin/env bash
# Guard against the failure that took Postiz down on 2026-09-03.
#
# Upstream boots with `prisma db push --accept-data-loss`. Any column that
# @mastra/pg creates but schema.prisma does not declare gets dropped on every
# boot and re-added by Mastra. Postgres counts dropped columns toward its
# 1600-column table limit, so eventually the backend cannot start at all.
#
# Run this after every upstream merge, and any time @mastra/pg is bumped.
# Exit 1 means: patch schema.prisma before you deploy.
set -euo pipefail
cd "$(dirname "$0")/.."

SCHEMA=libraries/nestjs-libraries/src/database/prisma/schema.prisma
PW=$(grep -E '^DATABASE_URL' .env | sed -E 's#.*//[^:]+:([^@]+)@.*#\1#')
HOST=$(grep -E '^DATABASE_URL' .env | sed -E 's#.*@([^:/]+).*#\1#')
USER=$(grep -E '^DATABASE_URL' .env | sed -E 's#.*//([^:]+):.*#\1#')
DB=$(grep -E '^DATABASE_URL' .env | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')

q() { PGPASSWORD="$PW" psql -h "$HOST" -U "$USER" -d "$DB" -Atc "$1"; }

echo "== dropped-column headroom (1600 is fatal) =="
q "select c.relname||' dropped='||count(*) filter (where a.attisdropped)||' live='||count(*) filter (where not a.attisdropped)
   from pg_class c join pg_attribute a on a.attrelid=c.oid and a.attnum>0
   join pg_namespace n on n.oid=c.relnamespace
   where c.relkind='r' and n.nspname='public'
   group by c.relname having count(*) > 200 order by count(*) desc"
echo "(no rows above means every table is well under the limit)"

FATAL=0
echo
echo "== columns Mastra creates that schema.prisma would drop =="
for T in $(q "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where c.relkind='r' and n.nspname='public' and c.relname like 'mastra%' order by 1"); do
  if ! grep -q "^model ${T} {" "$SCHEMA"; then
    echo "  TABLE  ${T}  -> absent from schema.prisma, dropped and recreated every boot (known issue, not fatal)"
    continue
  fi
  BLOCK=$(awk "/^model ${T} \{/,/^\}/" "$SCHEMA")
  for COL in $(q "select a.attname from pg_attribute a join pg_class c on c.oid=a.attrelid
                  join pg_namespace n on n.oid=c.relnamespace
                  where n.nspname='public' and c.relname='${T}' and a.attnum>0 and not a.attisdropped"); do
    if ! echo "$BLOCK" | grep -qE "^[[:space:]]+${COL}[[:space:]]"; then
      echo "  COLUMN ${T}.${COL}  -> MISSING from schema.prisma (this is what kills the backend)"
      FATAL=1
    fi
  done
done

echo
if [ "$FATAL" -eq 0 ]; then
  echo "OK: no missing columns. Safe to build and deploy."
else
  echo "FAIL: add the columns listed above to schema.prisma before deploying."
  echo "See soul/README.md, section 'The Mastra trap'."
fi
exit "$FATAL"
