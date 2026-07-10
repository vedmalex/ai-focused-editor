---
type: summary
slug: theia-authoring-extensions
source: raw/theia-authoring-extensions
created_at: 2026-07-10T21:16:42Z
---
# Summary: Authoring Theia Extensions

This page is the canonical "how to build a custom Theia extension" walkthrough, built around a minimal "Say Hello" example that registers a command + menu item showing a notification. It is the direct template for how `packages/manuscript-workspace` (and any future AI Focused Editor package) is structured: a Theia extension is an npm package with a specific `package.json` shape plus InversifyJS `ContainerModule` entrypoints wired through dependency injection.

## Extension package shape

An extension is an ordinary npm package that declares itself to Theia via two things in `package.json`:

- The `"theia-extension"` **keyword** — used for automated discovery of packages that are Theia extensions.
- The `"theiaExtensions"` **array** — each entry maps a component target (`frontend` and/or `backend`) to a JS module path that default-exports an InversifyJS `ContainerModule`:

```json
"theiaExtensions": [
  { "frontend": "lib/browser/hello-world-frontend-module" }
]
```

`frontend` modules contribute UI features (browser DI container); `backend` modules contribute node-side features (e.g. language servers). Depends on `@theia/core`. Build is plain `tsc` (`build`, `watch`, `clean` via `rimraf`), and `prepare` runs clean+build so the compiled `lib/` is present when consumed.

## Dependency injection entrypoint

The module referenced in `theiaExtensions` default-exports a `ContainerModule` whose callback binds contribution implementations to Theia contribution interfaces:

```javascript
export default new ContainerModule(bind => {
    bind(CommandContribution).to(HelloWorldCommandContribution);
    bind(MenuContribution).to(HelloWorldMenuContribution);
});
```

This is the wiring seam: you bind your `@injectable()` class to a well-known contribution interface, and Theia collects all bindings of that interface at startup. The AI Focused Editor's frontend/backend modules (`manuscript-workspace-frontend-module.ts`, `manuscript-workspace-backend-module.ts`) follow exactly this pattern.

## Commands

A command is a plain data object (`id` + `label`); behavior lives in a handler registered by a `CommandContribution`:

```javascript
export const HelloWorldCommand = { id: 'HelloWorld.command', label: "Shows a message" };

@injectable()
export class HelloWorldCommandContribution implements CommandContribution {
    constructor(@inject(MessageService) private readonly messageService: MessageService) {}
    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(HelloWorldCommand, {
            execute: () => this.messageService.info('Hello World!')
        });
    }
}
```

`@inject(MessageService)` resolves the dependency from the container — the class never worries about lifecycle or construction of injected services.

## Menus

To surface a command in the UI, implement `MenuContribution` and register a menu action against a menu path (Theia ships `CommonMenus` constants like `CommonMenus.EDIT_FIND`):

```javascript
@injectable()
export class HelloWorldMenuContribution implements MenuContribution {
    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.EDIT_FIND, {
            commandId: HelloWorldCommand.id,
            label: 'Say Hello'
        });
    }
}
```

## Consuming and deploying an extension

A Theia application consumes an extension simply by listing it as a dependency in the app's `package.json` (alongside `@theia/core`), with `@theia/cli` as a devDependency and a `"theia": { "target": "browser" }` block. App scripts use the Theia CLI: `theia rebuild:browser`, `theia build --mode development`, `theia start`, `theia build --watch`.

Two deployment strategies:
1. **Monorepo** — the extension lives in the same repo as the Theia app that imports it (this is how the AI Focused Editor is laid out: `apps/browser`, `apps/electron` consume `packages/*`).
2. **NPM publishing** — `yarn publish` the extension and consume it as a normal versioned dependency.

Scaffolding is normally done with the Yeoman [`generator-theia-extension`](https://github.com/eclipse-theia/generator-theia-extension).

## Key Entities

- `@theia/core` — base package every extension depends on; supplies the contribution interfaces and core services.
- `theiaExtensions` (package.json) — array mapping `frontend`/`backend` targets to `ContainerModule` module paths.
- `"theia-extension"` keyword — marks a package for Theia extension auto-discovery.
- `ContainerModule` (InversifyJS) — default-exported DI module where contribution bindings are declared.
- `CommandContribution` — interface implemented to register commands (`registerCommands(registry)`).
- `CommandRegistry` — registry passed to `registerCommands`; `registerCommand(command, handler)`.
- `MenuContribution` — interface implemented to add menu entries (`registerMenus(menus)`).
- `MenuModelRegistry` — registry for menu actions; `registerMenuAction(menuPath, action)`.
- `CommonMenus` — constants for standard menu locations (e.g. `EDIT_FIND`).
- `MessageService` — injectable service for notifications (`.info(...)`, etc.).
- `@injectable()` / `@inject()` — InversifyJS decorators for DI-managed classes and constructor injection.
- `@theia/cli` — provides `theia build`/`start`/`rebuild:browser` commands for the app.
- `generator-theia-extension` — Yeoman generator to scaffold a new extension.

## Key Claims

- A Theia extension is a normal npm package; Theia discovers it via the `"theia-extension"` keyword and loads its DI modules via the `theiaExtensions` package.json property.
- Extensions integrate purely through dependency injection: you bind an `@injectable()` implementation to a Theia contribution interface, and Theia aggregates all such bindings at startup — there is no central registration list to edit.
- Each `theiaExtensions` entry targets `frontend` (browser UI container) or `backend` (node container); a single extension can contribute to both by supplying both keys.
- Commands are decoupled data (`id`+`label`) from behavior (the handler's `execute`); menus reference commands only by `commandId`, so UI placement and command logic are independently defined.
- Theia exposes many extension points via a `*Contribution` naming convention; `CommandContribution` and `MenuContribution` are just two examples of the broader "Platform Concepts & APIs" surface.
- Consuming an extension requires no special manifest edit beyond adding it as a dependency of the Theia app package — the build pipeline (`theia rebuild`/`build`) picks up all `theia-extension` packages in the dependency tree.

## Open Questions

- This page covers only frontend `CommandContribution`/`MenuContribution`; it does not enumerate the full `*Contribution` catalog (widgets, views, keybindings, preferences, frontend-application lifecycle) that `manuscript-workspace` actually needs — those live in the "Platform Concepts & APIs" section (see `theia-services-and-contributions`, `theia-platform-overview`).
- No coverage of the frontend↔backend RPC/JSON-RPC protocol mechanism, which the AI Focused Editor uses (e.g. `book-build-protocol`, `manuscript-workspace-protocol`) — how a backend service is exposed to the frontend is out of scope here.
- Nothing on Theia AI extension authoring (agents, prompt fragments, tool/function contributions) despite that being central to an "AI Focused Editor" — see the `theia-ai` page.
- The example uses `yarn`; the repo uses `bun` (see `bun.lock`). Whether Theia's build tooling (`theia rebuild`) works cleanly under bun is not addressed.
- Dependencies are pinned to `"latest"` in the example — real projects must resolve concrete, mutually compatible `@theia/*` versions; version-matching guidance is absent.
- No discussion of extension vs plugin trade-offs here (deferred to `theia-extensions-vs-plugins`).
