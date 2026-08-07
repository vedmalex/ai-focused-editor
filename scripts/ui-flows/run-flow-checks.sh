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

# TASK-022 ISS-365 — drive an ISOLATED COPY of the fixture manuscript, never
# examples/sample-book itself. This runner used to point `theia start`
# straight at examples/sample-book, a directory inside this repository:
# `verify`-style runs then contended with any real editor that has the
# sample book open for the narrative-index database's writer lock
# (`rebuild refused (reason: foreign-writer)`), and every run left
# examples/sample-book/.theia/narrative-index.db (-shm/-wal) behind, dirtying
# the working tree. See createIsolatedSampleWorkspace's doc comment in
# narrative-knowledge-round-trip.mjs for the full rationale (this is its
# shell-script equivalent — that helper is JS-only).
#
# `.theia/` is excluded from the copy ON PURPOSE: right now it may hold a
# live writer-lock row from whatever editor has the real
# examples/sample-book open, and copying it would reproduce the exact
# foreign-writer failure this avoids.
#
# THE REALPATH RESOLUTION IS NOT OPTIONAL. On macOS `mktemp -d` returns a
# path under /var/folders/..., itself a symlink to /private/var/...; if
# Theia's stored workspace root and the file watcher's dereferenced view of
# the filesystem disagree about which side of the symlink is canonical, index
# updates stop matching the expected root. Resolve once, here, at creation.
FLOW_WORKSPACE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/afe-flow-sample-book-XXXXXX")"
FLOW_WORKSPACE_DIR="$(cd "$FLOW_WORKSPACE_DIR" && pwd -P)"
SAMPLE_ROOT="$FLOW_WORKSPACE_DIR/sample-book"
mkdir -p "$SAMPLE_ROOT"
( cd "$REPO_ROOT/examples/sample-book" && tar -cf - --exclude='./.theia' . ) | ( cd "$SAMPLE_ROOT" && tar -xf - )

APP_PID=""
cleanup_flow_workspace() {
  [[ -n "$APP_PID" ]] && kill "$APP_PID" 2>/dev/null || true
  rm -rf "$FLOW_WORKSPACE_DIR" 2>/dev/null || true
}
trap cleanup_flow_workspace EXIT

# A stale instance on the port would silently serve an OLD backend (the new
# app fails to bind and dies, curl happily finds the zombie): kill it first.
STALE_PIDS="$(lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$STALE_PIDS" ]]; then
  echo "Killing stale process(es) on port $PORT: $STALE_PIDS"
  kill $STALE_PIDS 2>/dev/null || true
  sleep 2
fi

echo "Starting AI Focused Editor browser app on port $PORT ..."
(cd "$REPO_ROOT/apps/browser" && bunx theia start --hostname 127.0.0.1 --port "$PORT" "$SAMPLE_ROOT") >/tmp/afe-flow-app.log 2>&1 &
APP_PID=$!

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
