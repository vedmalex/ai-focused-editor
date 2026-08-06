// TASK-022 UR-045 — reproducible probe: does Theia's BUILT-IN file navigator
// ("files" widget, @theia/navigator) show a renamed file immediately, and does
// that depend on whether the rename came FROM INSIDE the app (FileService.move,
// the same call `WorkspaceCommands.FILE_RENAME` makes — see
// @theia/workspace/lib/browser/workspace-commands.js:282) or from OUTSIDE
// (fs.renameSync, like a terminal `mv`), and on WHEN in the session it happens
// (first seconds vs. ~2.5 minutes in)?
//
// Context: UR-045 (memory-bank/tasks/2026-08-02_TASK-022_.../requests.md) asks
// this exact question after the author found the built-in navigator does not
// pick up a rename without a manual refresh, while our OWN panels (UR-043)
// do. ISS-371 already measured that the workspace's underlying file watcher
// delivers events in the first ~60-75s of a session and then goes silent
// until a 5-minute fallback sweep (a narrative-knowledge-only mechanism the
// built-in navigator does NOT have). This script tells apart:
//   - "same defect as ISS-371" (watcher silence) — internal and external
//     renames behave THE SAME at a given point in time, and both degrade
//     after the early window;
//   - "different defect" (navigator subscription) — internal renames behave
//     differently from external ones at the SAME point in time.
//
// Source reading done BEFORE writing this probe (cited in the task report):
//   packages/filesystem/lib/browser/file-tree/file-tree-model.js:34
//     FileTreeModel (the base class @theia/navigator's tree model extends)
//     subscribes ONLY to `fileService.onDidFilesChange`.
//   packages/filesystem/lib/browser/file-service.js:119,148
//     `onDidFilesChangeEmitter` fires ONLY from `provider.onDidChangeFile` —
//     i.e. only from the disk-watch provider — never from
//     `onDidRunOperationEmitter` (which fires on MOVE/COPY/DELETE/CREATE
//     performed BY FileService itself).
//   apps/browser/node_modules/@theia/navigator (grepped): no file in the
//     package references `onDidRunOperation` at all.
// Read conclusion: the navigator's tree model has NO fast path for
// FileService-driven operations — it can only ever learn about a rename
// through the disk watcher, exactly the channel ISS-371 found goes silent.
// That predicts internal and external renames should behave IDENTICALLY at
// a given point in the session. This script tests that prediction instead of
// asserting it from the reading alone.
//
// Usage: bun run .plan/task-022-iss-371-navigator-probe.mjs

const MANUSCRIPT_TREE_ID = 'ai-focused-editor.manuscript-tree';
// (or: node .plan/task-022-iss-371-navigator-probe.mjs)
//
// Runs an ISOLATED throwaway copy of examples/sample-book (never the fixture
// itself — same discipline as scripts/browser-smoke.mjs, ISS-365) on a free
// port that is NEVER 3000/3001/3002 (the author's live editors), so it is
// safe to run alongside a live session. Takes ~3 minutes (one deliberate wait
// to reach the "2-3 minutes into the session" window UR-045 asks about).

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { renameSync, writeFileSync } from 'node:fs';
import {
  createIsolatedSampleWorkspace,
  removeIsolatedSampleWorkspace
} from '../scripts/narrative-knowledge-round-trip.mjs';

const FORBIDDEN_PORTS = new Set([3000, 3001, 3002]);
const LATE_WINDOW_MARK_MS = 150_000; // 2.5 minutes from session start
const EARLY_POLL_TIMEOUT_MS = 30_000;
const LATE_POLL_TIMEOUT_MS = 90_000;

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const appDir = join(repoRoot, 'apps/browser');
const sampleBookSource = join(repoRoot, 'examples/sample-book');

const { workspaceDir: smokeWorkspaceDir, sampleRoot } = await createIsolatedSampleWorkspace(sampleBookSource);

// Four disposable, distinctively-named probe files under knowledge/ — a
// DOM/model match on their "after" name can only come from THIS run's
// rename, never from fixture content or a stale render.
//
// knowledge/ (not a loose top-level file) is deliberate: `ManuscriptTreeModel
// .scanKnowledge()` (packages/manuscript-workspace/src/browser/
// manuscript-tree-model.ts:206-222) does a RAW recursive fs.resolve() scan of
// `knowledge/` — no manifest.yaml entry required — so a file placed there is
// visible to OUR "Manuscript" panel exactly like it is to the built-in
// navigator, making the two comparable for the SAME rename. A loose
// manifest-driven content/*.md file would not be: the Manuscript panel's
// content section is manifest.yaml-gated
// (packages/manuscript-workspace/src/node/node-manuscript-workspace-service.ts),
// so an un-declared file there would never appear regardless of any watcher.
// `affectsMaterials` (manuscript-tree-model.ts:94-104) matches `/knowledge/`,
// so a knowledge/ change also reaches our own `scheduleAutoRefresh` path.
const PROBES = {
  internalEarly: { before: 'knowledge/zz-iss371-internal-early-v1.md', after: 'knowledge/zz-iss371-internal-early-v2.md', label: 'internal rename, first seconds' },
  externalEarly: { before: 'knowledge/zz-iss371-external-early-v1.md', after: 'knowledge/zz-iss371-external-early-v2.md', label: 'external rename, first seconds' },
  internalLate: { before: 'knowledge/zz-iss371-internal-late-v1.md', after: 'knowledge/zz-iss371-internal-late-v2.md', label: 'internal rename, ~2.5min mark' },
  externalLate: { before: 'knowledge/zz-iss371-external-late-v1.md', after: 'knowledge/zz-iss371-external-late-v2.md', label: 'external rename, ~2.5min mark' }
};
for (const { before } of Object.values(PROBES)) {
  writeFileSync(join(sampleRoot, before), '# probe\n\nISS-371 / UR-045 navigator probe file.\n');
}

const port = await getFreePort();
const url = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [
  'node_modules/@theia/cli/bin/theia.js',
  'start',
  '--hostname', '127.0.0.1',
  '--port', String(port),
  sampleRoot
], {
  cwd: appDir,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
server.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

let browser;
const results = {};
try {
  await waitForServer(url, 120_000);
  browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__probeGetBindingByKeyName = name => {
      const container = window.theia?.container;
      if (!container) {
        throw new Error('Theia container is not available.');
      }
      for (const [key] of container._bindingDictionary._map.entries()) {
        if (key?.name === name) {
          return key;
        }
      }
      throw new Error(`No Theia binding found: ${name}`);
    };
    window.__probeGet = name => window.theia.container.get(window.__probeGetBindingByKeyName(name));
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() =>
    document.title.includes('AI Focused Editor') ||
    Boolean(document.querySelector('.theia-ApplicationShell, #theia-app-shell, .p-Widget')),
  undefined, { timeout: 60_000 });
  await page.waitForFunction(() => {
    const shellText = document.querySelector('#theia-app-shell')?.textContent ?? '';
    return document.title.includes('sample-book') || shellText.includes('chapter-01.md') || shellText.includes('sample-book');
  }, undefined, { timeout: 45_000 });

  const sessionStart = Date.now();
  console.log(`[t=0ms] session ready — url=${url}, workspace=${sampleRoot}`);

  await ensureNavigatorOpen(page);
  // The Manuscript panel opens via `initializeLayout` (UR-039/UR-040), but its
  // first `refreshWorkspace()` scan races app startup — force one explicit
  // refresh (same command `browser-smoke.mjs` calls) so the readiness poll
  // below isn't racing that initial scan too.
  await page.evaluate(async () => {
    const registry = window.__probeGet('CommandRegistry');
    await registry.executeCommand('ai-focused-editor.manuscriptTree.refresh');
  });
  // The built-in navigator's tree is LAZY: `initializeRoot()` only auto-expands
  // the single workspace-root DirNode one level deep (packages/navigator's
  // navigator-model.js:74-82), so `knowledge/`'s own children are never
  // resolved until something expands `knowledge/` itself. The Manuscript
  // panel's tree is NOT lazy this way — `rebuildRoot()` builds the whole
  // section tree eagerly from already-fetched arrays — so only the navigator
  // side needs this.
  await expandNavigatorFolder(page, 'knowledge');
  await waitForWidgetReady(page, 'files', PROBES.internalEarly.before, 20_000);
  await waitForWidgetReady(page, MANUSCRIPT_TREE_ID, PROBES.internalEarly.before, 20_000);

  for (const [key, { before }] of Object.entries(PROBES)) {
    const navSeen = await widgetContains(page, 'files', before);
    const manSeen = await widgetContains(page, MANUSCRIPT_TREE_ID, before);
    console.log(`[setup] before-name ${key} (${before}): navigator=${navSeen} manuscriptTree=${manSeen}`);
  }

  // --- EARLY WINDOW ---------------------------------------------------------
  await doInternalRename(page, PROBES.internalEarly.before, PROBES.internalEarly.after);
  results.internalEarly = await pollBoth(page, PROBES.internalEarly.after, EARLY_POLL_TIMEOUT_MS, sessionStart, 'internalEarly');

  doExternalRename(sampleRoot, PROBES.externalEarly.before, PROBES.externalEarly.after);
  results.externalEarly = await pollBoth(page, PROBES.externalEarly.after, EARLY_POLL_TIMEOUT_MS, sessionStart, 'externalEarly');

  // --- WAIT UNTIL THE ~2.5 MINUTE MARK ---------------------------------------
  const waitMs = Math.max(0, LATE_WINDOW_MARK_MS - (Date.now() - sessionStart));
  console.log(`[wait] sleeping ${Math.round(waitMs / 1000)}s to reach the late window (t=${LATE_WINDOW_MARK_MS}ms)...`);
  await sleep(waitMs);

  // --- LATE WINDOW ------------------------------------------------------------
  await doInternalRename(page, PROBES.internalLate.before, PROBES.internalLate.after);
  results.internalLate = await pollBoth(page, PROBES.internalLate.after, LATE_POLL_TIMEOUT_MS, sessionStart, 'internalLate');

  doExternalRename(sampleRoot, PROBES.externalLate.before, PROBES.externalLate.after);
  results.externalLate = await pollBoth(page, PROBES.externalLate.after, LATE_POLL_TIMEOUT_MS, sessionStart, 'externalLate');

  // --- SANITY: MANUAL REFRESH MUST SHOW EVERYTHING ----------------------------
  await page.evaluate(async () => {
    const registry = window.__probeGet('CommandRegistry');
    await registry.executeCommand('navigator.refresh');
  });
  await page.evaluate(async () => {
    const registry = window.__probeGet('CommandRegistry');
    await registry.executeCommand('ai-focused-editor.manuscriptTree.refresh');
  });
  await sleep(1500);
  const afterManualRefresh = {};
  for (const [key, { after }] of Object.entries(PROBES)) {
    afterManualRefresh[key] = {
      navigator: await widgetContains(page, 'files', after),
      manuscriptTree: await widgetContains(page, MANUSCRIPT_TREE_ID, after)
    };
  }

  console.log('\n=== RESULTS ===');
  for (const [key, { label }] of Object.entries(PROBES)) {
    const r = results[key];
    console.log(`${key} [${label}] (issued at t=${r.renameIssuedAtMs}ms):`);
    console.log(`  navigator:      ${describeOutcome(r.navigator)}`);
    console.log(`  manuscriptTree: ${describeOutcome(r.manuscriptTree)}`);
  }
  console.log('\nAfter manual refresh (navigator.refresh + manuscriptTree.refresh), visible:');
  console.log(JSON.stringify(afterManualRefresh, null, 2));

  console.log('\n=== RAW JSON ===');
  console.log(JSON.stringify({ results, afterManualRefresh }, null, 2));
} catch (error) {
  console.error('Probe failed.');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  if (serverOutput.trim()) {
    console.error('\nTheia server output:\n' + serverOutput.trim().slice(-4000));
  }
  process.exitCode = 1;
} finally {
  if (browser) {
    await browser.close();
  }
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), sleep(5_000)]);
  await removeIsolatedSampleWorkspace(smokeWorkspaceDir);
}

async function ensureNavigatorOpen(page) {
  const attached = await page.evaluate(() => {
    const wm = window.__probeGet('WidgetManager');
    const w = wm.tryGetWidget('files');
    return !!(w && w.isAttached);
  });
  if (attached) {
    return;
  }
  await page.evaluate(async () => {
    const registry = window.__probeGet('CommandRegistry');
    await registry.executeCommand('fileNavigator:toggle');
  });
  await page.waitForFunction(() => {
    const wm = window.__probeGet('WidgetManager');
    const w = wm.tryGetWidget('files');
    return !!(w && w.isAttached);
  }, undefined, { timeout: 15_000 });
}

// Expands a top-level folder node in the built-in navigator's model, forcing
// `FileTree.resolveChildren` to resolve its children — otherwise a probe file
// one level below the workspace root (e.g. `knowledge/x.md`) is never
// reachable from `widgetContains`'s tree walk at all, independent of any
// rename/watcher behavior. This mirrors what a real author does by clicking
// the folder open in Explorer.
async function expandNavigatorFolder(page, folderName, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const result = await page.evaluate(async name => {
      const wm = window.__probeGet('WidgetManager');
      const w = wm.tryGetWidget('files');
      if (!w || !w.model) {
        return { ok: false, error: 'files widget/model not found' };
      }
      const model = w.model;
      const stack = [model.root];
      let target;
      while (stack.length) {
        const node = stack.pop();
        if (!node) {
          continue;
        }
        if (node.uri && String(node.uri).endsWith('/' + name)) {
          target = node;
          break;
        }
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            stack.push(child);
          }
        }
      }
      if (!target) {
        return { ok: false, error: `folder node not found yet in navigator model: ${name}` };
      }
      if (!target.expanded) {
        await model.expandNode(target);
      }
      return { ok: true };
    }, folderName);
    if (result.ok) {
      return;
    }
    lastError = result.error;
    await sleep(300);
  }
  throw new Error(`expandNavigatorFolder(${folderName}) timed out: ${lastError}`);
}


// Reads the TREE MODEL directly, not the rendered DOM. Both the built-in
// navigator's row list AND the Manuscript panel's are virtualized (only rows
// scrolled into view exist as DOM nodes), so a `.node.textContent` scan
// silently misses any probe file outside the viewport — that gave false
// "NOT FOUND" results in the first run of this probe even for names present
// at setup, before any rename. Walking `widget.model.root` sees every
// resolved node regardless of what is rendered.
//
// Checks a WIDER set of string fields than a plain FileStatNode needs,
// because the two widgets use different node shapes: the built-in navigator's
// `DirNode`/`FileNode` (packages/filesystem/lib/browser/file-tree/file-tree.js)
// carries a `.uri`; the Manuscript panel's `ManuscriptFileTreeNode` carries
// `.manuscript.{path,name,uri}` and its `AuthorMaterialTreeNode` (knowledge
// files) carries `.materialUri` instead
// (packages/manuscript-workspace/src/browser/manuscript-tree.ts:81-100).
async function widgetContains(page, widgetId, name) {
  const result = await page.evaluate(([widgetId, needle]) => {
    const wm = window.__probeGet('WidgetManager');
    const w = wm.tryGetWidget(widgetId);
    if (!w || !w.model) {
      return { ok: false, error: `widget/model not found: ${widgetId}` };
    }
    const root = w.model.root;
    if (!root) {
      return { ok: true, found: false };
    }
    const matches = node => {
      for (const key of ['uri', 'path', 'name', 'id', 'materialUri', 'description']) {
        const value = node[key];
        if (typeof value === 'string' && value.includes(needle)) {
          return true;
        }
        if (value && typeof value === 'object' && typeof value.toString === 'function') {
          try {
            if (String(value).includes(needle)) {
              return true;
            }
          } catch {
            // not stringifiable the way we expect — ignore
          }
        }
      }
      if (node.manuscript && typeof node.manuscript === 'object' && matches(node.manuscript)) {
        return true;
      }
      return false;
    };
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || seen.has(node)) {
        continue;
      }
      seen.add(node);
      if (matches(node)) {
        return { ok: true, found: true };
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          stack.push(child);
        }
      }
    }
    return { ok: true, found: false };
  }, [widgetId, name]);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.found;
}

// The single-root workspace's folder node auto-expands asynchronously
// (`NavigatorModel.initializeRoot`) after the widget is attached — poll for
// ANY known "before" name to appear in the model before treating a widget as
// ready, instead of assuming attachment implies population.
async function waitForWidgetReady(page, widgetId, anyKnownName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await widgetContains(page, widgetId, anyKnownName)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Widget ${widgetId} did not populate root children within ${timeoutMs}ms (looked for ${anyKnownName})`);
}

// Polls BOTH the built-in navigator and our own Manuscript panel for the same
// renamed name, on the same timeline, so the two are directly comparable for
// the SAME underlying rename event rather than inferred from separate runs.
async function pollBoth(page, expectedName, timeoutMs, sessionStart, label) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  const outcome = { navigator: undefined, manuscriptTree: undefined };
  while (Date.now() < deadline && (!outcome.navigator || !outcome.manuscriptTree)) {
    if (!outcome.navigator && await widgetContains(page, 'files', expectedName)) {
      outcome.navigator = { found: true, elapsedFromRenameMs: Date.now() - start };
    }
    if (!outcome.manuscriptTree && await widgetContains(page, MANUSCRIPT_TREE_ID, expectedName)) {
      outcome.manuscriptTree = { found: true, elapsedFromRenameMs: Date.now() - start };
    }
    if (!outcome.navigator || !outcome.manuscriptTree) {
      await sleep(500);
    }
  }
  if (!outcome.navigator) {
    outcome.navigator = { found: false, timeoutMs };
  }
  if (!outcome.manuscriptTree) {
    outcome.manuscriptTree = { found: false, timeoutMs };
  }
  const renameIssuedAtMs = start - sessionStart;
  console.log(`[${label}] navigator=${describeOutcome(outcome.navigator)} manuscriptTree=${describeOutcome(outcome.manuscriptTree)} (rename issued at t=${renameIssuedAtMs}ms)`);
  return { ...outcome, renameIssuedAtMs };
}

function describeOutcome(o) {
  return o.found ? `FOUND after ${o.elapsedFromRenameMs}ms` : `NOT FOUND within ${o.timeoutMs}ms`;
}

// Exercises the EXACT same call `WorkspaceCommands.FILE_RENAME`'s handler
// makes (@theia/workspace/lib/browser/workspace-commands.js:282,
// `this.fileService.move(oldUri, newUri)`), bypassing only the interactive
// rename-dialog input box — the underlying FileService operation, and
// therefore the onDidRunOperation/onWillRunUserOperation events it fires, are
// identical to what the real rename dialog triggers.
async function doInternalRename(page, before, after) {
  const result = await page.evaluate(async ([before, after]) => {
    try {
      const fileService = window.__probeGet('FileService');
      const workspaceService = window.__probeGet('WorkspaceService');
      const root = workspaceService.tryGetRoots()[0].resource;
      const oldUri = root.resolve(before);
      const newUri = root.resolve(after);
      await fileService.move(oldUri, newUri);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }, [before, after]);
  if (!result.ok) {
    throw new Error(`internal rename failed (${before} -> ${after}): ${result.error}`);
  }
  console.log(`[internal-rename] fileService.move(${before} -> ${after}) issued`);
}

function doExternalRename(root, before, after) {
  renameSync(join(root, before), join(root, after));
  console.log(`[external-rename] fs.renameSync(${before} -> ${after}) issued`);
}

async function getFreePort() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    const freePort = typeof address === 'object' && address ? address.port : 0;
    probe.close();
    await once(probe, 'close');
    if (!FORBIDDEN_PORTS.has(freePort)) {
      return freePort;
    }
  }
  throw new Error('Could not find a free port outside the forbidden set.');
}

async function waitForServer(targetUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(targetUrl);
      if (response.ok || response.status < 500) {
        return;
      }
      lastError = new Error(`Unexpected HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${targetUrl}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
