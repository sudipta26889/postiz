#!/usr/bin/env bash
# Follow the CI build and deploy for origin/main. Run it after `git push origin main`.
#
# Pushing to main builds the image, verifies our customizations and fires the
# Portainer webhook (.github/workflows/soul-deploy.yml). This script finds that run
# (waits up to 90s), dispatches one if the push started none, and watches it to the
# end. It exits non-zero if the run fails or can't be started.
# Nothing is built or started on this machine.
set -euo pipefail

REPO=sudipta26889/postiz
WORKFLOW=soul-deploy.yml

# Print the id of the newest run for $SHA; with an argument, only that event.
find_run() {
  gh run list -R "${REPO}" --workflow "${WORKFLOW}" --json databaseId,headSha,event \
    -q "[.[] | select(.headSha == \"${SHA}\" and (\"${1:-}\" == \"\" or .event == \"${1:-}\"))][0].databaseId // empty"
}

SHA=$(git ls-remote origin main | cut -f1)
[ -n "${SHA}" ] || { echo "could not read origin/main" >&2; exit 1; }
echo "==> origin/main is ${SHA:0:7}"

RUN=""
for _ in $(seq 1 18); do  # 18 x 5s = 90s
  RUN=$(find_run)
  [ -n "${RUN}" ] && break
  sleep 5
done

if [ -z "${RUN}" ]; then
  echo "==> no run for ${SHA:0:7} after 90s, dispatching ${WORKFLOW}"
  if ! gh workflow run "${WORKFLOW}" -R "${REPO}" --ref main; then
    echo "ERROR: could not start ${WORKFLOW}. GitHub Actions is probably turned off for the repo." >&2
    echo "The owner enables it at https://github.com/${REPO}/settings/actions (\"Allow all actions\")." >&2
    exit 1
  fi
  for _ in $(seq 1 12); do  # the new run takes a moment to be listed
    RUN=$(find_run workflow_dispatch)
    [ -n "${RUN}" ] && break
    sleep 5
  done
  [ -n "${RUN}" ] || { echo "ERROR: dispatched run never appeared" >&2; exit 1; }
fi

echo "==> watching run ${RUN}"
gh run watch "${RUN}" -R "${REPO}" --exit-status

echo "==> deployed ${SHA:0:7}"
echo "Note: /api returning 200 does not prove the new image is live; see soul/README.md."
