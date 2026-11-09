#!/usr/bin/env bash
# Re-run the CI build and deploy for what is already on origin/main.
#
# Normally you don't need this: pushing to main builds the image, verifies our
# customizations and fires the Portainer webhook (.github/workflows/soul-deploy.yml).
# Nothing is built or started on this machine.
set -euo pipefail

REPO=sudipta26889/postiz
WORKFLOW=soul-deploy.yml

echo "==> triggering ${WORKFLOW} on main"
gh workflow run "${WORKFLOW}" -R "${REPO}" --ref main
sleep 5  # ponytail: the new run takes a moment to be listed; a concurrent dispatch could be picked up instead

RUN=$(gh run list -R "${REPO}" --workflow "${WORKFLOW}" --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId')
echo "==> watching run ${RUN}"
gh run watch "${RUN}" -R "${REPO}" --exit-status
