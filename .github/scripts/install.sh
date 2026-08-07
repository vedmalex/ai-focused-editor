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

# (2) The probe and the smokes spawn the backend as
# `node_modules/@theia/cli/bin/theia.js` RELATIVE TO apps/browser, and
# `apps/browser/package.json` declares `@theia/cli` as its own dependency — but
# a fully hoisted install leaves no local entry for it. Recreate the one link
# the app's own scripts assume.
mkdir -p apps/browser/node_modules/@theia
ln -sfn ../../../../node_modules/@theia/cli apps/browser/node_modules/@theia/cli

# (3) With the hoisted layout bun still materialises a few workspace packages'
# `@theia/*` dependencies as real directories rather than links. TypeScript
# then sees two DISTINCT modules for the same package and refuses to assign
# between them ("Types have separate declarations of a private property
# 'codeUri'"). Point them at the single hoisted copy.
for pkg in manuscript-workspace narrative-knowledge theia-git-fork; do
  dir="packages/$pkg/node_modules/@theia"
  [ -d "$dir" ] || continue
  for entry in "$dir"/*; do
    name="$(basename "$entry")"
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then
      rm -rf "$entry"
      ln -sfn "../../../../node_modules/@theia/$name" "$entry"
    fi
  done
done
