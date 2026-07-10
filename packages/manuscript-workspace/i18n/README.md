# Localization (i18n) — manuscript-workspace

English is the **source of truth in code**. Every user-facing string stays inline
in the `.ts` file as the `nls` default value; Russian lives in JSON dictionaries
that a node-side `LocalizationContribution` registers with `@theia/core`.

## Key convention

```
ai-focused-editor/<area>/<slug>
```

- `<area>` — the feature slice, matching the dictionary filename (`manuscript-tree`,
  `menu`, `book-build`, `sources`, …). One area = one JSON file.
- `<slug>` — kebab-case identifier for the string (`new-chapter`, `move-failed`).
- Placeholders use Theia's `{0}`, `{1}` syntax (positional args to `nls.localize`).

## Where the files live

| What | Path |
|------|------|
| ru dictionaries (one per area) | `src/node/i18n/ru/<area>.json` |
| registration contribution | `src/node/i18n/manuscript-ru-localization-contribution.ts` |
| binding | `src/node/manuscript-workspace-backend-module.ts` (`bind(LocalizationContribution)`) |

> The JSONs live under `src/` (not the package-root `i18n/`) because the package
> `tsconfig.json` sets `rootDir: "src"` — an import from outside `src` breaks the
> compile. The build (`package.json` `build` script) copies `src/node/i18n/ru/*.json`
> into `lib/node/i18n/ru/` so the compiled contribution can `require` them, and the
> browser/electron `theia build` (webpack) inlines them into the backend bundle.

## Per-area JSON layout (what a downstream agent authors)

Each area file is **self-contained** and carries the FULL key path, so parallel
agents never edit the same file and the merge is order-independent:

```jsonc
// src/node/i18n/ru/<area>.json
{
  "ai-focused-editor": {
    "<area>": {
      "<slug>": "Русский перевод",
      "with-placeholder": "Не удалось: {0}"
    }
  }
}
```

To add a new area file, also add two lines to
`manuscript-ru-localization-contribution.ts`: an `import <area>Ru from './ru/<area>.json'`
and a push into `AREA_BUNDLES`. Nothing else changes.

## Conversion recipe (en source → nls + ru)

**Before:**

```ts
export const NEW_CHAPTER: Command = {
  id: 'ai-focused-editor.manuscriptTree.newChapter',
  category: 'AI Focused Editor',
  label: 'New Chapter...'
};
// ...
this.messages.warn(`Could not create chapter: ${reason ?? 'unknown error'}`);
```

**After:**

```ts
import { nls } from '@theia/core/lib/common/nls';

export const NEW_CHAPTER: Command = Command.toLocalizedCommand(
  { id: 'ai-focused-editor.manuscriptTree.newChapter', category: 'AI Focused Editor', label: 'New Chapter...' },
  'ai-focused-editor/manuscript-tree/new-chapter',
  'ai-focused-editor/manuscript-tree/category'
);
// ...
this.messages.warn(nls.localize(
  'ai-focused-editor/manuscript-tree/create-chapter-failed',
  'Could not create chapter: {0}',
  reason ?? nls.localize('ai-focused-editor/manuscript-tree/unknown-error', 'unknown error')
));
```

Rules of thumb:
- **Commands** → `Command.toLocalizedCommand(cmd, labelKey, categoryKey)`.
- **Everything else** (toolbar `tooltip`, `QuickInput` `prompt`/`placeHolder`,
  `MessageService` texts, status-bar text, QuickPick titles, preference
  descriptions, `registerSubmenu` labels) → `nls.localize(key, enDefault, ...args)`.
- Never build a sentence by string concatenation — put the whole sentence in the
  default with `{0}` placeholders so ru word order can differ.

## How the locale is applied (research summary)

- Active locale is stored in `localStorage['localeId']` (`nls.setLocale` writes it,
  then `window.location.reload()`), read back by `nls.locale` on the next load.
- The frontend i18n **preloader** only assigns `nls.localization` (i.e. actually
  applies translations) when the loaded localization reports `languagePack: true`;
  otherwise it resets to the default locale. That is why our descriptor sets
  `languagePack: true`.
- `getAvailableLanguages()` (used by *Configure Display Language*) also only lists
  languages with `languagePack: true` — so the flag is what makes `ru` selectable.
- **Partial-ru reality:** `@theia/core@1.73.1` ships `i18n/nls.ru.json`, but it only
  contains ~1660 Theia-native-keyed strings (`theia/...`) and **zero** `vscode/...`
  keys. So VS Code-derived labels reached via `nls.localizeByDefault('File')` stay
  English; only Theia-native-keyed core strings **and our `ai-focused-editor/...`
  strings** translate. Because the node provider merges all `ru` localizations and
  folds `languagePack ||= …`, our `languagePack:true` registration also unlocks
  core's bundled ru strings. Full workbench ru would require installing a VS Code
  ru language-pack plugin.
