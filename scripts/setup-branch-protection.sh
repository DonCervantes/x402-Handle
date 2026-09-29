#!/usr/bin/env bash
# setup-branch-protection.sh
# Automates GitHub branch protection rule configuration for main branch
# Usage:
#   export GITHUB_TOKEN="ghp_xxx"
#   ./scripts/setup-branch-protection.sh [owner/repo] [branch]
#
# Defaults:
#   REPO: KingMavin/x402-Handle (or detected from git remote origin)
#   BRANCH: main

set -euo pipefail

REPO="${1:-}"
BRANCH="${2:-main}"

if [ -z "$REPO" ]; then
  # Try to extract repo from git remote origin
  REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
  if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+/[^/\.]+)(\.git)?$ ]]; then
    REPO="${BASH_REMATCH[1]}"
  else
    echo "Error: Repository not specified and could not be detected from git remote."
    echo "Usage: ./scripts/setup-branch-protection.sh <owner/repo> [branch]"
    exit 1
  fi
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  # Check if gh CLI is authenticated
  if command -v gh &> /dev/null && gh auth status &> /dev/null; then
    GITHUB_TOKEN=$(gh auth token)
  else
    echo "Error: GITHUB_TOKEN environment variable is required or 'gh auth login' must be configured."
    echo "Usage: GITHUB_TOKEN=ghp_... ./scripts/setup-branch-protection.sh $REPO $BRANCH"
    exit 1
  fi
fi

echo "Configuring branch protection for $REPO (branch: $BRANCH)..."
echo "Requiring status checks: 'Verify' and 'Secret Scanning'..."

PAYLOAD=$(cat <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Verify",
      "Secret Scanning"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
EOF
)

RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -X PUT \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/branches/$BRANCH/protection" \
  -d "$PAYLOAD")

HTTP_STATUS=$(echo "$RESPONSE" | tr -d '\r' | sed -n 's/^HTTP_STATUS://p')
BODY=$(echo "$RESPONSE" | sed '/^HTTP_STATUS:/d')

if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
  echo "Successfully configured branch protection for '$BRANCH' on '$REPO'!"
  echo "Pulls now require the 'Verify' and 'Secret Scanning' workflows."
else
  echo "Failed to configure branch protection. HTTP status: $HTTP_STATUS"
  echo "Response: $BODY"
  exit 1
fi
