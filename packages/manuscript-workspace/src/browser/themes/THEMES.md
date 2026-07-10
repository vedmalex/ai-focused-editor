# Bundled color themes

Five vendored, MIT-licensed VS Code color themes shipped with the editor so
writers can pick a beautiful look. They are registered the Theia-native way via
`MonacoThemingService.registerParsedTheme(...)` in
`../bundled-color-themes-frontend-module.ts` and appear in
**File > Settings > Color Theme** (command `workbench.action.selectTheme`).

These are purely additive — the default light/dark theme is unchanged.

## Contents & provenance

Each `*.json` here is the upstream theme artifact. All are MIT licensed.

| File | Theme (label) | uiTheme | Source | Version / commit |
|------|---------------|---------|--------|------------------|
| `dracula.json` | Dracula | `vs-dark` | [dracula/visual-studio-code] → `theme/dracula.json` (extracted from the published VSIX on Open VSX, `dracula-theme.theme-dracula`) | v2.25.1 |
| `nord.json` | Nord | `vs-dark` | [nordtheme/visual-studio-code] (`develop`) → `themes/nord-color-theme.json` | commit `27045851c515` (2023-04-10) |
| `one-dark-pro.json` | One Dark Pro | `vs-dark` | [Binaryify/OneDark-Pro] (`master`) → `themes/OneDark-Pro.json` | commit `d64c6d3c42e0` (2025-02-01) |
| `solarized-light.json` | Solarized Light | `vs` | [microsoft/vscode] (`main`) → `extensions/theme-solarized-light/themes/solarized-light-color-theme.json` | commit `2aeed2bb0e98` (2026-06-01) |
| `gruvbox-dark-medium.json` | Gruvbox Dark Medium | `vs-dark` | [jdinhify/vscode-theme-gruvbox] → `themes/gruvbox-dark-medium.json` (extracted from the published VSIX on Open VSX, `jdinhlife.gruvbox`) | v1.29.1 |

[dracula/visual-studio-code]: https://github.com/dracula/visual-studio-code
[nordtheme/visual-studio-code]: https://github.com/nordtheme/visual-studio-code
[Binaryify/OneDark-Pro]: https://github.com/Binaryify/OneDark-Pro
[microsoft/vscode]: https://github.com/microsoft/vscode
[jdinhify/vscode-theme-gruvbox]: https://github.com/jdinhify/vscode-theme-gruvbox

### Notes per theme

- **Dracula** and **Gruvbox** do not commit their built JSON to git (both
  generate it from source at build time). Rather than hand-write an
  approximation, the exact published artifact was extracted from each
  extension's VSIX on [Open VSX](https://open-vsx.org). Both keep a harmless
  `"$schema": "vscode://schemas/color-theme"` string, which the Monaco theme
  registry ignores.
- **Nord** and **Solarized Light** shipped as JSONC (block/line comments and, for
  Solarized, trailing commas). They were normalized to strict JSON with the
  `sanitize-jsonc.mjs` sanitizer in this directory (comments/trailing commas
  stripped, then re-serialized with `JSON.stringify`). No color data was
  changed.
- **Solarized Light** has no top-level `"type"` field; it is registered with
  `uiTheme: 'vs'` explicitly so it uses the light base.
- None of the five use the `"include"` construct or a string-valued
  `"tokenColors"` (external file reference), so no companion files are needed.

## How to update / add a theme

1. Fetch the upstream JSON. Prefer the raw file on the repo's default branch:
   ```
   curl -sSL -o <name>.json \
     https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path-to-theme>.json
   ```
   If the repo generates its theme at build time (no committed JSON), pull the
   published artifact from Open VSX instead:
   ```
   curl -sSL "https://open-vsx.org/api/<namespace>/<name>" | grep -o '"download":"[^"]*"'
   curl -sSL -o ext.vsix "<download-url>"
   unzip -p ext.vsix "extension/<path-to-theme>.json" > <name>.json
   ```
2. Ensure it is **strict JSON**. If the source is JSONC, sanitize it:
   ```
   node sanitize-jsonc.mjs <name>.json
   ```
   (Strips `//` and `/* */` comments and trailing commas, re-serializes to
   strict JSON. `bun test` — see `themes.test.ts` — will fail on any JSONC that
   slips through.)
3. Confirm the JSON is self-contained: no `"include"` key and `"tokenColors"`
   is an array (not a string path). If it uses either, skip it or vendor the
   referenced file too.
4. Drop the `*.json` file in this directory and wire it into
   `../bundled-color-themes-frontend-module.ts` (`BUNDLED_THEMES`): add an
   `import`, then an entry with a stable `id`, a `label`, and the right
   `uiTheme` (`vs` for light bases, `vs-dark` for dark bases).
5. Add the file + its `uiTheme` to `THEME_FILES` in `themes.test.ts`, and a row
   to the table above with the source URL, version/commit, and license.
6. `bun test packages && bun run build` from the repo root.

> Build note: the package build script copies `src/browser/themes/*.json` into
> `lib/browser/themes/` after `tsc` (TypeScript does not emit `.json`), so the
> esbuild frontend bundler can inline them from the compiled output.
