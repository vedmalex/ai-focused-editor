---
type: concept
slug: frontend-backend-separation
created_at: 2026-07-09T21:19:22Z
---
# Frontend / Backend Separation

Theia runs one codebase across desktop (Electron), browser, and remote-server targets by splitting execution into **two separate processes**: a **frontend** (client/UI, browser platform) and a **backend** (Node.js). They communicate via **JSON-RPC over WebSockets** (or REST over HTTP). In Electron both run locally; in the browser/remote case the backend runs on a remote host and the browser hosts the frontend. This split is by *process*, not by product — the same application logic serves every target.

The load-bearing consequence for extension authors: **each process owns its own [[dependency-injection]] container.** A [[theia-extensions|Theia extension]] contributes a separate `ContainerModule` to the frontend container and/or the backend container.

## Platform rules

- **Frontend** may assume a browser platform (DOM API) but **must not** assume Node.js. Boots via `FrontendApplication.start()` after all contributing DI modules load.
- **Backend** runs on Node.js (express HTTP server) and **must not** use DOM/browser APIs. Boots via `BackendApplication.start(port)`. By default the backend also serves the frontend code to the client.

## Folder convention

Inside an extension, source is separated into platform layers tied to allowed runtime dependencies:

- `common/` — **no runtime dependency**: shared protocol/types, JSON-RPC service interfaces, DI symbols. Safe to import from both processes.
- `browser/` — frontend code needing a modern browser (DOM).
- `electron-browser/` — frontend code needing DOM **plus** Electron renderer APIs.
- `node/` — backend code needing Node.js.
- `node-electron/` — backend code for Electron's main/backend process.

The pattern for a cross-process service: declare its interface + RPC path in `common/`, implement the frontend side in `browser/` (often a proxy created with `ServiceConnectionProvider.createProxy`), and the real implementation in `node/`, exposed via an `RpcConnectionHandler` bound as a `ConnectionHandler`.

## In This Project

`packages/manuscript-workspace` follows the convention exactly with `src/common`, `src/browser`, `src/node`:

- `src/common/` holds the protocol interfaces and RPC path symbols — e.g. `manuscript-workspace-protocol.ts`, `book-build-protocol.ts`, `ai-connection-protocol.ts`, and the `*ServicePath` constants (`BookBuildServicePath`, `LocalAiConnectionServicePath`, `ManuscriptWorkspaceBackendServicePath`).
- `src/browser/` binds proxies to those paths via `ServiceConnectionProvider.createProxy(ctx.container, …ServicePath)` — so the frontend calls Node services as if local. All AI UI (chat agent, context variable, status bar, widgets) lives here because it needs the browser.
- `src/node/` implements the privileged work: `NodeBookBuildService` (spawns build tooling), `NodeManuscriptWorkspaceService` (filesystem), `NodeLocalAiConnectionService`. Each is exposed through an `RpcConnectionHandler` bound as a `ConnectionHandler` in `manuscript-workspace-backend-module.ts`.

Rule of thumb applied here: anything that touches the filesystem, spawns processes (book build / CLI in `src/node/book-build-task-cli.ts`), or serves models belongs in `node/`; the frontend reaches it only through a `common/`-declared RPC service.

## Sources

- [theia-architecture-overview](./theia-architecture-overview.md)
- [theia-services-and-contributions](./theia-services-and-contributions.md)
- [theia-extensions-vs-plugins](./theia-extensions-vs-plugins.md)
- [theia-preferences](./theia-preferences.md)
- [theia-platform-overview](./theia-platform-overview.md)
