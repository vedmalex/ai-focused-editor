# Contributing

AI Focused Editor is a Theia-based writing studio developed in feature waves.
This document describes the workflow and the verification bar every change has
to clear.

## Workflow

`main` is protected: direct pushes are rejected, changes land only through
pull requests.

1. Branch off `main`: `git checkout -b <topic>` (e.g. `entity-hover`,
   `doctor-obsidian-install`).
2. Commit in feature waves (see the commit format below). One wave = one
   coherent, revertible feature.
3. Open a PR: `gh pr create`. Describe what shipped and how it was verified.
4. Merge with a merge commit (`gh pr merge --merge`) to keep the per-wave
   commit granularity in history.
5. Record shipped waves in `PROGRESS.md` (what landed, how it was verified,
   test counts).

## Commit format

```
tag - module: what this commit does

- logical change, one per bullet
- another logical change
```

- Tags: `feat`, `fix`, `refactor`, `chore`, `test`, `doc`, `schema`.
- Module examples: `entities`, `editor`, `doctor`, `obsidian`, `build`,
  `appearance`, `wiki`.
- Imperative description, no trailing period on bullets, **no attribution or
  metadata trailers** of any kind.
- One commit = one revertible change. Split refactorings from features and
  features from behavior changes.

## Setup

```bash
bun install
bun run build          # packages + browser app bundle
bun run start          # browser app on http://localhost:3000
bun run start:electron # desktop app
```

The Obsidian companion plugin builds separately:

```bash
bun run --cwd packages/obsidian-plugin build
bash scripts/install-obsidian-plugin.sh <vault>   # optional manual install
```

## Verification ladder

Run the level that matches your change; a PR states which levels ran.

| Level | Command | When |
|---|---|---|
| Unit tests | `bun test packages` | always |
| Typecheck | `bunx tsc -p packages/manuscript-workspace --noEmit` | always |
| Build | `bun run build` | always |
| Full verify | `bun run verify:full` | before merging UI/backend changes (adds electron + browser smokes) |
| UI flow pack | `bun run test:ui:flows` | changes touching menus, tree, editors, i18n |
| Excalidraw smoke | `node scripts/excalidraw-smoke.mjs` | canvas/diagram changes |

A green agent or CI report is necessary, not sufficient: for UI-visible
changes, verify the running app (a temporary Playwright probe against
`examples/sample-book` is the established pattern — keep probes out of
commits).

## Project conventions

- **Pure logic lives in `common/`** with `bun` tests next to it
  (`*.test.ts`). Widgets and services stay thin; parsing/validation is shared
  between frontend, backend, and the Obsidian plugin through these modules.
- **Single source of truth**: entity types come from
  `common/entity-type-registry.ts`; do not duplicate its validation or
  defaults. The same applies to other `common/` contracts (doctor checks,
  hover markdown, device theme resolution).
- **i18n**: follow `packages/manuscript-workspace/i18n/README.md`. English
  defaults are inline via `nls.localize` (byte-stable — flow packs assert
  them); Russian lives in per-area dicts under `src/node/i18n/ru/`.
- **Menus**: register actions with `registerMenuAction` only; the Manuscript
  submenu is registered once, centrally. Duplicate `registerSubmenu` calls
  break the menu bar (guarded by flow check AFE-02).
- **Form editors** follow the established pattern (see
  `ai-modes-editor-widget.ts`): open handler at priority 500, comment
  preserving YAML writes that omit derived defaults, `Save*` dirty gating,
  live reload on external changes, problems list localized by validation
  codes.
- **Build steps live in committed scripts** (`scripts/copy-*-assets.mjs`),
  never in `apps/*/esbuild.mjs` — those files are regenerated and gitignored.
- **Secrets**: API keys only in user-scope settings
  (`aiFocusedEditor.ai.apiKeys`), auth secrets only in
  `~/.ai-focused-editor/` or env. Nothing secret in workspace files.
- **Book folders are user data**: the doctor never deletes or rewrites
  wholesale; `.obsidian/` vault state is gitignored.

## PR checklist

- [ ] Tests for new pure logic; suite green (`bun test packages`)
- [ ] Typecheck and build green
- [ ] UI changes verified in the running app (probe or flow pack)
- [ ] New user-facing strings localized (en inline + ru dict)
- [ ] `PROGRESS.md` updated for shipped waves
- [ ] Commits follow the format above and are atomic
