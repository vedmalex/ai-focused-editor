---
type: concept
slug: preferences-system
created_at: 2026-07-09T21:19:22Z
---
# Preferences System

Theia's preferences system lets an extension contribute type-safe configuration: declare a schema, ship default values, resolve values across scopes, and react to changes on both frontend and backend. It is the canonical mechanism for exposing settings (model choice, timeouts, feature flags, per-language editor overrides) and is registered through [[dependency-injection]] like everything else.

## Scopes and resolution

Preferences resolve most-specific-first, returning the first match: **Default** → **User** (`$HOME/.theia/settings.json`) → **Workspace** (`<root>/.theia/settings.json`) → **Folder** (`<folder>/.theia/settings.json`). A property's `PreferenceScope` (`User | Workspace | Folder`, plus Default) sets the *most specific level it can be written*, not the read order; no scope means the most permissive (Folder).

## Contributing (the wiring that trips people up)

1. Define a `PreferenceSchema` (JSON-Schema shaped, from `@theia/core/lib/common/preferences`); properties carry `type`, `default`, `description`, `scope`, `enum`, `overridable`. Naming pattern `extensionName.category.setting`.
2. Optionally a TS config interface + a proxy via `createPreferenceProxy(...)` typed as `PreferenceProxy<T>` for type-safe indexed access.
3. Register in the DI module — both a `toConstantValue({ schema })` and a `PreferenceContribution` binding are required (missing one is the classic "preferences don't appear" bug).

Read/write through an injected `PreferenceService` (`get`, `set`, `inspect`, `onPreferenceChanged`). **Since Theia 1.68** change events no longer carry `oldValue`/`newValue` — handlers must re-read. **Since 1.65** the backend can read only Default and User scopes; put backend-used prefs in `PreferenceScope.User` and bind the schema in a **common** module so both processes read identical files (see [[frontend-backend-separation]]).

## In This Project

The AI-connection settings the [[language-models|language model]] needs live under the neutral **`aiConnect.*`** namespace (schema owned by `ai-connect-theia`): `aiConnect.endpoints`, `.aliases`, `.activeAlias`, `.pinnedEndpoint`, `.apiKeys` (User scope), `.requestLog`. The legacy `aiFocusedEditor.ai.*` surface was removed from the editor and is one-time-migrated (`common/ai-settings-migration.ts`: a User-scope on-start sweep plus a Book Doctor workspace fix). `packages/manuscript-workspace/src/browser/ai-focused-editor-preferences.ts` still defines `aiFocusedEditorPreferenceSchema` (title "AI Focused Editor", `scope: PreferenceScope.Folder`) for the product prefs that remain — `aiConnect.manuscriptOverview`, `aiFocusedEditor.preview.showTagChips`, `.welcome.showOnStartup`, `.library.path` — and exports `AiFocusedEditorPreferenceContribution`, registered in `manuscript-workspace-frontend-module.ts` via `bind(PreferenceContribution).toConstantValue(AiFocusedEditorPreferenceContribution)`.

These preferences are consumed by `AiProfilePreferenceService`, which `AiConnectTheiaLanguageModel` and `ai-profile-status-bar-contribution.ts` read to resolve the active AI profile. Theia AI's own behavior is tuned through separate `ai-features.*` preferences (e.g. `ai-features.reasoning.defaults`, Copilot enterprise URL).

## Sources

- [theia-preferences](./theia-preferences.md)
- [theia-ai](./theia-ai.md)
