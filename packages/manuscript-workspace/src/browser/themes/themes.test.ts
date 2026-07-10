import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the vendored color themes: every bundled JSON must be strict JSON
 * (esbuild's json loader and `JSON.parse` both reject JSONC comments / trailing
 * commas) and carry the `colors` + `tokenColors` keys the Monaco theme registry
 * consumes. Reads straight from this source directory via `import.meta.dir`, so
 * it validates the exact files that ship, independent of the tsc/esbuild build.
 */

/** File name -> uiTheme it is registered with in the frontend module. */
const THEME_FILES: Record<string, 'vs' | 'vs-dark'> = {
  'dracula.json': 'vs-dark',
  'nord.json': 'vs-dark',
  'one-dark-pro.json': 'vs-dark',
  'solarized-light.json': 'vs',
  'gruvbox-dark-medium.json': 'vs-dark'
};

describe('bundled color themes', () => {
  for (const [file, uiTheme] of Object.entries(THEME_FILES)) {
    test(`${file} is strict JSON with colors + tokenColors (${uiTheme})`, () => {
      const raw = readFileSync(join(import.meta.dir, file), 'utf8');

      // Must be strict JSON — no comments, no trailing commas.
      const theme = JSON.parse(raw) as {
        colors?: Record<string, unknown>;
        tokenColors?: unknown;
      };

      expect(theme.colors).toBeDefined();
      expect(typeof theme.colors).toBe('object');
      expect(Object.keys(theme.colors as object).length).toBeGreaterThan(0);

      expect(Array.isArray(theme.tokenColors)).toBe(true);
      expect((theme.tokenColors as unknown[]).length).toBeGreaterThan(0);
    });
  }
});
