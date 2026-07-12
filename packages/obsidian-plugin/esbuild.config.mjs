/**
 * Bundle the plugin to a single CommonJS `dist/main.js` for Obsidian.
 *
 * Obsidian runs plugins in the Electron renderer and injects `require('obsidian')`
 * itself, so `obsidian`, `electron`, the bundled CodeMirror 6 packages, and Node
 * builtins are EXTERNAL. Our workspace imports (`@ai-focused-editor/*`) and `yaml`
 * are bundled in. `manifest.json` + `styles.css` are copied alongside so the
 * `dist/` folder is a drop-in plugin directory.
 */

import { build } from 'esbuild';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import builtins from 'builtin-modules';

const outdir = 'dist';

await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: ['src/main.ts'],
  outfile: `${outdir}/main.js`,
  bundle: true,
  format: 'cjs',
  target: 'es2020',
  platform: 'browser',
  mainFields: ['module', 'main'],
  conditions: ['import', 'require', 'default'],
  sourcemap: false,
  treeShaking: true,
  logLevel: 'info',
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins
  ],
  metafile: true
});

await copyFile('manifest.json', `${outdir}/manifest.json`);
await copyFile('styles.css', `${outdir}/styles.css`);

const { size } = await stat(`${outdir}/main.js`);
console.log(`\ndist/main.js  ${(size / 1024).toFixed(1)} KiB`);
void result;
