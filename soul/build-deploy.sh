#!/usr/bin/env bash
# Build our image from this repo and deploy it, with verification and rollback.
#
# We run our own build rather than ghcr.io/gitroomhq/postiz-app because our
# customizations (LinkedIn dual-app, the mastra schema patch) only exist here.
# Build arguments mirror upstream CI, see .github/workflows/build-containers.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="soul-$(date +%Y%m%d-%H%M)"
IMAGE="postiz-app:${TAG}"
PREV=$(grep -oE 'postiz-app:[a-z0-9.-]+' docker-compose.soul.yaml | head -1)
VER=$(cat version.txt 2>/dev/null || echo v0.0.0)

echo "==> previous image: ${PREV}"
echo "==> building ${IMAGE}"
docker build -f Dockerfile.dev --build-arg "NEXT_PUBLIC_VERSION=${VER}-soul" -t "${IMAGE}" .

echo "==> verifying the image actually contains our customizations"
FAIL=0
SPANS=$(docker run --rm --entrypoint sh "${IMAGE}" -c \
  'awk "/^model mastra_ai_spans \{/,/^}/" /app/libraries/nestjs-libraries/src/database/prisma/schema.prisma | grep -cE "requestContext"')
[ "${SPANS}" = "1" ] || { echo "  FAIL: mastra_ai_spans patch missing from image"; FAIL=1; }
LI=$(docker run --rm --entrypoint sh "${IMAGE}" -c \
  'grep -rl LINKEDIN_PAGE_CLIENT_ID /app/apps/backend/dist 2>/dev/null | wc -l')
[ "${LI}" -ge 1 ] || { echo "  FAIL: LinkedIn dual-app code missing from compiled backend"; FAIL=1; }
if [ "${FAIL}" -ne 0 ]; then
  echo "==> image rejected, nothing deployed. Previous container untouched."
  exit 1
fi
echo "  ok: schema patch present, LinkedIn dual-app compiled in"

echo "==> deploying ${IMAGE}"
sed -i "s|image: postiz-app:.*|image: ${IMAGE}|" docker-compose.soul.yaml
docker compose up -d --force-recreate postiz

echo "==> waiting for health"
for i in $(seq 1 30); do
  sleep 10
  STATUS=$(docker inspect postiz --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)
  echo "  [${i}] ${STATUS}"
  [ "${STATUS}" = "healthy" ] && break
done

API=$(curl -sk -o /dev/null -w '%{http_code}' https://postiz.sudiptadhara.in/api/ --max-time 15 || echo 000)
MASTRA=$(docker logs postiz --since 5m 2>&1 | grep -ci 'MASTRA_STORAGE_PG_ALTER_TABLE_FAILED' || true)

if [ "${STATUS}" = "healthy" ] && [ "${API}" = "200" ] && [ "${MASTRA}" = "0" ]; then
  echo "==> OK. healthy, /api ${API}, no mastra errors. Now on ${IMAGE}"
  echo "    rollback if needed: soul/rollback.sh ${PREV}"
  exit 0
fi

echo "==> FAILED (health=${STATUS} api=${API} mastra_errors=${MASTRA})"
echo "==> rolling back to ${PREV}"
sed -i "s|image: postiz-app:.*|image: ${PREV}|" docker-compose.soul.yaml
docker compose up -d --force-recreate postiz
echo "==> rolled back. Investigate with: docker logs postiz --tail 200"
exit 1
