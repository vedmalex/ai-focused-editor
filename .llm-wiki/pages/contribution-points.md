---
type: concept
slug: contribution-points
created_at: 2026-07-09T21:19:22Z
---
# Contribution Points

A contribution point is an extensibility hook expressed as an interface: a *defining* extension declares the interface, *contributing* extensions implement it and bind their implementation, and the definer collects every bound implementation and integrates it. Together with services, contribution points are one of the two decoupled mechanisms — both mediated by [[dependency-injection]] — through which Theia extensions interact. There is no central registration list to edit; you simply `bind` your implementation to the well-known interface and Theia aggregates all such bindings at startup.

## Contributing to an existing point

Implement the interface and bind it in a [[theia-extensions|container module]]:

```typescript
@injectable()
export class MyCommandContribution implements CommandContribution { /* ... */ }

// in the container module:
bind(CommandContribution).to(MyCommandContribution);
```

Theia exposes many points via a `*Contribution` naming convention. Common ones seen across the docs: `CommandContribution` (register commands on `CommandRegistry`), `MenuContribution` (register menu actions on `MenuModelRegistry`), `PreferenceContribution` (carry a preference schema — see [[preferences-system]]), `FrontendApplicationContribution` / `BackendApplicationContribution` (lifecycle hooks like `onStart`), `LabelProviderContribution`, and `WidgetFactory` (see [[widgets-and-views]]). Theia AI adds its own: `AIVariableContribution`, `ToolProvider`, `ChatResponsePartRenderer`, `LanguageModelProvider` (see [[theia-ai-agents]]).

## Defining a custom contribution point

Declare an interface, then register it with **`bindContributionProvider(bind, Type)`**. `OpenerService` / `OpenHandler` is the reference pattern. A `ContributionProvider<T>` is a generic container holding every instance bound for type `T`, enabling batch initialization/iteration:

```typescript
bindContributionProvider(bind, ConnectionHandler)

constructor(@inject(ContributionProvider) @named(ConnectionHandler)
  protected readonly handlers: ContributionProvider<ConnectionHandler>) { }
```

## In This Project

`packages/manuscript-workspace` contributes to a wide set of points, almost all bound in `src/browser/manuscript-workspace-frontend-module.ts`:

- `CommandContribution` / `MenuContribution` — `ManuscriptWorkspaceCommandContribution` / `ManuscriptWorkspaceMenuContribution`, plus `BookBuildContribution`, `SemanticMarkdownActionsContribution`, and `AiModeContribution` (each aliased onto both points via `toService`).
- `FrontendApplicationContribution` — `AiProfileStatusBarContribution`, `SemanticMarkdownDecorationService`, `SemanticMarkdownDocumentSymbolProvider`, `AiModePromptFragmentContribution`, and `ManuscriptChatAgentContribution` all use the `onStart()` lifecycle hook to register runtime state.
- `PreferenceContribution` — the AI Focused Editor preference schema.
- `LabelProviderContribution` — `ManuscriptTreeLabelProvider`.
- `AIVariableContribution` — `ManuscriptContextVariableContribution` (see [[context-variables]]).
- `LanguageModelProvider` — supplies `AiConnectTheiaLanguageModel` (see [[language-models]]).
- `TaskContribution` (from `@theia/task`) — `BookBuildContribution` registers book-build tasks; the backend module binds a matching `TaskRunnerContribution`.

On the backend (`src/node/manuscript-workspace-backend-module.ts`), the package contributes `ConnectionHandler`s (the RPC boundary), `BackendApplicationContribution`, and `TaskRunnerContribution`.

## Sources

- [theia-services-and-contributions](./theia-services-and-contributions.md)
- [theia-authoring-extensions](./theia-authoring-extensions.md)
- [theia-architecture-overview](./theia-architecture-overview.md)
- [theia-extensions-vs-plugins](./theia-extensions-vs-plugins.md)
- [theia-ai](./theia-ai.md)
