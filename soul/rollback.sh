#!/usr/bin/env bash
# Put a previous image back. Usage: soul/rollback.sh [image-tag]
# With no argument, falls back to the last known-good upstream image.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-postiz-app:rollback-20260903}"

if ! docker image inspect "${TARGET}" >/dev/null 2>&1; then
  echo "Image ${TARGET} is not on this host."
  echo "Available:"
  docker images postiz-app --format '  {{.Repository}}:{{.Tag}}  {{.CreatedSince}}'
  echo
  echo "The 2026-09-03 upstream image can be restored from backup with:"
  echo "  docker load < /mnt/projects/backups/postiz-20260903/postiz-rollback-image.tgz"
  exit 1
fi

echo "==> rolling back to ${TARGET}"
sed -i "s|image: postiz-app:.*|image: ${TARGET}|" docker-compose.soul.yaml
docker compose up -d --force-recreate postiz

for i in $(seq 1 30); do
  sleep 10
  STATUS=$(docker inspect postiz --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)
  echo "  [${i}] ${STATUS}"
  [ "${STATUS}" = "healthy" ] && break
done
curl -sk -o /dev/null -w 'api=%{http_code}\n' https://postiz.sudiptadhara.in/api/ --max-time 15 || true
