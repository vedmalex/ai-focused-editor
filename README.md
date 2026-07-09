# AI Focused Editor

Theia-based domain IDE for long-form writing, translation, and AI-assisted manuscript work.

This repository starts from the product vision in [`spec.md`](./spec.md) and keeps the first implementation slice intentionally narrow:

- Bun workspaces for reproducible local development.
- A browser-target Theia application in `apps/browser`.
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

## Current Scope

The scaffold targets the first MVP lanes from `spec.md`:

- Platform foundation: custom Theia app plus first-party extension package.
- Manuscript workspace: project convention service interface, not a replacement for Theia workspace/navigator.
- Editor proof: semantic Markdown command placeholders over Theia editor infrastructure.
- AI proof: `ai-connect` adapter boundary intended to connect into Theia AI, not a custom chat clone.
- Quality gates: TypeScript build and deterministic service seams.

Advanced sources, export, deep AI diagnostics, Git history, and full semantic indexing remain post-MVP work.
