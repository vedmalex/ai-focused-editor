---
type: summary
slug: theia-extensions-vs-plugins
source: raw/theia-extensions-vs-plugins
created_at: 2026-07-09T21:16:42Z
---
# Summary: Extensions and Plugins - Eclipse Theia

Eclipse Theia offers **four complementary extension mechanisms**, each targeting a different use case and integration level. Choosing the right one is a foundational architectural decision for the AI Focused Editor, whose custom functionality (`packages/manuscript-workspace`, manuscript workspace services, book-build services, AI mode contributions) is delivered primarily as **Theia extensions**.

## The four mechanisms at a glance

| Mechanism | Install time | Runs where | API surface | Frontend access |
|---|---|---|---|---|
| **VS Code extensions** | Runtime (or pre-installed) | Per frontend connection | Defined, *restricted* VS Code API | Backend only (webview for UI) |
| **Theia extensions** | Compile time | Integrated into core app | *Full* Theia API via DI | Yes (direct) |
| **Theia plugins** | Runtime | Per frontend connection | Theia-specific APIs | Yes (direct, no webview abstraction) |
| **Headless plugins** | Runtime | Single Node backend process | Only custom APIs published to them | No frontend scope |

### VS Code extensions
The standard mechanism for language support and features. "Simple to develop and they have access to a defined and restricted API." Can be pre-installed or installed at runtime. The Theia project maintains a **coverage report** of which VS Code APIs are supported. The default marketplace is the **Open VSX registry**.

- **Customizing the marketplace**: set the `VSX_REGISTRY_URL` environment variable to point at custom registries, proxies, or caches. Motivations: limit external network traffic, improve reliability, and support multiple registries via the **OVSX router**.
- Relevant packages: VSX Registry, OVSX Client, OVSX Router config.

### Theia extensions (primary mechanism for this project)
"A Theia extension is a module that resides inside a Theia application and directly communicates with other modules (Theia extensions)." The Theia project itself is **composed entirely of Theia extensions**.

To build an application you: (1) select core extensions from the Theia project, (2) add custom Theia extensions, (3) compile and run.

**Technical model** — extensions are **npm packages** that expose DI modules (`ContainerModule`) contributing to container creation. They are consumed as regular dependencies in `package.json` and installed at **compile time**. This is exactly how `packages/manuscript-workspace` is structured (frontend module, backend module, common protocol). Direct DI communication with core services (no restricted API boundary) is the reason this mechanism is chosen for deep, product-specific behavior and Theia AI integration.

```
// A Theia extension exports InversifyJS ContainerModule(s)
// from its package's frontend/backend module files, e.g.
export default new ContainerModule(bind => { /* bind contributions */ });
```

### Theia plugins
Extend VS Code extensions with Theia-specific functionality while keeping a similar architecture. Key difference: "Theia plugins can also directly contribute to the frontend while VS Code extensions are restricted to the backend" — enabling direct UI manipulation **without the webview abstraction**. Caveat: **Theia plugin support is currently under discussion**, and the docs **recommend using VS Code extensions or Theia extensions instead**.

### Headless plugins
Run exclusively in the Node backend, outside any frontend connection scope. Use cases: CLI interactions without a browser frontend, extending application-specific backend services, and publishing custom backend services. "They are not provided with a default API for access to the backend Theia services but have access only to custom APIs published explicitly to them."

## Architecture / runtime topology
- VS Code extensions and Theia plugins run **per frontend connection**.
- Headless plugins run in a **single backend process**.
- Theia extensions integrate **directly into the core application**.

## Key Entities
- **Theia extension** — compile-time npm package exposing DI `ContainerModule`(s); full-API, product-specific integration mechanism.
- **VS Code extension** — runtime-installable extension against the restricted VS Code API; frontend via webview only.
- **Theia plugin** — runtime plugin with direct frontend contribution via Theia-specific APIs (support under discussion).
- **Headless plugin** — backend-only runtime plugin with access only to explicitly published custom APIs.
- **`ContainerModule`** — InversifyJS DI module that a Theia extension exports to contribute bindings to the app container.
- **Open VSX registry** — default marketplace for VS Code extension discovery in Theia.
- **`VSX_REGISTRY_URL`** — env var overriding the extension marketplace endpoint.
- **OVSX Router / OVSX Client / VSX Registry** — packages enabling multi-registry, proxy, and cache configurations.
- **VS Code API coverage report** — Theia's documentation of supported VS Code APIs.

## Key Claims
- Theia supports four extension mechanisms; they differ on install-time, runtime scope, API breadth, and frontend access.
- The Theia project (its whole IDE core) is itself composed entirely of Theia extensions.
- Theia extensions are npm packages installed at **compile time** and wire into the app via **dependency injection** (`ContainerModule`), giving them full API access and direct module-to-module communication.
- VS Code extensions get only a defined, **restricted** API and (unlike Theia extensions/plugins) cannot directly contribute to the frontend — UI goes through webviews.
- Theia plugins can contribute directly to the frontend without webview abstraction, but their support is **under discussion** and not recommended over VS Code/Theia extensions.
- Headless plugins have **no default backend Theia API**; they see only custom APIs explicitly published to them, and run in a single backend process.
- Open VSX is the default marketplace; `VSX_REGISTRY_URL` and the OVSX router allow custom/multi registry setups.

## Open Questions
- The page gives no concrete API detail for **how a Theia extension registers contribution points** (e.g. `CommandContribution`, `MenuContribution`, `bindContribution`) — needed for `manuscript-workspace` contributions; must be sourced from other pages.
- No guidance on **Theia AI** specifics (agents, prompt fragments, tool functions) despite AI being central to this project — that knowledge lives on the "Using AI Features" page linked in navigation.
- Does not specify how **frontend vs backend vs common** modules of a single extension are separated or bound (the `src/browser`, `src/node`, `src/common` split used in this repo).
- Unclear whether the AI Focused Editor should ever expose **headless plugin** APIs (e.g. for the book-build CLI in `src/node/book-build-task-cli.ts`) versus keeping that logic inside a Theia extension backend service.
- No detail on the **RPC/JSON-RPC protocol** wiring between frontend and backend Theia extensions (relevant to `manuscript-workspace-protocol.ts` and `book-build-protocol.ts`).
- The exact boundary/tradeoffs between shipping features as bundled **VS Code extensions** vs native **Theia extensions** for a custom product are asserted but not quantified.
