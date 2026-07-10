---
type: summary
slug: theia-architecture-overview
source: raw/theia-architecture-overview
created_at: 2026-07-09T21:16:42Z
---
# Summary: Architecture Overview

Theia runs a single codebase across three deployment targets — native desktop (Electron), browser, and remote server — by splitting execution into **two separate processes**: a **frontend** (client/UI) and a **backend** (Node.js). The two communicate via **JSON-RPC over WebSockets** or **REST over HTTP**. In Electron both processes run locally; in the remote/browser case the backend runs on a remote host and the browser hosts the frontend.

The load-bearing architectural fact for extension authors: **each process owns its own dependency-injection (DI) container**, and extensions contribute to these containers by registering **DI modules** (InversifyJS `ContainerModule`s). There is a frontend DI container and a backend DI container; a given extension may contribute to either or both.

## Process model

**Frontend process** — represents the client and renders the UI. In the browser it runs in the render loop; in Electron it runs inside an Electron Window (a browser augmented with Electron + Node.js APIs). Rule of thumb: **frontend code may assume a browser platform (DOM API) but must NOT assume Node.js.** Startup sequence: load the DI modules of all contributing extensions → obtain a `FrontendApplication` instance → call `start()` on it.

**Backend process** — runs on Node.js, uses **express** as the HTTP server. Backend code **must not use DOM/browser APIs**. Startup sequence: load DI modules of all contributing extensions → obtain a `BackendApplication` instance → call `start(portNumber)`. By default the backend's express server **also serves the frontend code** to the client.

## Separation by platform (folder convention)

Inside an extension's top folder, source is separated into platform layers. This convention is enforced by what runtime each folder may depend on:

- `common/` — code with **no runtime dependency** (shared protocol/types, JSON-RPC service interfaces, DI symbols). Safe to import from both processes.
- `browser/` — frontend code requiring a modern browser (DOM API).
- `electron-browser/` — frontend code needing DOM **plus** Electron renderer-process APIs.
- `node/` — backend code requiring Node.js.
- `node-electron/` — backend code specific to Electron's main/backend process.

For the AI Focused Editor, `packages/manuscript-workspace` already follows this: `src/common`, `src/browser`, `src/node` — protocol interfaces live in `common`, DI-contributed frontend widgets/services in `browser`, and Node services (file/build) in `node`. Cross-process services should declare their interface + RPC path in `common` and implement each side in `browser`/`node`.

## Relevance to a custom domain IDE

- New capabilities are added as **extensions that contribute DI modules** to the frontend and/or backend container at startup — this is the seam through which contribution points, services, and Theia AI agents are registered.
- Any service that must run on Node (filesystem, spawning build tools, model backends) belongs in `node/` and is exposed to the frontend through a JSON-RPC service declared in `common/`.
- Theia AI agents/tools follow the same DI-contribution model; frontend-visible AI UI lives under `browser/`, while privileged/model-serving work belongs backend-side.

## Key Entities

- `FrontendApplication` — root frontend object; `start()` boots the UI after DI modules load.
- `BackendApplication` — root backend object; `start(portNumber)` boots the Node server.
- Frontend DI container — InversifyJS container for the client process; extensions contribute DI modules to it.
- Backend DI container — InversifyJS container for the Node process; extensions contribute DI modules to it.
- express — HTTP server used by the backend; also serves frontend assets by default.
- JSON-RPC over WebSocket — primary frontend↔backend communication channel.
- `common/` `browser/` `electron-browser/` `node/` `node-electron/` — per-extension platform-separation folders.

## Key Claims

- Theia supports desktop, browser, and remote from one source by running frontend and backend as two processes.
- Frontend and backend each have their own DI container; extensions contribute DI modules to them.
- Frontend↔backend communication is JSON-RPC over WebSockets or REST over HTTP.
- Frontend code may assume a browser (DOM) but not Node.js; backend code may assume Node.js but not DOM.
- Startup order is always: load all contributing extensions' DI modules first, then construct and `start()` the application object.
- The backend uses express and by default also serves the frontend code.
- In Electron, both processes run locally; the Electron Window is a browser with extra Electron/Node APIs.
- Platform separation is a folder convention (`common`/`browser`/`electron-browser`/`node`/`node-electron`) tied to allowed runtime dependencies.

## Open Questions

- Concrete API for registering a DI module (`ContainerModule`, `bind(...)` patterns) is not shown here — see the extension-authoring page.
- How exactly a `common/` JSON-RPC service is wired (proxy factory, connection handler, path binding) is not covered on this page.
- Where Theia AI agents/tool-invocation register in the DI lifecycle relative to `FrontendApplication.start()` is unspecified here.
- No detail on `FrontendApplicationContribution` / `BackendApplicationContribution` lifecycle hooks (referenced elsewhere, not here).
- How the manuscript-workspace build/CLI services should be split between `node` RPC services vs. in-process backend contributions is not addressed by this overview.
