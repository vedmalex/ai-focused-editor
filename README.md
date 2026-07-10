# AI Focused Editor

Theia-based domain IDE for long-form writing, translation, and AI-assisted manuscript work.

This repository starts from the product vision in [`spec.md`](./spec.md) and keeps the first implementation slice intentionally narrow:

- Bun workspaces for reproducible local development.
- A browser-target Theia application in `apps/browser`.
- An Electron desktop Theia application in `apps/electron`.
- One first-party compile-time Theia extension in `packages/manuscript-workspace`.
- Service boundaries and command contribution points for the first MVP proof.
- Existing Theia infrastructure remains the default for editor, Monaco, navigator, preferences, commands, menus, status bar, workspace, files, markers, and AI chat surfaces.
- AI provider calls are routed through `@vedmalex/ai-connect` behind a service boundary.

## Requirements

- Bun `1.3.x`
- Node compatible with the installed Theia toolchain

## Commands

```sh
bun install
bun run build
bun run start
```

The browser application starts through Theia's backend server. By default Theia serves the UI on `http://localhost:3000`.

Additional useful commands:

```sh
bun run start:browser
bun run start:electron
bun run build:electron
bun run test:ui
bun run verify
```

## Current Scope

The scaffold targets the first MVP lanes from `spec.md`:

- Platform foundation: custom Theia app plus first-party extension package.
- Manuscript workspace: project convention service interface, not a replacement for Theia workspace/navigator.
- Editor proof: semantic Markdown command placeholders over Theia editor infrastructure.
- AI proof: `ai-connect` adapter boundary connected into Theia AI/chat, prompt fragments, and reviewable Change Set diffs.
- Build proof: manifest-driven Markdown and HTML export run through the shared book-build service; Theia Task/Terminal integration is wired for user-facing build commands.
- Quality gates: TypeScript build, deterministic service seams, and a Playwright browser smoke covering startup, status bar, domain commands, and core views.

Deep source indexing, EPUB/PDF export, AI diagnostics, semantic Git history, and form-based entity editors remain post-MVP work.
