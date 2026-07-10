// *****************************************************************************
// Fork-only helper (not from upstream @theia/git).
//
// `@ai-focused-editor/git` needs the native addon `find-git-repositories`
// (`build/Release/findGitRepos.node`) at runtime for repository discovery
// (see src/node/git-locator/git-locator-impl.ts). The pinned version 0.1.x ships
// NO npm `install` script and Bun does not auto-run `node-gyp` for binding.gyp
// packages, so a plain `bun install` leaves the addon uncompiled. This script
// compiles it on demand (idempotent: it skips when the binary already exists).
//
// It runs as part of `bun run build` for this package, which the root
// `build:packages` invokes BEFORE `build:browser` — so the compiled `.node` is
// present when the Theia bundler copies native modules into the app. See FORK.md.
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

let pkgDir;
try {
    pkgDir = dirname(require.resolve('find-git-repositories/package.json'));
} catch {
    console.error('[theia-git-fork] Could not resolve "find-git-repositories". Run `bun install` first.');
    process.exit(1);
}

const binary = join(pkgDir, 'build', 'Release', 'findGitRepos.node');
if (existsSync(binary)) {
    console.log('[theia-git-fork] native find-git-repositories addon already built:', binary);
    process.exit(0);
}

console.log('[theia-git-fork] building native find-git-repositories addon via node-gyp in', pkgDir);
try {
    execFileSync('bunx', ['node-gyp', 'rebuild'], { cwd: pkgDir, stdio: 'inherit' });
} catch (err) {
    console.error('[theia-git-fork] node-gyp build failed. A C/C++ toolchain (Xcode CLT / build-essential) and Python are required.');
    console.error(err && err.message ? err.message : err);
    process.exit(1);
}

if (!existsSync(binary)) {
    console.error('[theia-git-fork] node-gyp completed but the addon is still missing:', binary);
    process.exit(1);
}
console.log('[theia-git-fork] native find-git-repositories addon built:', binary);
