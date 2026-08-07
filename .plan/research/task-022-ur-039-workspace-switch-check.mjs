// ONE-OFF empirical check (TASK-022 / UR-039) — NOT part of the test suite, not committed.
//
// Question: does the Theia shell layout (which controls whether the
// Narrative Map / Entity Cards icons are attached to the right panel at
// startup) persist SEPARATELY per workspace, and does
// FrontendApplication.createDefaultLayout() (which calls each
// FrontendApplicationContribution's initializeLayout()) run when opening a
// SECOND, previously-unseen book in the SAME persistent browser profile?
//
// Source-reading finding (apps/browser/node_modules/@theia/core/lib/browser):
//   - storage-service.js LocalStorageService.prefix(key) => `theia:${pathname}:${key}`
//     using window.location.pathname ONLY — the workspace path is NOT part of
//     this key. (@theia/workspace/lib/browser/workspace-service.js stores the
//     workspace path in window.location.HASH, which is excluded from pathname.)
//   - shell-layout-restorer.js: storageKey = 'layout'. storeLayout() is only
//     invoked from frontend-application.js's `windowsService.onUnload` handler
//     (i.e. on page close/reload/navigate-away).
//   - frontend-application.js initializeLayout(): calls restoreLayout() first;
//     createDefaultLayout() (=> contribution.initializeLayout()) runs ONLY if
//     restoreLayout() returns false (i.e. NO prior data under that key).
//
// => The persisted layout is scoped by (origin, pathname), NOT by workspace.
//    If two different workspaces are served from the SAME origin (e.g. the
//    same host:port, reused across a backend restart pointed at a different
//    book), the SECOND workspace's shell layout is a RESTORE of whatever was
//    last saved at that origin — createDefaultLayout()/initializeLayout()
//    does NOT run for it. This script verifies that empirically:
//
//   1. Start server A (book A, isolated copy) on port P. Open in a
//      PERSISTENT browser context (temp userDataDir). Confirm both panel
//      icons present via initializeLayout (fresh origin).
//   2. Force a `storeLayout()` write (navigate away triggers `onUnload`),
//      then kill server A.
//   3. Start server B (book B, a SEPARATE isolated copy) on the SAME port P.
//   4. In the SAME persistent context/profile, navigate to the SAME origin
//      URL. Read shell state again: are the panel icons present, and — the
//      question that matters — is `restoreLayout()` short-circuiting
//      `initializeLayout()` (i.e. would a STALE pre-fix layout have masked
//      the fix forever at this origin)?
//
// Cleanup: kills only servers this script started, removes only workspace
// copies and the persistent profile dir it created. Never touches the
// author's live process (apps/browser/lib/backend/main.js on port 3311)
// bound to examples/sample-book — this script never reads/writes that path
// and always allocates its own free ports.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import {
  createIsolatedSampleWorkspace,
  removeIsolatedSampleWorkspace
} from '../../scripts/narrative-knowledge-round-trip.mjs';

const repoRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const appDir = join(repoRoot, 'apps/browser');
const sampleBookSource = join(repoRoot, 'examples/sample-book');

const WIDGET_IDS = ['ai-focused-editor.narrative-map', 'ai-focused-editor.entity-cards'];

function viewIconPresenceReaderScript(widgetIds) {
  return `(() => {
    const container = window.theia && window.theia.container;
    if (!container) { return { ok: false, error: 'the Theia container is not available' }; }
    const findKey = (label) => {
      for (const [candidate] of container._bindingDictionary._map.entries()) {
        const candidateLabel = candidate && (candidate.description || candidate.name);
        if (candidateLabel === label) { return candidate; }
      }
      return undefined;
    };
    try {
      const shellKey = findKey('ApplicationShell');
      const widgetManagerKey = findKey('WidgetManager');
      if (!shellKey) { return { ok: false, error: 'ApplicationShell is not bound in this container' }; }
      if (!widgetManagerKey) { return { ok: false, error: 'WidgetManager is not bound in this container' }; }
      const shell = container.get(shellKey);
      const widgetManager = container.get(widgetManagerKey);
      const ids = ${JSON.stringify(widgetIds)};
      const results = ids.map(id => {
        const widget = widgetManager.tryGetWidget(id);
        if (!widget) { return { id, present: false }; }
        const area = shell.getAreaFor(widget);
        const tabBar = shell.getTabBarFor(widget);
        return {
          id,
          present: true,
          isAttached: !!widget.isAttached,
          area: area || null,
          inTabBar: !!tabBar,
          isCurrentInTabBar: !!(tabBar && tabBar.currentTitle === widget.title),
          isShellActive: shell.activeWidget === widget,
          iconClass: widget.title.iconClass || ''
        };
      });
      return { ok: true, results, localStorageKeys: Object.keys(window.localStorage), pathname: window.location.pathname, hash: window.location.hash };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`;
}

async function getFreePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  const freePort = typeof address === 'object' && address ? address.port : 0;
  probe.close();
  await once(probe, 'close');
  return freePort;
}

async function waitForServer(targetUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(targetUrl);
      if (response.ok || response.status < 500) return;
      lastError = new Error(`Unexpected HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${targetUrl}`);
}

async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise(resolve => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(true));
    });
    if (free) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Port ${port} did not free up in time`);
}

function startServer(port, root) {
  const server = spawn(process.execPath, [
    'node_modules/@theia/cli/bin/theia.js', 'start',
    '--hostname', '127.0.0.1', '--port', String(port), root
  ], { cwd: appDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', c => { output += c.toString(); });
  server.stderr.on('data', c => { output += c.toString(); });
  return { server, getOutput: () => output };
}

async function stopServer(server) {
  if (!server) return;
  server.kill('SIGTERM');
  await Promise.race([
    once(server, 'exit'),
    new Promise(resolve => setTimeout(resolve, 5_000))
  ]);
}

async function readShellState(page) {
  return page.evaluate(viewIconPresenceReaderScript(WIDGET_IDS));
}

async function waitForAppLoaded(page, timeoutMs = 60_000) {
  await page.waitForFunction(() =>
    document.title.includes('AI Focused Editor') ||
    Boolean(document.querySelector('.theia-ApplicationShell, #theia-app-shell, .p-Widget')),
  undefined, { timeout: timeoutMs });
  await page.waitForFunction(() =>
    (document.querySelector('#theia-statusBar')?.textContent ?? '').includes('AI:'),
  undefined, { timeout: timeoutMs });
  // Give initializeLayout / restoreLayout (both async) a moment to settle.
  await page.waitForTimeout(1500);
}

let workspaceADir, workspaceBDir, profileDir;
let serverAHandle, serverBHandle;
let context;

try {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;

  const wsA = await createIsolatedSampleWorkspace(sampleBookSource);
  workspaceADir = wsA.workspaceDir;
  const wsB = await createIsolatedSampleWorkspace(sampleBookSource);
  workspaceBDir = wsB.workspaceDir;

  profileDir = await mkdtemp(join(tmpdir(), 'afe-ur039-profile-'));

  console.log(`[setup] port=${port}`);
  console.log(`[setup] book A root: ${wsA.sampleRoot}`);
  console.log(`[setup] book B root: ${wsB.sampleRoot}`);
  console.log(`[setup] persistent profile: ${profileDir}`);

  // --- Step 1: server A, fresh origin, fresh profile ---
  serverAHandle = startServer(port, wsA.sampleRoot);
  await waitForServer(url, 120_000);

  context = await chromium.launchPersistentContext(profileDir, {
    headless: process.env.HEADED !== '1'
  });
  const page = await context.newPage();
  const relevantLogs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (/Restoring the layout|Nothing to restore|has been successfully restored|Initialize the workbench layout|Storing the layout/.test(text)) {
      relevantLogs.push(text);
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForAppLoaded(page);

  const stateA = await readShellState(page);
  console.log('\n=== Book A (fresh origin, fresh profile) shell state ===');
  console.log(JSON.stringify(stateA, null, 2));
  console.log('Book A layout-restore console trace:', relevantLogs);
  relevantLogs.length = 0;

  // --- Step 2: force a storeLayout() write for book A's workspace, then tear down server A ---
  // Empirically, neither a real `page.goto` navigation nor a synthetic
  // `window.dispatchEvent(new Event('unload'))` reliably reaches
  // DefaultWindowService's real 'unload' listener under Playwright/CDP
  // (verified separately: a custom listener added at the same time DOES
  // fire on dispatch, but Theia's own store-on-unload log line never
  // appears) — so we call `ShellLayoutRestorer.storeLayout(app)` directly
  // through the DI container, which IS the exact function `onUnload` would
  // have invoked. This makes the "was anything ever saved for this workspace"
  // positive-control deterministic instead of depending on an unreliable
  // browser-lifecycle event.
  const forcedStore = await page.evaluate(() => {
    const container = window.theia && window.theia.container;
    const findKey = (label) => {
      for (const [candidate] of container._bindingDictionary._map.entries()) {
        const candidateLabel = candidate && (candidate.description || candidate.name);
        if (candidateLabel === label) return candidate;
      }
      return undefined;
    };
    const restorerKey = findKey('ShellLayoutRestorer');
    const appKey = findKey('FrontendApplication');
    if (!restorerKey || !appKey) return { ok: false, error: 'binding missing' };
    const restorer = container.get(restorerKey);
    const app = container.get(appKey);
    restorer.storeLayout(app);
    return { ok: true, keys: Object.keys(window.localStorage) };
  });
  console.log('\n[step 2] forced storeLayout() for book A workspace:', JSON.stringify(forcedStore));
  await page.waitForTimeout(300);

  await stopServer(serverAHandle.server);
  serverAHandle = undefined;
  await waitForPortFree(port, 15_000);

  // --- Step 3: server B, SAME port (=> SAME origin), DIFFERENT workspace ---
  serverBHandle = startServer(port, wsB.sampleRoot);
  await waitForServer(url, 120_000);

  // --- Step 4: SAME persistent profile/context, navigate back to the SAME origin ---
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForAppLoaded(page);

  const stateB = await readShellState(page);
  console.log('\n=== Book B (SAME origin/port, SAME profile, workspace never seen before) shell state ===');
  console.log(JSON.stringify(stateB, null, 2));
  console.log('Book B layout-restore console trace:', relevantLogs);
  relevantLogs.length = 0;

  // --- Step 5 (positive control): tear down server B, restart on the SAME
  // port bound to book A's workspace again (the one we forced a save for in
  // step 2). Same origin, same profile, but this workspace key DOES have
  // saved data now -> restoreLayout() should succeed and createDefaultLayout
  // (initializeLayout) should NOT run again.
  await stopServer(serverBHandle.server);
  serverBHandle = undefined;
  await waitForPortFree(port, 15_000);
  serverAHandle = startServer(port, wsA.sampleRoot);
  await waitForServer(url, 120_000);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForAppLoaded(page);
  const stateA2 = await readShellState(page);
  console.log('\n=== Book A revisited (same workspace, saved layout exists) shell state ===');
  console.log(JSON.stringify(stateA2, null, 2));
  console.log('Book A revisited layout-restore console trace:', relevantLogs);

  const summarize = (state) => {
    if (!state || !state.ok) return `ERROR: ${state ? state.error : 'no result'}`;
    return state.results.map(r => `${r.id}: present=${r.present} area=${r.area} inTabBar=${r.inTabBar}`).join(' | ');
  };
  console.log('\n=== SUMMARY ===');
  console.log('Book A (fresh):', summarize(stateA));
  console.log('Book B (fresh, same origin as A):', summarize(stateB));
  console.log('Book A revisited (restored, same origin):', summarize(stateA2));
} finally {
  if (context) {
    try { await context.close(); } catch (e) { console.warn('context close failed', e); }
  }
  await stopServer(serverAHandle?.server);
  await stopServer(serverBHandle?.server);
  await removeIsolatedSampleWorkspace(workspaceADir);
  await removeIsolatedSampleWorkspace(workspaceBDir);
  if (profileDir) {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}
