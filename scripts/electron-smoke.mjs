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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  assertNarrativeKnowledgeRoundTrip,
  assertNarrativeToolsRegistered,
  toolRegistryReaderScript,
  probeReaderScript,
  assertNarrativeKnowledgeRebuildReady,
  rebuildRoundTripReaderScript,
  assertNarrativeKnowledgeDiagnosticsEnvelopesAgree,
  diagnosticsEnvelopesReaderScript,
  assertNarrativeKnowledgeWatcherSelfUpdates,
  watcherStatusSnapshotReaderScript,
  assertEntityCardsWidgetSelfUpdatesOnPush,
  entityCardsWidgetTextReaderScript,
  createIsolatedSampleWorkspace,
  removeIsolatedSampleWorkspace
} from './narrative-knowledge-round-trip.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = join(repoRoot, 'apps/electron');
const mainJs = join(appDir, 'lib/backend/electron-main.js');
const sampleBookSource = join(repoRoot, 'examples/sample-book');

// A previous interrupted run can leave an instance holding the single-instance
// lock, which makes a fresh launch exit(0) immediately — clear it first and
// WAIT until the processes are really gone (500ms was not always enough: the
// dying instance kept the lock long enough to kill the new window mid-boot).
async function clearStaleInstances() {
  const { execSync } = await import('node:child_process');
  const pattern = 'apps/electron/lib/backend/electron-main.js';
  try {
    execSync(`pkill -f "${pattern}" || true`, { stdio: 'ignore', shell: '/bin/bash' });
  } catch {
    // best effort
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const { execSync: run } = await import('node:child_process');
      run(`pgrep -f "${pattern}"`, { stdio: 'ignore', shell: '/bin/bash' });
      // pgrep exit 0 => still alive, keep waiting
      await new Promise(resolve => setTimeout(resolve, 250));
    } catch {
      return; // pgrep exit 1 => nothing left
    }
  }
}
await clearStaleInstances();

if (!existsSync(mainJs)) {
  console.error(`Electron bundle not found: ${mainJs}\nRun \`bun run build:electron\` first.`);
  process.exit(1);
}

// TASK-022 ISS-365: drive an isolated, disposable copy of the fixture
// manuscript, never examples/sample-book itself — see
// createIsolatedSampleWorkspace's doc comment in narrative-knowledge-round-trip.mjs.
const { workspaceDir: smokeWorkspaceDir, sampleRoot: workspace } = await createIsolatedSampleWorkspace(sampleBookSource);

const errors = [];
const consoleErrors = [];

function fail(message) {
  errors.push(message);
  console.error(`FAIL ${message}`);
}

function pass(message) {
  console.log(`PASS ${message}`);
}

// Launch with one retry: even after the stale-instance sweep the first boot
// occasionally loses its window to a lock/teardown race when the smoke runs
// right after other Playwright/Theia activity.
async function launchWithRetry(electronUserDataDir) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const candidate = await electron.launch({
      // TASK-022 ISS-367: an isolated --electronUserData keeps this test
      // instance's own profile (window state, keytar-backed secrets, etc.)
      // from mixing with a concurrently-running live desktop editor's
      // profile. This is PURELY a profile-hygiene measure — it does NOT
      // provide single-instance isolation. On macOS, requestSingleInstanceLock
      // (apps/electron/src-gen/backend/electron-main.js) is not scoped by
      // userData path at all: both this flag and the raw Chromium
      // --user-data-dir switch were tried (in both argv positions) against a
      // live editor and the lock was still lost every time — see ISS-367.
      // The actual fix is apps/electron/package.json's
      // theia.backend.config.singleInstance: false, which removes the lock
      // check entirely (see that file for why this is safe: per-instance
      // data safety is enforced at the narrative-index writer-lock level,
      // ISS-357/ISS-365, not at the Electron app-instance level).
      args: [mainJs, workspace, `--electronUserData=${electronUserDataDir}`],
      cwd: appDir,
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 120000
    });
    // Buffer the main-process output so a dead-on-arrival window can be
    // diagnosed (single-instance exit, backend crash, GPU init failure, ...).
    const mainOutput = [];
    candidate.process().stdout?.on('data', chunk => mainOutput.push(String(chunk)));
    candidate.process().stderr?.on('data', chunk => mainOutput.push(String(chunk)));
    try {
      const window = await candidate.firstWindow({ timeout: 120000 });
      await window.waitForSelector('.theia-ApplicationShell', { timeout: 120000 });
      return { app: candidate, window };
    } catch (error) {
      lastError = error;
      console.log(`WARN electron launch attempt ${attempt} failed (${String(error).split('\n')[0]}); retrying...`);
      const tail = mainOutput.join('').split('\n').filter(Boolean).slice(-15);
      if (tail.length > 0) {
        console.log('WARN electron main output tail:\n  ' + tail.join('\n  '));
      }
      await candidate.close().catch(() => undefined);
      await clearStaleInstances();
      // Give the OS a moment to release GPU/IPC resources before relaunching —
      // back-to-back launches right after a heavy Playwright run are exactly
      // the flaky case observed.
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  throw lastError;
}

// TASK-022 ISS-367: an isolated electron userData dir, purely for profile
// hygiene against a concurrently-running live desktop editor — see the
// comment on launchWithRetry's electron.launch() call for what this does and
// (more importantly) does NOT provide.
const electronUserDataDir = await mkdtemp(join(tmpdir(), 'afe-electron-smoke-userdata-'));

try {
  await runElectronSmoke(electronUserDataDir);
} finally {
  await removeIsolatedSampleWorkspace(smokeWorkspaceDir);
  await rm(electronUserDataDir, { recursive: true, force: true }).catch(() => undefined);
}

if (errors.length > 0) {
  console.error(`Electron smoke FAILED (${errors.length} problem(s)).`);
  process.exit(1);
}
console.log('Electron smoke passed.');

async function runElectronSmoke(electronUserDataDir) {
const { app, window } = await launchWithRetry(electronUserDataDir);

try {
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
  // The manuscript snapshot loads asynchronously after the first tree rows
  // appear (the file navigator renders earlier) — poll instead of a one-shot
  // check so a slow backend does not read as a missing manuscript tree.
  let treeHasChapter = false;
  for (const deadline = Date.now() + 30000; Date.now() < deadline && !treeHasChapter;) {
    treeHasChapter = await window.evaluate(() =>
      Array.from(document.querySelectorAll('.theia-TreeNode')).some(node => node.textContent?.includes('Chapter 1'))
    );
    if (!treeHasChapter) {
      await window.waitForTimeout(1000);
    }
  }
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

  // TASK-022 WP-0: the narrative-knowledge RPC round-trip, read off the value
  // the frontend probe recorded at start.
  try {
    await assertNarrativeKnowledgeRoundTrip(
      () => window.evaluate(probeReaderScript()),
      'electron'
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // TASK-022 WP-6: the four read-only AI tools reached the invocation registry
  // in THIS target too. The frontend module is shared, but the container is not
  // — WP-0's round-trip probe was added to both runners for exactly this
  // reason, and a binding that resolves in the browser and not in Electron is a
  // shape this repository has already seen.
  try {
    await assertNarrativeToolsRegistered(
      () => window.evaluate(toolRegistryReaderScript()),
      'electron'
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // TASK-022 ISS-354 AC-6: prove the index actually BUILDS and POPULATES in
  // this target too — the round-trip probe above only ever observes
  // `absent`/`not-built`. Same shared function as the browser smoke, driven
  // through the same DI container walk `toolRegistryReaderScript` already
  // uses for a different binding.
  try {
    await assertNarrativeKnowledgeRebuildReady(
      () => window.evaluate(rebuildRoundTripReaderScript()),
      'electron'
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // TASK-022 #46 follow-up: NOW that the index is `ready` and populated, prove
  // the exact three-envelope precondition `applyDiagnostics()` requires before
  // it will publish anything — `getMentions`/`getRelations`/`getDuplicateEntities`
  // all `ready`, all the SAME `generation`. Same shared assertion as the browser
  // smoke, driven through the same DI container walk `rebuildRoundTripReaderScript`
  // already uses for the same service.
  try {
    await assertNarrativeKnowledgeDiagnosticsEnvelopesAgree(
      () => window.evaluate(diagnosticsEnvelopesReaderScript()),
      'electron'
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // TASK-022 ISS-359: the index must update ITSELF from an on-disk edit, with
  // NO call to `rebuild()` anywhere in the check — the one shape of proof that
  // catches "the file watcher never starts in a running application". Same
  // shared function as the browser smoke; edits/restores a real fixture file
  // on disk regardless of pass or fail.
  try {
    await assertNarrativeKnowledgeWatcherSelfUpdates(
      () => window.evaluate(watcherStatusSnapshotReaderScript()),
      'electron'
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // TASK-022 ISS-371: the Entity Cards widget's live `onIndexChanged` push
  // had NEVER been checked in the ELECTRON target before — this file never
  // opened the widget at all, so a target-specific defect in this exact path
  // (UR-043) could ship green here regardless of what the browser smoke
  // found. Same shared tooth as browser-smoke.mjs (two content edits and a
  // real file rename, chained — ISS-371's own strengthening, since a single
  // edit cannot tell a persistent subscription from a one-shot one).
  try {
    await window.evaluate(async () => {
      const container = window.theia && window.theia.container;
      const findKey = label => {
        for (const [candidate] of container._bindingDictionary._map.entries()) {
          const candidateLabel = candidate && (candidate.description || candidate.name);
          if (candidateLabel === label) return candidate;
        }
        return undefined;
      };
      const registry = container.get(findKey('CommandRegistry'));
      await registry.executeCommand('ai-focused-editor.entities.refreshCards');
    });
    await window.waitForTimeout(1500);
    await assertEntityCardsWidgetSelfUpdatesOnPush(
      () => window.evaluate(entityCardsWidgetTextReaderScript()),
      'electron'
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // TASK-022 WP-3 / R-2: does `node:sqlite` actually work in the Electron main
  // process, and WHICH SQLite is under it?
  //
  // The whole storage decision rests on Electron 39.8.7 carrying Node 22.22.1,
  // i.e. at or above the 22.5 where `node:sqlite` appeared, and on the engine
  // being at least SQLite 3.37 for `STRICT` tables. Both are claims about a
  // runtime the node test lane cannot reach — it runs on the local Node — so
  // this is the only place either can be checked at all.
  //
  // IT PRINTS THE VERSIONS whatever happens. The plan and the tech_spec
  // disagree about which SQLite Electron carries (3.51.2 vs a locally measured
  // 3.50.4 on Node 24.9), and a probe that only asserted would leave that
  // disagreement unresolved for whoever reads the output next.
  // `await import('node:sqlite')` DOES NOT WORK HERE: Playwright's
  // `ElectronApplication.evaluate` compiles and runs the callback through a
  // context that has no `importModuleDynamically` hook wired up, so a dynamic
  // `import()` fails with `TypeError: A dynamic import callback was not
  // specified` before the probe body ever runs — a Playwright bridge
  // limitation, not a statement about the product. `require()` has the same
  // problem from a different angle: this evaluate context is not inside any
  // particular CommonJS module, so a bare `require` identifier, `globalThis
  // .require` and `process.mainModule.require` were all empirically tried and
  // NONE were reachable here. `process.getBuiltinModule(id)` (Node >= 22.3,
  // and Electron 39 carries Node 22.22.1) sidesteps both: it is a plain method
  // on the `process` global — already proven reachable two lines below via
  // `process.versions` — and needs neither a module scope nor an import hook.
  try {
    const engine = await app.evaluate(async () => {
      const versions = {
        node: process.versions.node,
        sqlite: process.versions.sqlite,
        electron: process.versions.electron
      };

      if (typeof process.getBuiltinModule !== 'function') {
        return {
          ...versions,
          resolvedVia: null,
          strictWorks: false,
          probeError: 'process.getBuiltinModule is not available in this Node/Electron build'
        };
      }

      try {
        const sqlite = process.getBuiltinModule('node:sqlite');
        const db = new sqlite.DatabaseSync(':memory:');
        db.exec('CREATE TABLE probe (n INTEGER) STRICT');
        let strictWorks = false;
        try {
          db.exec("INSERT INTO probe (n) VALUES ('not-a-number')");
        } catch {
          strictWorks = true;
        }
        db.close();
        return { ...versions, resolvedVia: 'process.getBuiltinModule', strictWorks };
      } catch (error) {
        return {
          ...versions,
          resolvedVia: 'process.getBuiltinModule',
          strictWorks: false,
          probeError: String((error && error.message) || error)
        };
      }
    });
    console.log(
      `[narrative-index] electron main: electron=${engine.electron} node=${engine.node} ` +
        `sqlite=${engine.sqlite} require-via=${engine.resolvedVia}`
    );
    if (!engine.strictWorks) {
      fail(`node:sqlite in the electron main process does not enforce STRICT tables${engine.probeError ? ` (${engine.probeError})` : ''}`);
    } else {
      pass(`node:sqlite works in electron main (sqlite ${engine.sqlite}, STRICT enforced, require via ${engine.resolvedVia})`);
    }
  } catch (error) {
    fail(`node:sqlite unusable in the electron main process: ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  await app.close().catch(() => undefined);
}
}
