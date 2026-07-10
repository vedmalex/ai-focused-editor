---
type: summary
slug: theia-composing-applications
source: raw/theia-composing-applications
created_at: 2026-07-09T21:16:38Z
---
# Summary: Build Your Own IDE/Tool (Composing Applications)

Theia is a framework for building custom IDE-style applications and developer tools. It is "independently developed with a modular architecture and is NOT a fork of VS Code." A Theia application is assembled from modular npm packages called **extensions**; you compose an app by declaring the extensions you want as dependencies of a thin *app* package. This page covers scaffolding, project layout, browser vs. electron targets, and the bundler options — the foundation on which our custom `manuscript-workspace` extension is layered.

## Getting Started: Two Entry Points

- **Theia Yeoman Generator** (`generator-theia-extension`): scaffolds a Theia app plus an example extension. Recommended starting point for new Theia developers.
- **Theia IDE**: a production-ready app used as a template for installable desktop products (auto-update, custom branding).

Prerequisites: **Node.js 18+** and **yarn 1.7.0+** (yarn `>=1.7.0 <2`).

## Composition Model (the core idea)

An app is composed by *listing extensions as dependencies*. You never fork Theia; you:
1. Reuse existing `@theia/*` extensions for common IDE functionality (editor, filesystem, terminal, etc.).
2. Integrate arbitrary VS Code extensions.
3. Add custom features via your own Theia extensions (this is where `packages/manuscript-workspace` fits).

The `theia` field in an app's `package.json` selects the build **target**:
```json
"theia": { "target": "browser" }   // or "electron"
```

## Project Structure

The generator produces a Lerna/yarn-workspaces monorepo:
```
my-theia-app/
├── browser-app/      # app package, target: browser
├── electron-app/     # app package, target: electron
├── hello-world/      # example custom extension
├── package.json      # workspaces + build/watch scripts
└── lerna configuration
```
This mirrors our repo (`apps/browser`, `apps/electron`, and extension packages under `packages/`).

Root `package.json` declares `workspaces` and orchestrates builds; scripts delegate into each app package via `yarn --cwd <app>` and run watch across packages with `lerna run --parallel watch`:
```json
"scripts": {
  "build:browser":  "yarn --cwd browser-app bundle",
  "start:browser":  "yarn --cwd browser-app start",
  "watch:browser":  "lerna run --parallel watch --ignore electron-app"
}
```

## Browser App

Scaffold:
```bash
npm install -g yo generator-theia-extension
mkdir my-theia-app && cd my-theia-app
yo theia-extension
```
The `browser-app/package.json` lists the core Theia extensions that make up a usable IDE: `@theia/core`, `@theia/editor`, `@theia/filesystem`, `@theia/markers`, `@theia/messages`, `@theia/monaco`, `@theia/navigator`, `@theia/preferences`, `@theia/process`, `@theia/terminal`, `@theia/workspace`, plus the custom `hello-world` extension. Build scripts wrap the **`theia` CLI**:
```json
"scripts": {
  "bundle": "yarn rebuild && theia build --mode development",
  "start":  "theia start",
  "watch":  "yarn rebuild && theia build --watch --mode development"
}
```
Run with `yarn build:browser` then `yarn start:browser`; the app serves at `http://localhost:3000`. The generated hello-world extension registers a test **command** reachable via **F1 (Quick Access)** — the canonical smoke test that an extension's contributions are wired in.

## Electron App

Identical to the browser app except `"theia": { "target": "electron" }`. Run via `yarn build:electron` / `yarn start:electron`.

## Bundlers: Webpack vs esbuild

- **Webpack** — the historical default, now being deprecated.
- **esbuild** — ~10× faster; recommended for new projects.

Migration: delete `webpack.config.js`; the build auto-generates `esbuild.mjs` on the next build. (See the ESBuild section of the Theia Migration Guide for full steps.)

## Troubleshooting

Native deps (e.g. **oniguruma**) failing behind a proxy with node-gyp errors: download the node-headers tarball named in the error and pass it via env var:
```bash
npm_config_tarball=/path/to/node-headers.tar.gz yarn install
```

## Key Entities

- **`@theia/core`** — foundational package: DI container, contribution points, command/menu/keybinding registries; every extension depends on it.
- **`@theia/editor`** — editor abstraction layer.
- **`@theia/monaco`** — Monaco-based text editor integration (the actual code editor widget).
- **`@theia/filesystem`** — filesystem access API.
- **`@theia/workspace`** — workspace/root-folder management.
- **`@theia/navigator`** — file explorer / tree view.
- **`@theia/preferences`** — user/workspace settings system.
- **`@theia/markers`** — problem/diagnostic markers.
- **`@theia/messages`** — notification/message service.
- **`@theia/process`** / **`@theia/terminal`** — process spawning and integrated terminal.
- **`generator-theia-extension`** (Yeoman `yo theia-extension`) — scaffolds apps and extensions.
- **`theia` CLI** — build/start/watch commands (`theia build`, `theia start`, `--mode`, `--watch`).
- **Lerna + yarn workspaces** — monorepo tooling gluing app + extension packages.
- **`package.json "theia": { target }`** — declares `browser` vs `electron` build target.

## Key Claims

- A Theia app is *composed* by listing extensions as npm dependencies; there is no fork of Theia or VS Code.
- Theia is independently developed, modular, and NOT a fork of VS Code (distinct from Code-OSS-based tools).
- The standard project is a Lerna/yarn-workspaces monorepo with separate `browser-app` and `electron-app` packages sharing the same extensions.
- Browser and electron builds differ only by the `theia.target` field — the same extension code runs on both.
- The `theia` CLI (`theia build`/`start`/`watch`) drives all bundling; `--mode development` and `--watch` are the common flags.
- A minimally-usable IDE requires the core extension set (`@theia/core`, `editor`, `monaco`, `filesystem`, `workspace`, `navigator`, `preferences`, `markers`, `messages`, `process`, `terminal`).
- esbuild is the recommended bundler going forward (~10× faster than the deprecated Webpack); switching is done by deleting `webpack.config.js`.
- Requires Node 18+ and yarn 1.x (`>=1.7.0 <2`) — yarn 2/Berry is not the supported line.
- Custom commands from an extension surface through Quick Access (F1) once contributed.

## Open Questions

- This page does not explain the **extension internals** relevant to `manuscript-workspace`: dependency injection wiring, `ContainerModule`/frontend & backend module files, or the concrete contribution interfaces (`CommandContribution`, `MenuContribution`, `FrontendApplicationContribution`, etc.) — those live in the Extension Authoring / Extensions Reference docs linked at the end.
- No coverage of **Theia AI** (agents, prompt fragments, AI profiles) — directly relevant to our AI Focused Editor but out of scope here.
- Unclear how our repo's structure (`apps/browser`, `apps/electron`, `packages/*` under Bun) maps to the yarn/Lerna assumptions; the project uses `bun.lock`, so the yarn-specific scripts here may not apply verbatim.
- Does not describe how backend (node) vs frontend (browser) contributions are split within a single extension.
- No guidance on packaging/branding a distributable product beyond a pointer to the Theia IDE template.
