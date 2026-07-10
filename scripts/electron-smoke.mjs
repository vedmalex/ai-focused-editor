// Electron runtime smoke for the AI Focused Editor desktop target.
// Launches the built electron app against examples/sample-book via
// Playwright's Electron driver, waits for the workbench, and checks the
// menu-integrity invariant plus backend health (incl. the git fork channel).
//
// Usage: node scripts/electron-smoke.mjs   (after `bun run build:electron`)
import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = join(repoRoot, 'apps/electron');
const mainJs = join(appDir, 'lib/backend/electron-main.js');
const workspace = join(repoRoot, 'examples/sample-book');

if (!existsSync(mainJs)) {
  console.error(`Electron bundle not found: ${mainJs}\nRun \`bun run build:electron\` first.`);
  process.exit(1);
}

const errors = [];
const consoleErrors = [];

function fail(message) {
  errors.push(message);
  console.error(`FAIL ${message}`);
}

function pass(message) {
  console.log(`PASS ${message}`);
}

const app = await electron.launch({
  args: [mainJs, workspace],
  cwd: appDir,
  env: { ...process.env, NODE_ENV: 'development' },
  timeout: 120000
});

try {
  const window = await app.firstWindow({ timeout: 120000 });
  window.on('console', message => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await window.waitForSelector('.theia-ApplicationShell', { timeout: 120000 });
  pass('workbench shell rendered');

  // The Theia electron target renders the main menu natively (macOS) or in
  // the custom titlebar; assert via the menu MODEL through page evaluation of
  // the DOM only when a DOM menubar exists, otherwise skip gracefully.
  const menuCounts = await window.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('.lm-MenuBar-itemLabel, .p-MenuBar-itemLabel'))
      .map(el => el.textContent?.trim())
      .filter(Boolean);
    return {
      hasDomMenu: labels.length > 0,
      manuscript: labels.filter(label => label === 'Manuscript').length
    };
  });
  if (menuCounts.hasDomMenu) {
    if (menuCounts.manuscript === 1) {
      pass('exactly one Manuscript menu');
    } else {
      fail(`expected 1 Manuscript menu, found ${menuCounts.manuscript}`);
    }
  } else {
    pass('native menu bar (DOM menu not rendered) — menu check delegated to browser flow pack');
  }

  await window.waitForSelector('.theia-TreeNode', { timeout: 60000 });
  const treeHasChapter = await window.evaluate(() =>
    Array.from(document.querySelectorAll('.theia-TreeNode')).some(node => node.textContent?.includes('Chapter 1'))
  );
  if (treeHasChapter) {
    pass('manuscript tree shows Chapter 1');
  } else {
    fail('manuscript tree does not show Chapter 1');
  }

  // Soft check: the read-only git indicator should surface a branch name
  // (sample-book sits inside this repository, so a branch is expected).
  const statusBarText = await window.evaluate(() => document.querySelector('#theia-statusBar')?.textContent ?? '');
  if (/\bmain\b|\bmaster\b/.test(statusBarText)) {
    pass('git status bar shows a branch');
  } else {
    console.log('WARN git status bar branch not visible (non-fatal): ' + statusBarText.slice(0, 120));
  }

  // Give the backend a moment, then look for fatal console errors (DI
  // failures, MODULE_NOT_FOUND from native addons, git fork crashes).
  await window.waitForTimeout(4000);
  const fatal = consoleErrors.filter(text =>
    /MODULE_NOT_FOUND|Cannot find module|NODE_MODULE_VERSION|was compiled against a different Node\.js version|No bindings|DI error/i.test(text)
  );
  if (fatal.length === 0) {
    pass('no native-module/DI errors in renderer console');
  } else {
    for (const text of fatal) {
      fail(`console: ${text.slice(0, 300)}`);
    }
  }
} finally {
  await app.close().catch(() => undefined);
}

if (errors.length > 0) {
  console.error(`Electron smoke FAILED (${errors.length} problem(s)).`);
  process.exit(1);
}
console.log('Electron smoke passed.');
