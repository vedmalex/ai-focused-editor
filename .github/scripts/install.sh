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
# Rather than enumerate the two, link EVERY `@theia/*` an app declares — the
# next script to address one by path then needs no change here.
for app in apps/*; do
  [ -f "$app/package.json" ] || continue
  mkdir -p "$app/node_modules/@theia"
  grep -oE '"@theia/[a-zA-Z-]+"' "$app/package.json" | tr -d '"' | sort -u | while read -r dep; do
    name="${dep#@theia/}"
    [ -d "node_modules/@theia/$name" ] || continue
    [ -e "$app/node_modules/@theia/$name" ] && continue
    ln -sfn "../../../../node_modules/@theia/$name" "$app/node_modules/@theia/$name"
  done
done

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
