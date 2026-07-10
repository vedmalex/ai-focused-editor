---
type: concept
slug: widgets-and-views
created_at: 2026-07-09T21:19:22Z
---
# Widgets and Views

Everything a Theia [[theia-extensions|extension]] paints in the workbench is a **widget**, and widgets reach the UI through [[contribution-points]] and [[dependency-injection]]. Because a [[theia-extensions|Theia extension]] has full frontend access (unlike a webview-bound VS Code extension), it can add first-class tree views, editors, panels, and status-bar items directly. The docs frame the workbench surface as the composition of core `@theia/*` extensions (`@theia/monaco` for the editor, `@theia/navigator` for the explorer tree, `@theia/messages` for notifications, etc.) plus your own view contributions. Commands and menus (via `CommandContribution` / `MenuContribution`, surfaced through Quick Access / F1) are the entry points that open and drive those views.

## The building blocks

- **`WidgetFactory`** — a contribution supplying `{ id, createWidget() }`; Theia calls it to instantiate a widget lazily by id.
- **View contribution** (`AbstractViewContribution<T>`, bound with `bindViewContribution`) — registers a widget as a toggleable view with a default shell area/rank and a toggle command.
- **`FrontendApplicationContribution`** — the `onStart`/`onStop` lifecycle hook views use to register state.
- **Tree views** — built with `createTreeContainer(...)`, a `LabelProviderContribution` for labels, and a tree model/widget.

## In This Project

`packages/manuscript-workspace/src/browser/manuscript-workspace-frontend-module.ts` registers a rich set of views, all via the mechanisms above:

- **View contributions** (`bindViewContribution`): `ManuscriptTreeViewContribution` (the manuscript tree, `AbstractViewContribution`, default left area, rank 200), `EntityCardsViewContribution`, `SourceLibraryViewContribution`, `SemanticMarkdownPreviewContribution`, `ModelConfigViewContribution`, and `AiDebugViewContribution`.
- **`WidgetFactory`** bindings (via `toDynamicValue`) for each corresponding widget: `ManuscriptTreeWidget` (built through `createManuscriptTreeContainer` / `createTreeContainer`), `SemanticMarkdownPreviewWidget`, `ModelConfigWidget`, `EntityCardsWidget`, `SourceLibraryWidget`, `AiDebugWidget`.
- **Tree support**: `ManuscriptTreeItemFactory`, `ManuscriptTreeLabelProvider` (bound as a `LabelProviderContribution`), `ManuscriptTreeModel`.
- **Status bar**: `AiProfileStatusBarContribution` (a `FrontendApplicationContribution`) shows the active AI profile.
- **Commands/menus**: `ManuscriptWorkspaceCommandContribution` / `...MenuContribution`, plus `BookBuildContribution`, `SemanticMarkdownActionsContribution`, and `AiModeContribution` — see [[contribution-points]].

All of this is frontend-only code (`src/browser`), consistent with [[frontend-backend-separation]].

## Sources

- [theia-composing-applications](./theia-composing-applications.md)
- [theia-authoring-extensions](./theia-authoring-extensions.md)
- [theia-architecture-overview](./theia-architecture-overview.md)
- [theia-services-and-contributions](./theia-services-and-contributions.md)
