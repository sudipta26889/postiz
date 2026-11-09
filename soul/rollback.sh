#!/usr/bin/env bash
# Put a previous GHCR image back. Usage: soul/rollback.sh <short-sha>
#
# The switch itself is done in Portainer, because the operator credentials are
# not on the development machine. This script says what to do, then waits for
# production to answer.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
if [ -z "${TARGET}" ]; then
  echo "Usage: soul/rollback.sh <short-sha>"
  echo "Recent commits on origin/main (each one built has a :<short-sha> image):"
  git log --format='  %H  %cs  %s' -n 10 origin/main | sed -E 's/^  ([0-9a-f]{7})[0-9a-f]{33}/  \1/'
  exit 1
fi

cat <<EOF
==> In the NAS Portainer, open the Postiz stack on endpoint 11 and:
    1. Set POSTIZ_IMAGE_TAG=${TARGET} in the stack Env.
    2. Redeploy with "re-pull image" on.
    3. Afterwards, remove POSTIZ_IMAGE_TAG once main is fixed, or the stack stays pinned.

    WARNING: the boot command runs prisma db push --accept-data-loss with that
    image's schema, so going back past a schema change can drop newer columns.
EOF
read -rp "Press Enter once the redeploy has started... " _

for i in $(seq 1 60); do
  sleep 10
  API=$(curl -sk -o /dev/null -w '%{http_code}' https://postiz.sudiptadhara.in/api/ --max-time 15 || echo 000)
  echo "  [${i}] api=${API}"
  [ "${API}" = "200" ] && exit 0
done
echo "==> /api did not return 200 within 10 minutes. Check the postiz container logs in Portainer."
exit 1
