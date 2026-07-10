---
type: concept
slug: dependency-injection
created_at: 2026-07-09T21:19:22Z
---
# Dependency Injection

Dependency injection (DI) is the mechanism through which every part of a Theia application is wired together. Theia uses **InversifyJS**: instead of a class constructing its collaborators, it declares what it needs and the DI **container** resolves and supplies them, including all transitive dependencies. This is the single most load-bearing pattern in the whole framework — [[theia-extensions]], [[contribution-points]], services, [[widgets-and-views]], [[preferences-system]], and all [[theia-ai-agents]] machinery are registered and consumed through it.

## Core mechanics

- A class that participates in DI must be decorated `@injectable()`. Only objects the container itself instantiates can receive injected dependencies.
- Dependencies are pulled in with `@inject(Id)` on a constructor parameter or a class field. `@named(Name)` selects a named/provider binding.
- The DI **identifier symbol** usually shares the name of the service interface (e.g. `MessageService` is both the type and the injection token).
- Bindings are declared inside a **container module** (InversifyJS `ContainerModule`), the unit a [[theia-extensions|Theia extension]] default-exports:
  - `bind(Interface).to(Impl)` — bind an implementation class.
  - `bind(X).toSelf()` — bind a class to itself.
  - `bind(X).toService(Y)` — alias one token to an already-bound class (so one instance serves several tokens).
  - `bind(X).toConstantValue(v)` / `rebind(X).toConstantValue(v)` — supply a fixed value or override a default.
  - `bind(X).toDynamicValue(ctx => …)` — compute the value from the container at resolution time.
  - `.inSingletonScope()` — one shared instance for the whole container.

Benefits called out in the docs: consumers never manually instantiate dependencies, implementations can be swapped without touching consumers, transitive dependencies resolve automatically, and wiring is configuration-driven through container modules.

## Two containers

A crucial fact for extension authors: **each process owns its own DI container** — a frontend (browser) container and a backend (Node) container. An extension contributes a separate `ContainerModule` to each. See [[frontend-backend-separation]].

## In This Project

`packages/manuscript-workspace` has two container modules, exactly matching the two-container model:

- `src/browser/manuscript-workspace-frontend-module.ts` — the frontend `ContainerModule`. It uses the full range of binding forms: `bind(...).to(...).inSingletonScope()` for services (`BrowserManuscriptWorkspaceService`, `BrowserAiConnectionService`), `toService(...)` to alias a single class onto several tokens (e.g. `BookBuildContribution` is bound to `CommandContribution`, `MenuContribution`, and `TaskContribution`), `toConstantValue(...)` for the preference schema, and `toDynamicValue(...)` to build RPC proxies and widget factories.
- `src/node/manuscript-workspace-backend-module.ts` — the backend `ContainerModule`. It binds Node services (`NodeBookBuildService`, `NodeManuscriptWorkspaceService`) and `ConnectionHandler`s that expose them over RPC.

Every contribution/service class in the package is `@injectable()` and receives its collaborators through `@inject(...)` (e.g. `ManuscriptContextVariableContribution` injects `ManuscriptAiContextAssembler`; `AiConnectTheiaLanguageModel` injects `AiConnectionService`, `AiProfilePreferenceService`, and `AiHistoryService`).

## Sources

- [theia-services-and-contributions](./theia-services-and-contributions.md)
- [theia-architecture-overview](./theia-architecture-overview.md)
- [theia-authoring-extensions](./theia-authoring-extensions.md)
- [theia-extensions-vs-plugins](./theia-extensions-vs-plugins.md)
- [theia-ai](./theia-ai.md)
- [theia-preferences](./theia-preferences.md)
