#!/usr/bin/env bash
set -euo pipefail

# Usage: ./push-to-fork.sh [fork-remote-url] [branch]
# Example: ./push-to-fork.sh https://github.com/benedict-cmd/x402-Handle.git feature/soroban-registry-audit

FORK_URL=${1:-https://github.com/benedict-cmd/x402-Handle.git}
BRANCH=${2:-feature/soroban-registry-audit}

# ensure we're in repo root
# push to fork remote named 'fork'
if git remote get-url fork >/dev/null 2>&1; then
  git remote set-url fork "$FORK_URL"
else
  git remote add fork "$FORK_URL"
fi

echo "Fetching origin and fork..."
git fetch origin
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  echo "Pushing branch '$BRANCH' to fork ($FORK_URL)..."
  git push fork "$BRANCH":"$BRANCH" --set-upstream
  echo "Pushed. Open PR: https://github.com/benedict-cmd/x402-Handle/compare/main...$BRANCH?expand=1"
else
  echo "Branch '$BRANCH' not found locally. Create it or run from repo root where the branch exists."
  exit 1
fi
