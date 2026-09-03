#!/usr/bin/env bash
# Pull in everything new from gitroomhq/postiz-app while keeping our fork intact.
#
# Merge, never rebase. Rebasing rewrites the commits our deployed images were
# built from, which makes "what is actually running" unanswerable.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is dirty. Commit or stash first."
  git status --short
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M)
echo "==> safety tag: presync-${STAMP}"
git tag "presync-${STAMP}"

echo "==> fetching upstream"
git fetch upstream --quiet
BEHIND=$(git rev-list --count HEAD..upstream/main)
echo "==> ${BEHIND} new upstream commits"
if [ "${BEHIND}" -eq 0 ]; then
  echo "Already up to date. Nothing to do."
  exit 0
fi
git log --oneline HEAD..upstream/main | head -40

echo
echo "==> merging"
if ! git merge upstream/main --no-edit; then
  echo
  echo "CONFLICTS. Expected files and how to resolve them:"
  echo "  schema.prisma      keep BOTH sides: upstream's model changes plus our"
  echo "                     mastra_ai_spans / mastra_scorers additions."
  echo "  linkedin.*.ts      keep both: upstream's fixes plus our dual-app support."
  echo "  anything else      see soul/README.md for what we changed and why."
  echo
  echo "Files in conflict:"
  git diff --name-only --diff-filter=U
  echo
  echo "Resolve, then: git add -A && git commit"
  echo "Abort instead with: git merge --abort"
  exit 1
fi

echo
echo "==> checking for the Mastra schema trap"
if ! ./soul/check-mastra-drift.sh; then
  echo
  echo "STOP. Upstream moved the Mastra version or schema. Patch schema.prisma"
  echo "before building, or the backend will crash-loop once the 1600-column"
  echo "limit is reached. soul/README.md explains the fix."
  exit 1
fi

echo
echo "==> merged cleanly and no schema drift."
echo "    Next: ./soul/build-deploy.sh"
echo "    Undo everything: git reset --hard presync-${STAMP}"
