#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PHOENIX · one-command startup
#   git clone https://github.com/aburt1/phoenix-selfheal && cd phoenix-selfheal && ./start.sh
# Zero dependencies to install — pure Node built-ins. This just checks your env,
# opens the browser, and runs the server.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "✗ Node.js 22+ required → https://nodejs.org"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || { echo "✗ Node 22+ required (you have $(node -v))"; exit 1; }

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  REPO=$(git remote get-url origin 2>/dev/null | sed -E 's#.*github.com[:/]([^/]+/[^/.]+)(\.git)?#\1#' || true)
  echo "✓ gh authenticated — GitHub mode LIVE${REPO:+ → $REPO}"
else
  echo "• gh not authenticated — the GitHub stage will be simulated."
  echo "  Run 'gh auth login' for the full loop (real issues + PRs)."
fi

PORT="${PORT:-4178}"
URL="http://localhost:$PORT"
echo "→ Phoenix mission control: $URL"

# open the browser shortly after the server boots
( sleep 1
  if command -v open  >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi ) >/dev/null 2>&1 &

exec env PORT="$PORT" node server.js
