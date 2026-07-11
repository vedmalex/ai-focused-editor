// Copies Excalidraw's self-hosted fonts + stylesheet into an app's served
// static root so the .excalidraw editor never fetches fonts from a CDN
// (offline-safe / CSP-safe). Wired into apps/<target> `bundle` because Theia's
// apps/*/esbuild.mjs is a regenerated, gitignored file — this committed step is
// the durable source of truth. Run after `theia build`.
//
// Usage: node copy-excalidraw-assets.mjs [target]
//   target: 'browser' (default) | 'electron' — selects apps/<target>/lib/frontend.
// Both the browser and electron targets serve lib/frontend via express.static,
// so the same asset layout works for each.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Resolve @excalidraw/excalidraw from the package that declares it.
const require = createRequire(join(repoRoot, 'packages/manuscript-workspace/package.json'));
// The package's `exports` map hides ./package.json, so resolve the main entry
// and derive the package root from its path instead.
const entry = require.resolve('@excalidraw/excalidraw');
const marker = join('@excalidraw', 'excalidraw');
const pkgRoot = entry.slice(0, entry.lastIndexOf(marker) + marker.length);
const distProd = join(pkgRoot, 'dist', 'prod');

if (!existsSync(distProd)) {
  console.error(`Excalidraw dist not found: ${distProd}\nRun \`bun install\` first.`);
  process.exit(1);
}

const targetApp = process.argv[2] ?? 'browser';
if (targetApp !== 'browser' && targetApp !== 'electron') {
  console.error(`Unknown target: ${targetApp}\nExpected 'browser' or 'electron'.`);
  process.exit(1);
}

const target = join(repoRoot, `apps/${targetApp}/lib/frontend/excalidraw-assets`);
mkdirSync(target, { recursive: true });
cpSync(join(distProd, 'fonts'), join(target, 'fonts'), { recursive: true });
cpSync(join(distProd, 'index.css'), join(target, 'index.css'));
console.log(`Copied Excalidraw assets -> ${target}`);
