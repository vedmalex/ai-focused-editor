---
type: summary
slug: theia-preferences
source: raw/theia-preferences
created_at: 2026-07-09T21:17:23Z
---
# Summary: Preferences

Theia's preferences system lets extensions contribute configuration options, ship default values, resolve values across scopes, and react to preference changes on both frontend and backend. For the AI Focused Editor (`packages/manuscript-workspace`), this is the canonical mechanism for exposing manuscript/AI settings (model choice, timeouts, feature flags, per-language editor overrides) with type-safe access and DI-based registration.

## Preference Scopes and Resolution

Preferences resolve hierarchically from most specific to most general, returning the first match:

1. **Default** — built-in extension values
2. **User** — global user preferences (`$HOME/.theia/settings.json`)
3. **Workspace** — `<workspace-root>/.theia/settings.json`
4. **Folder** — `<folder>/.theia/settings.json` (multi-root workspaces)

The `PreferenceScope` enum (`PreferenceScope.User | .Workspace | .Folder`) on a schema property specifies the **most specific configuration level** where the preference can be written — it controls storage locations, not resolution mechanics. `PreferenceScope.User` → Default+User only; `.Workspace` → Default+User+Workspace; `.Folder` → all scopes; no scope → most permissive (Folder). Best practice: choose the most restrictive scope appropriate.

## Contributing Preferences (4 steps)

1. **Define a `PreferenceSchema`** (JSON-Schema shaped) from `@theia/core/lib/common/preferences`. Properties carry `type`, `default`, `description`, `scope`, `enum`/`enumDescriptions`, `minimum`, and `overridable: true` (for language-specific overrides). Naming pattern: `extensionName.category.setting`.
2. **Create a TS configuration interface** mapping preference keys → types (optional; only needed for the proxy).
3. **Create a preference proxy** via `createPreferenceProxy(preferences, schema)`, typed as `PreferenceProxy<MyConfiguration>` — gives type-safe indexed access.
4. **Register in the DI module**: bind a `PreferenceContribution` and (optionally) the proxy:

```typescript
bind(MyExtensionPreferenceContribution).toConstantValue({ schema: myExtensionPreferenceSchema });
bind(PreferenceContribution).toService(MyExtensionPreferenceContribution);
bind(MyExtensionPreferences).toDynamicValue(ctx => {
    const factory = ctx.container.get<PreferenceProxyFactory>(PreferenceProxyFactory);
    return factory(myExtensionPreferenceSchema);
}).inSingletonScope();
```

## Using Preferences

**Direct access** via injected `PreferenceService`:
- `preferenceService.get('key', defaultValue)` — read (accepts a resource URI as 3rd arg for resource-specific values).
- `preferenceService.set('key', value)` / `set('key', value, PreferenceScope.Folder, folderUri)` — write.
- `preferenceService.onPreferenceChanged(event => { if (event.preferenceName === 'key') ... })` — react. Manage subscriptions with `DisposableCollection`; wire up in `@postConstruct init()`.

**Type-safe access** via proxy: index it directly (`this.preferences['myExtension.timeout']`) and it also exposes `onPreferenceChanged`.

**Important (Theia 1.68+):** `oldValue`/`newValue` were **removed** from `PreferenceChange`/`PreferenceChangeEvent`. Re-read the current value via `PreferenceService.get` or proxy indexing inside the change handler.

## Advanced Features

- **Language-specific overrides**: mark a property `overridable: true`, then users write `"[typescript]": { "editor.tabSize": 2 }` in settings.json.
- **`inspect('key')`**: returns per-scope breakdown — `defaultValue`, `globalValue` (user), `workspaceValue`, `workspaceFolderValue`, and effective `value`.
- **Resource-specific**: pass a file/folder URI to `get`/`set` for per-resource resolution.
- **Programmatic default overrides**: implement `PreferenceContribution.initSchema(schemaService: PreferenceSchemaService)` and call `schemaService.registerOverride('key', 'language', value)`. Schema properties must be registered before override registration.

## Backend Preferences

Since Theia **v1.65.0**, backend supports preferences with limits:
- Only **Default** and **User** scopes are readable from backend; Workspace/Folder are inaccessible.
- Same `PreferenceService` API as frontend.
- Set `scope: PreferenceScope.User` for backend-used prefs to match the limitation. A `.Workspace`-scoped pref still works in backend but only reads Default+User there.
- **Binding pattern**: put schema-binding in a **common module** (`common/my-preferences.ts` exporting `bindMyPreferences(bind)`) imported by both frontend and backend `ContainerModule`s. Frontend and backend read identical preference files — no separate values.
- Advanced: a dedicated backend preference service is possible (`examples/api-samples/src/node/sample-backend-preferences-service.ts`).

## Architecture Notes

- Preference files live in **common** folders shared by frontend and backend.
- `PreferenceSchemaService` distinguishes preference schemas from derived JSON schemas.
- `JSONValue` replaces `any` throughout the API (type safety).
- VS Code preference schemas require conversion to Theia format.

## Key Entities

- `PreferenceService` — core service to get/set/inspect preferences and subscribe to changes (`@theia/core/lib/common/preferences`).
- `PreferenceSchema` — JSON-Schema-shaped definition of an extension's preference properties.
- `PreferenceScope` — enum: `User | Workspace | Folder` (plus Default); sets the most-specific writable scope.
- `PreferenceContribution` — DI contribution point carrying a `schema`; optionally implements `initSchema` for overrides.
- `PreferenceProxy<T>` / `createPreferenceProxy` — type-safe indexed accessor over a config interface.
- `PreferenceProxyFactory` — DI factory that builds a proxy from a schema.
- `PreferenceSchemaService` — registers schema-level default overrides via `registerOverride(key, language, value)`.
- `PreferenceChange` / `PreferenceChangeEvent` — change event; carries `preferenceName` (no oldValue/newValue since 1.68).
- `DisposableCollection` — manages change-listener disposal (`@theia/core/lib/common/disposable`).
- `@theia/core/lib/common/preferences` — package path for all preference APIs.

## Key Claims

- Preferences resolve most-specific-scope-first; first match wins (Folder → Workspace → User → Default).
- A property's `scope` controls where it can be stored, not the read-resolution order.
- No `scope` on a property defaults to the most permissive (Folder) level.
- Since 1.68, change events no longer carry old/new values — handlers must re-read.
- Since 1.65, backend can read only Default and User scopes; Workspace/Folder are frontend-only.
- Schema properties must be registered before calling `registerOverride`.
- Binding preference schemas requires both `bind(PreferenceContribution).toService(...)` and a `toConstantValue({ schema })` (a common misregistration cause of "preferences not appearing").
- Reference implementations: `packages/core/src/common/core-preferences.ts`, `filesystem-preferences.ts`, `workspace-preferences.ts`.

## Open Questions

- How do Theia AI-specific settings (model/agent/prompt config) integrate — do they use this same preferences system or a separate Theia AI settings surface? (Not covered here; check the theia-ai page.)
- What is the exact `PreferenceProxyFactory` symbol/import path for the DI binding snippet? (Snippet uses it without showing its import.)
- Does the manuscript-workspace backend need Workspace-scoped manuscript settings — and if so, how to reconcile with the backend Default/User-only limitation?
- How do preference changes propagate across the frontend/backend RPC boundary at runtime (ordering, latency, consistency)?
- Migration guidance for extensions still reading `oldValue`/`newValue` on change events pre-1.68.
