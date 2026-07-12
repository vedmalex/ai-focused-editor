// Builds the AFE Companion Obsidian plugin (packages/obsidian-plugin) and copies
// its dist bundle (main.js + manifest.json + styles.css) into an app's BACKEND-
// readable asset dir so the Book Doctor can install the plugin straight into a
// book folder (turning the folder into a ready Obsidian vault).
//
// Unlike the excalidraw/katex copies — which target lib/frontend because the
// browser fetches them — this asset is read by the NODE backend (the doctor's
// install fix), so it lands in `apps/<target>/lib/obsidian-plugin/`, a sibling
// of `lib/backend`. The node service resolves it from its own module path and
// falls back to `packages/obsidian-plugin/dist` in dev (see
// node-obsidian-plugin-service.ts). Wired into apps/<target> `bundle` because
// Theia's apps/*/esbuild.mjs is a regenerated, gitignored file — this committed
// step is the durable source of truth. Run after `theia build`.
//
// Usage: node copy-obsidian-plugin-assets.mjs [target]
//   target: 'browser' (default) | 'electron' — selects apps/<target>/lib.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgDir = join(repoRoot, 'packages/obsidian-plugin');
const dist = join(pkgDir, 'dist');

const targetApp = process.argv[2] ?? 'browser';
if (targetApp !== 'browser' && targetApp !== 'electron') {
  console.error(`Unknown target: ${targetApp}\nExpected 'browser' or 'electron'.`);
  process.exit(1);
}

// Always (re)build the plugin — the build is fast and this keeps the copied
// bundle in lockstep with the plugin source without a stale-check heuristic.
console.log('Building @ai-focused-editor/obsidian-plugin…');
execFileSync('bun', ['run', '--cwd', 'packages/obsidian-plugin', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit'
});

const files = ['main.js', 'manifest.json', 'styles.css'];
for (const file of files) {
  if (!existsSync(join(dist, file))) {
    console.error(`Plugin build did not produce ${join(dist, file)}`);
    process.exit(1);
  }
}

const target = join(repoRoot, `apps/${targetApp}/lib/obsidian-plugin`);
mkdirSync(target, { recursive: true });
for (const file of files) {
  cpSync(join(dist, file), join(target, file));
}
console.log(`Copied Obsidian plugin assets -> ${target}`);
