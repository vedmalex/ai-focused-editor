#!/usr/bin/env bash
# Install dependencies the way this repository actually needs them.
#
# TWO QUIRKS, BOTH LEARNED THE HARD WAY, BOTH LOAD-BEARING. A plain
# `bun install` produces a tree the Theia bundler cannot build.
set -euo pipefail

# (1) bun 1.3.x defaults to an ISOLATED node_modules layout: a package's
# dependencies live under `node_modules/.bun/...` and are reached by symlink.
# `@theia/bundle-plugin` resolves native packages with its own resolver, which
# expects the flat (hoisted) layout, and fails with
#   "Could not resolve path of module: @parcel/watcher-linux-x64-glibc"
#   "Could not resolve path of module: @vscode/ripgrep-linux-x64"
# even though both ARE installed. `--linker=hoisted` is what makes them
# findable.
bun install --linker=hoisted

# (2) The apps' own scripts address their dependencies by RELATIVE PATH, which a
# hoisted install does not provide. Two known callers, and they fail differently
# enough that neither hints at the other:
#   - the smokes spawn the backend as `node_modules/@theia/cli/bin/theia.js`
#     relative to `apps/browser`;
#   - `apps/electron`'s `build:ffmpeg-native` runs
#     `node-gyp rebuild --directory node_modules/@theia/ffmpeg`, and node-gyp
#     silently falls back to the CWD when that directory is absent, so the error
#     reads `binding.gyp not found (cwd: apps/electron)` and says nothing about
#     the missing package.
# A THIRD CALLER, found by CI rather than by reasoning: the mermaid vendor test
# in `packages/manuscript-workspace` reads
# `node_modules/@theia/ai-chat-ui/lib/.../mermaid-rendering.d.ts` by path
# relative to its OWN package, on purpose — it exists to notice when that
# undocumented deep import moves upstream.
#
# (3) AND THE SAME LAYOUT BITES A SECOND WAY. Where bun DOES materialise a
# workspace package's `@theia/*` dependency, it may do so as a real directory
# rather than a link. TypeScript then sees two DISTINCT modules for one package
# and refuses to assign between them ("Types have separate declarations of a
# private property 'codeUri'").
#
# Both halves are the same job — make every declared `@theia/*` reachable at the
# path its own package expects, and make it the SINGLE hoisted copy — so they
# are one loop over apps AND packages rather than two lists to keep in sync.
for workspace in apps/* packages/*; do
  [ -f "$workspace/package.json" ] || continue
  depth="$(printf '%s' "$workspace" | tr -cd '/' | wc -c)"
  # ../ once for @theia, once for node_modules, then out of the workspace dir.
  up=""
  for _ in $(seq 1 $((depth + 3))); do up="../$up"; done

  mkdir -p "$workspace/node_modules/@theia"
  # `|| true` because a workspace with NO `@theia/*` dependency is normal
  # (`semantic-markdown`, `book-export`, …) and grep exits 1 on no match, which
  # `set -e` would otherwise take for a failure and abort the whole install.
  { grep -oE '"@theia/[a-zA-Z-]+"' "$workspace/package.json" || true; } | tr -d '"' | sort -u | while read -r dep; do
    name="${dep#@theia/}"
    target="$workspace/node_modules/@theia/$name"
    [ -d "node_modules/@theia/$name" ] || continue
    # A real directory is a SECOND copy: replace it. A link is already correct.
    if [ -e "$target" ] && [ ! -L "$target" ]; then
      rm -rf "$target"
    elif [ -e "$target" ]; then
      continue
    fi
    ln -sfn "${up}node_modules/@theia/$name" "$target"
  done
done
