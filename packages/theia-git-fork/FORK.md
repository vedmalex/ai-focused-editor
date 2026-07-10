# TEMPORARY FORK — `@ai-focused-editor/git`

> **This package is a temporary vendored fork. Delete it as soon as upstream
> `@theia/git` ships a release built against Theia platform `1.73.x`.**

## Origin

- **Upstream package:** [`@theia/git`](https://www.npmjs.com/package/@theia/git)
- **Forked version:** `1.60.2` (the last published release; the extension is
  officially **deprecated** upstream and has not been rebuilt for newer platforms)
- **Upstream commit at that version:** `20a341b4c41053bfa2c6efc9ff07ac967da077f2`
- **Source acquisition:** `npm pack @theia/git@1.60.2`; the tarball ships `src/`,
  which was copied verbatim into `src/` here. No files were pulled from GitHub.
- **License:** `EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0` (unchanged).
  Every source file keeps its original SPDX license header; see `LICENSE`.

## Why this fork exists

The rest of the app runs on Theia **1.73.1**. The published `@theia/git@1.60.2`
declares hard dependencies on `@theia/core@1.60.2`, `@theia/scm@1.60.2`, etc.
Installing it alongside the 1.73 platform pulls a **second copy of `@theia/core`**
into the dependency graph. Because Theia's dependency injection relies on shared
singleton symbols exported from `@theia/core`, a duplicate `@theia/core` breaks DI
at runtime (contribution bindings from the two core copies do not match). Upstream
has stalled (deprecated, no 1.73-compatible release), so to get an interactive
SCM / Git provider (changes list, stage/unstage, commit from the SCM view,
branch/checkout quick-open) we rebuild the 1.60.2 sources against the single
platform-`1.73.1` `@theia/core` the app already uses.

## What changed relative to upstream `@theia/git@1.60.2`

Only the minimum required to compile and wire against platform 1.73. **No source
modules were excluded from the build** — the full extension (backend over dugite,
SCM provider, diff view, dirty-diff, blame, history, prompt) is compiled.

### Build / packaging

- **`package.json`** — renamed to `@ai-focused-editor/git`, `private: true`,
  `version 0.1.0`. All `@theia/*` dependencies bumped `1.60.2 → 1.73.1`
  (`@theia/monaco-editor-core` set to `1.108.201` to match the workspace). Non-Theia
  deps kept at their original versions. `upath` moved from `devDependencies` to
  `dependencies` (it is a runtime import in `node/dugite-git.ts`). Build now uses a
  plain `tsc` (`rm -rf lib && tsc`) instead of `@theia/ext-scripts`; `react` +
  `@types/react` added as `devDependencies` because the standalone `tsc` needs React
  types to type-check the `.tsx` widgets (the workspace otherwise ships no
  `@types/react`).
- **`tsconfig.json`** — mirrors the upstream Eclipse Theia *base* tsconfig rather
  than this repo's stricter default. In particular `strictPropertyInitialization`
  is OFF (Theia DI uses `@inject` on properties with no initializer) and
  `esModuleInterop` is OFF (`import * as React from '@theia/core/shared/react'`
  targets an `export =` shim).
- **Upstream test files removed.** The mocha/chai/sinon specs (`*.spec.ts`,
  `*.slow-spec.ts`) and their `src/node/test/**` helpers were deleted: they target
  the upstream `@theia/ext-scripts` mocha harness (not used here), pull test-only
  deps (`chai`, `sinon`, `temp`, …) that are intentionally not installed, and Bun's
  test runner (`bun test packages`) would otherwise try to execute the `.spec.ts`
  files. `tsconfig.json` still lists the spec globs under `exclude` as a guard.
- **`src/css-modules.d.ts`** (fork-only) — ambient `declare module '*.css'` so the
  side-effect CSS import in `git-frontend-module.ts` type-checks under `tsc`
  (upstream resolved CSS via webpack at bundle time).

### 1.60 → 1.73 API drift fixes (source)

Grouped by kind; each edited line carries an inline `Fork:` comment.

1. **Preference API relocated.** `createPreferenceProxy`, `PreferenceProxy`,
   `PreferenceService`, `PreferenceContribution`, `PreferenceSchema`,
   `PreferenceChangeEvent`, `PreferenceScope` moved from `@theia/core/lib/browser`
   to `@theia/core/lib/common/preferences`. Import paths updated in
   `git-preferences.ts`, `dirty-diff/dirty-diff-manager.ts`,
   `git-decoration-provider.ts`.
2. **Preference-change events dropped typed `newValue`.** In 1.73 the proxy change
   event type only exposes `preferenceName` (+ `affects()`); `newValue`/`oldValue`
   are no longer on the type (they still exist at runtime). After narrowing on
   `preferenceName`, the code now re-reads the value from the typed preference proxy
   / `PreferenceService.get()` in `git-decoration-provider.ts`,
   `dirty-diff/dirty-diff-manager.ts`, `diff/git-diff-widget.tsx`,
   `history/git-commit-detail-widget.tsx`.
3. **`ScmPreferences` removed.** `@theia/scm/lib/browser/scm-preferences` no longer
   exists in 1.73. `diff/git-diff-widget.tsx` and
   `history/git-commit-detail-widget.tsx` now read `scm.defaultViewMode` through the
   generic core `PreferenceService`.
4. **Toolbar item type renamed.** `TabBarToolbarItem` →
   `RenderedToolbarAction` (`@theia/core/lib/browser/shell/tab-bar-toolbar`) in
   `git-contribution.ts` and `diff/git-diff-contribution.ts`.
5. **`PreferenceSchema` no longer declares `type`.** Removed the redundant
   top-level `'type': 'object'` from `GitConfigSchema` and changed the VS Code
   scope string `scope: 'resource'` to the `PreferenceScope.Folder` enum value in
   `git-preferences.ts`.
6. **Declaration-emit portability.** `git-repository-tracker.ts` — the debounced
   `updateStatus` field got an explicit `() => void` type annotation (TS2742: the
   inferred `lodash` type was not portable across the package boundary).
7. **Repository locator runs in-process (runtime wiring).**
   `node/git-backend-module.ts` — upstream forks a separate `git-locator-host` IPC
   child process unless started with `--no-cluster`. Theia 1.73 removed backend
   clustering AND its bundler no longer emits a `git-locator-host` backend entry
   point (that entry point was hardcoded in the bundler under an
   `ifPackage('@theia/git', …)` guard, which our renamed fork does not satisfy).
   Forking the host therefore fails at runtime with
   `Cannot find module …/git-locator-host`. The fork forces `SINGLE_THREADED = true`
   so `GitLocator` binds to the in-process `GitLocatorImpl` (identical logic to what
   the host process ran).

### Excluded modules

**None.** Every upstream source module compiles and is wired. If a future platform
bump makes a peripheral area (blame decorations, dirty-diff editor integration, git
history/diff widgets) too costly to keep, exclude those files in `tsconfig.json` and
remove their bindings from `git-frontend-module.ts`, documenting each exclusion
here — the MUST-KEEP core is: the dugite git backend (repository discovery/watcher),
`GitScmProvider` + `ScmService` integration (changes, stage/unstage, commit),
branch/checkout quick-open, and the frontend/backend DI modules.

## Runtime notes — native dependencies

### System `git` binary (dugite)

The browser backend's `DefaultGitInit` (`src/node/init/git-init.ts`) locates the
**system** `git` on `PATH` via `find-git-exec` and points dugite at it
(`LOCAL_GIT_DIRECTORY` / `GIT_EXEC_PATH`). Therefore the embedded-git download that
`dugite-no-gpl` (pulled in by `dugite-extra`) performs in its `postinstall` is **not
required** for this app, which is convenient because Bun blocks that lifecycle
script by default. A working system `git` must be on `PATH` at runtime.

### `find-git-repositories` native addon (repository discovery)

`node/git-locator/git-locator-impl.ts` requires the native addon
`find-git-repositories` (`build/Release/findGitRepos.node`). The pinned `0.1.x`
line (`0.1.3`) ships **no** npm `install` script, and Bun does not auto-run
`node-gyp` for `binding.gyp` packages — so a plain `bun install` leaves the addon
**uncompiled**, and the backend would crash on boot with
`Cannot find module '../build/Release/findGitRepos.node'`.

> **Do not bump `find-git-repositories` to `0.2.x`.** `0.1.x` exposes a
> `Promise`-returning wrapper `(startPath, progressCb) => Promise<string[]>`, while
> `0.2.x` exposes the raw callback binary directly as `main` — an incompatible API
> for `git-locator-impl.ts`.

To make this reproducible, this package's `build` runs `build:native`
(`scripts/ensure-native-git.mjs`), which compiles the addon via `node-gyp` when it
is missing (idempotent; skips when already built). Because the root
`build:packages` builds this package **before** `build:browser`, the compiled
`.node` exists when Theia's bundler copies native modules into
`apps/browser/lib/backend/native/`. A C/C++ toolchain (Xcode Command Line Tools /
`build-essential`) and Python must be available. `nan` is already a transitive dep.

## How to drop this fork (when upstream catches up)

When a platform-`1.73.x`-compatible `@theia/git` (or successor) is published — or
when the app migrates to the VS Code built-in Git extension that upstream
recommends:

1. Delete `packages/theia-git-fork/`.
2. Remove `"@ai-focused-editor/git": "0.1.0"` from `apps/browser/package.json` and
   `apps/electron/package.json`; add the upstream `@theia/git` (matching version) if
   still using a Theia-native Git extension.
3. Remove the `packages/theia-git-fork` entries from the root `package.json`
   `build:packages` and `clean` scripts.
4. `bun install` and rebuild.

The fork is deliberately self-contained (one workspace package, three `package.json`
touch-points, two root-script edits) so removal is mechanical.
