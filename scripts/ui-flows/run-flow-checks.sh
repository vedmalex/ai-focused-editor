#!/usr/bin/env bash
# Runs the AI Focused Editor playwright-cli flow pack against a freshly
# started browser app instance with the sample book workspace.
#
# Requirements: the playwright-flow-scenario-builder and playwright skills
# (their location is auto-detected under ~/.claude/skills; override with
# FLOW_RUNNER / PWCLI).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${AFE_FLOW_PORT:-3311}"
PACK="$REPO_ROOT/scripts/ui-flows/afe-flow-pack.mjs"
FLOW_RUNNER="${FLOW_RUNNER:-$HOME/.claude/skills/playwright-flow-scenario-builder/scripts/run-flow-artifacts.sh}"

if [[ ! -f "$FLOW_RUNNER" ]]; then
  echo "flow runner not found: $FLOW_RUNNER" >&2
  echo "Install the playwright-flow-scenario-builder skill or set FLOW_RUNNER." >&2
  exit 1
fi

echo "Starting AI Focused Editor browser app on port $PORT ..."
(cd "$REPO_ROOT/apps/browser" && bunx theia start --hostname 127.0.0.1 --port "$PORT" ../../examples/sample-book) >/tmp/afe-flow-app.log 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -sf "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
  echo "App did not become ready on port $PORT; log tail:" >&2
  tail -20 /tmp/afe-flow-app.log >&2
  exit 1
fi
echo "App is up."

PW_BASE_URL="http://127.0.0.1:$PORT" \
PW_FLOW_ARTIFACT_DIR="${PW_FLOW_ARTIFACT_DIR:-$REPO_ROOT/output/playwright/flow-scenarios}" \
bash "$FLOW_RUNNER" "$PACK" "$@"
