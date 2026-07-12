#!/usr/bin/env bash
#
# Build the AFE Companion plugin and install it into an Obsidian vault.
#
# Usage: scripts/install-obsidian-plugin.sh <vault-path>
#
# Copies the built dist/ (main.js, manifest.json, styles.css) into
# <vault>/.obsidian/plugins/afe-companion/. Enable it in Obsidian under
# Settings → Community plugins after running (restart / reload if it was
# already installed).

set -euo pipefail

PLUGIN_ID="afe-companion"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PKG_DIR="${REPO_ROOT}/packages/obsidian-plugin"

VAULT="${1:-}"
if [[ -z "${VAULT}" ]]; then
  echo "error: vault path required" >&2
  echo "usage: $0 <vault-path>" >&2
  exit 1
fi
if [[ ! -d "${VAULT}" ]]; then
  echo "error: vault directory does not exist: ${VAULT}" >&2
  exit 1
fi

echo "Building ${PLUGIN_ID}…"
( cd "${REPO_ROOT}" && bun run --cwd packages/obsidian-plugin build )

DIST="${PKG_DIR}/dist"
for file in main.js manifest.json styles.css; do
  if [[ ! -f "${DIST}/${file}" ]]; then
    echo "error: build did not produce ${DIST}/${file}" >&2
    exit 1
  fi
done

DEST="${VAULT}/.obsidian/plugins/${PLUGIN_ID}"
mkdir -p "${DEST}"
cp "${DIST}/main.js" "${DIST}/manifest.json" "${DIST}/styles.css" "${DEST}/"

echo "Installed ${PLUGIN_ID} → ${DEST}"
echo "Enable it in Obsidian: Settings → Community plugins → AFE Companion."
