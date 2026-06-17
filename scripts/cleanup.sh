#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PHOENIX · cleanup — wipe every demo artifact so nothing sticks.
# Closes all open issues & PRs and deletes self-heal/* branches.
# (The dashboard's CLEAN UP button does the same thing.)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${PHOENIX_REPO:-$(git remote get-url origin | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')}"
echo "🧹 cleaning $REPO …"

gh pr list --repo "$REPO" --state open --json number --jq '.[].number' \
  | while read -r n; do echo "  closing PR #$n"; gh pr close "$n" --repo "$REPO" --delete-branch || true; done

gh issue list --repo "$REPO" --state open --json number --jq '.[].number' \
  | while read -r n; do echo "  closing issue #$n"; gh issue close "$n" --repo "$REPO" || true; done

git fetch origin --prune >/dev/null 2>&1 || true
git ls-remote --heads origin 'self-heal/*' | awk '{print $2}' | sed 's#refs/heads/##' \
  | while read -r b; do echo "  deleting branch $b"; git push origin --delete "$b" || true; done

echo "✓ done — repo back to clean baseline."
