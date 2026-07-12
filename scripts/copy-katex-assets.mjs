// Copies KaTeX's self-hosted stylesheet + fonts into an app's served static
// root so the semantic-markdown preview renders formulas OFFLINE — the widget
// injects `<link href="./katex-assets/katex.min.css">` and that CSS's
// `@font-face url(fonts/KaTeX_*.woff2)` references resolve against the copied
// `katex-assets/fonts/` directory (no CDN, CSP-safe). Wired into apps/<target>
// `bundle` because Theia's apps/*/esbuild.mjs is a regenerated, gitignored file —
// this committed step is the durable source of truth. Run after `theia build`.
//
// Mirrors scripts/copy-excalidraw-assets.mjs.
//
// Usage: node copy-katex-assets.mjs [target]
//   target: 'browser' (default) | 'electron' — selects apps/<target>/lib/frontend.
// Both the browser and electron targets serve lib/frontend via express.static,
// so the same asset layout works for each.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Resolve katex from the package that declares it.
const require = createRequire(join(repoRoot, 'packages/manuscript-workspace/package.json'));
// KaTeX's `exports` map keeps `./*` open, so package.json resolves directly and
// its directory is the package root.
const pkgRoot = dirname(require.resolve('katex/package.json'));
const dist = join(pkgRoot, 'dist');

if (!existsSync(dist)) {
  console.error(`KaTeX dist not found: ${dist}\nRun \`bun install\` first.`);
  process.exit(1);
}

const targetApp = process.argv[2] ?? 'browser';
if (targetApp !== 'browser' && targetApp !== 'electron') {
  console.error(`Unknown target: ${targetApp}\nExpected 'browser' or 'electron'.`);
  process.exit(1);
}

const target = join(repoRoot, `apps/${targetApp}/lib/frontend/katex-assets`);
mkdirSync(target, { recursive: true });
cpSync(join(dist, 'fonts'), join(target, 'fonts'), { recursive: true });
cpSync(join(dist, 'katex.min.css'), join(target, 'katex.min.css'));
console.log(`Copied KaTeX assets -> ${target}`);
