---
type: concept
slug: theia-extensions
created_at: 2026-07-09T21:19:22Z
---
# Theia Extensions

A Theia extension is a modular **npm package** that resides inside a Theia application and communicates directly with other modules through [[dependency-injection]]. The Theia project itself — its entire IDE core — is composed entirely of Theia extensions. You build a product not by forking Theia but by *composing* it: select the core `@theia/*` extensions you want, add your own custom extensions, compile, and run. This is the primary extension mechanism for deep, product-specific behavior, because unlike VS Code extensions it has **full** Theia API access and can contribute directly to the frontend without a webview boundary.

## Package shape

An extension declares itself to Theia via two things in `package.json`:

- The `"theia-extension"` **keyword** — used for automated discovery.
- The `"theiaExtensions"` **array** — each entry maps a component target (`frontend` and/or `backend`) to a JS module path that default-exports an InversifyJS `ContainerModule`:

```json
"theiaExtensions": [
  { "frontend": "lib/browser/hello-world-frontend-module" },
  { "backend":  "lib/node/hello-world-backend-module" }
]
```

Each `ContainerModule` is the wiring seam: it binds `@injectable()` classes to Theia [[contribution-points]]. A single extension can contribute to both the frontend (browser) and backend (Node) containers by supplying both keys — see [[frontend-backend-separation]]. Extensions are installed at **compile time** (listed as ordinary `package.json` dependencies), depend on `@theia/core`, and are consumed by an app simply by adding them to the app package's dependencies — the `theia build` pipeline picks up every `theia-extension` in the dependency tree.

## The four mechanisms

Theia offers four complementary extension mechanisms; Theia extensions are one:

| Mechanism | Install time | API surface | Frontend access |
|---|---|---|---|
| **Theia extension** | Compile time | Full Theia API via DI | Yes (direct) |
| **VS Code extension** | Runtime | Restricted VS Code API | Backend only (webview UI) |
| **Theia plugin** | Runtime | Theia-specific API | Direct (support under discussion) |
| **Headless plugin** | Runtime | Only explicitly published custom APIs | No frontend |

## In This Project

The AI Focused Editor delivers its custom functionality as Theia extensions. `packages/manuscript-workspace` is the principal one: its `package.json` declares the `theia-extension` keyword and a `theiaExtensions` array pointing at `lib/browser/manuscript-workspace-frontend-module` and `lib/node/manuscript-workspace-backend-module`. The apps under `apps/browser` and `apps/electron` are the thin *app* packages that consume it — the same extension code runs on both, the only difference being the `theia.target` (`browser` vs `electron`) field. The repo is a monorepo (managed with `bun`), mirroring the standard Lerna/yarn-workspaces layout the docs describe.

## Sources

- [theia-extensions-vs-plugins](./theia-extensions-vs-plugins.md)
- [theia-authoring-extensions](./theia-authoring-extensions.md)
- [theia-composing-applications](./theia-composing-applications.md)
- [theia-platform-overview](./theia-platform-overview.md)
- [theia-architecture-overview](./theia-architecture-overview.md)
