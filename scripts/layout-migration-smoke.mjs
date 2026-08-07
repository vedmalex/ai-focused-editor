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
} from './narrative-knowledge-round-trip.mjs';

// TASK-022 UR-040 — the shell-layout migration tooth.
//
// `scripts/browser-smoke.mjs`'s `assertViewIconsPresentOnStartup` (UR-039)
// only ever boots ONE fresh workspace, so it can only ever observe state 1
// below. It cannot and must not be extended to cover this: proving states 2
// and 3 requires a PERSISTENT browser profile carrying real
// `localStorage` across two separate page loads of the SAME workspace — an
// ephemeral `chromium.launch()` context (what `browser-smoke.mjs` uses)
// throws that state away on `browser.close()` by construction. Hence a
// separate script, wired into `verify` as its own step.
//
// UR-040 requires the migration to tell THREE states apart, and this script
// proves the code does — for real, against the real production module
// (`packages/manuscript-workspace/src/browser/layout-panel-migration.ts`,
// `narrative-map-view-contribution.ts`, `entity-cards-view-contribution.ts`),
// not a unit stand-in:
//
//   1. Fresh book, no saved layout at all — both panels present
//      (`initializeLayout`, already covered by `browser-smoke.mjs`, checked
//      again here for free since step 2's capture run passes through this
//      state first).
//   2. A layout saved by a version of the app that PREDATES these panels
//      (constructed here by capturing a real, current layout and
//      mechanically stripping the two panels' `WidgetDescription`s back
//      out — see `stripWidgetDescriptions`) — after restore, both panels
//      are present (`onDidInitializeLayout`'s migration ran).
//   3. The SAME workspace, later, after the author closed one of the two
//      panels post-migration — after a fresh page load, that panel STAYS
//      CLOSED. This is the state a naive "is it attached? add it if not"
//      re-check (the forbidden shape UR-040 explicitly rules out) cannot
//      produce: it would resurrect the panel on every single launch.
//
// Case 3 is the one that actually distinguishes a real fix from the
// forbidden naive shape: verified negatively during TASK-022 IMPLEMENT by
// temporarily making `ensurePanelMigrated` unconditional (always call
// `addPanel`) — this script's state-3 assertion went red with exactly the
// "REGRESSION" message below. Not kept in-tree as a toggle; see the task's
// implementation report for the exact failing output.

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const appDir = join(repoRoot, 'apps/browser');
const sampleBookSource = join(repoRoot, 'examples/sample-book');

const WIDGETS = [
  { id: 'ai-focused-editor.narrative-map', label: 'Narrative Map' },
  { id: 'ai-focused-editor.entity-cards', label: 'Knowledge Cards' },
  // gh#47: the UR-040 backfill for a saved layout older than THIS panel needs
  // the same guard, or the migration is only enforced for the panels that
  // happened to exist when the check was written.
  { id: 'ai-focused-editor.entity-card', label: 'Knowledge Card' }
];
const WIDGET_IDS = WIDGETS.map(w => w.id);
const WIDGET_FACTORY_IDS = new Set(WIDGET_IDS);

let workspaceDir;
let boot1Server;
let boot2Server;
let boot1Browser;
let boot2ProfileDir;
let boot2Context;

try {
  // -------------------------------------------------------------------
  // Boot 1: capture a REAL current layout, then mechanically strip the
  // two UR-039 panels back out of it, to stand in for a layout genuinely
  // saved before those panels existed.
  // -------------------------------------------------------------------
  const { workspaceDir: wsDir, sampleRoot } = await createIsolatedSampleWorkspace(sampleBookSource);
  workspaceDir = wsDir;

  const port1 = await getFreePort();
  const url1 = `http://127.0.0.1:${port1}`;
  boot1Server = startServer(port1, sampleRoot);
  await waitForServer(url1, 120_000);

  boot1Browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const page1 = await boot1Browser.newPage();
  await page1.goto(url1, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForAppLoaded(page1);

  // State 1 (fresh book, no saved layout): both panels present via
  // `initializeLayout`. Free confirmation, same assertion browser-smoke.mjs
  // makes for UR-039 — kept here so this script tells the complete
  // three-state story on its own.
  const freshState = await readShellState(page1);
  assertPanelsPresentNotOpen(freshState, 'state 1 (fresh book)');
  console.log('PASS state 1 (fresh book): both panels present via initializeLayout, not opened.');

  await forceStoreLayout(page1);
  const { key: layoutKey, layoutObject } = await readLayoutObject(page1);
  const strippedLayoutObject = stripWidgetDescriptions(layoutObject, WIDGET_FACTORY_IDS);
  const strippedPresence = describeWidgetPresence(strippedLayoutObject, WIDGET_FACTORY_IDS);
  for (const id of WIDGET_IDS) {
    if (strippedPresence[id]) {
      throw new Error(
        `stripWidgetDescriptions() left "${id}" in the captured layout — the old-layout ` +
        'simulation for state 2 would be invalid (it would not actually be missing the panel).'
      );
    }
  }
  console.log(`Captured + stripped a pre-UR-039-shaped layout under key "${layoutKey}".`);

  await boot1Browser.close();
  boot1Browser = undefined;
  await stopServer(boot1Server);
  boot1Server = undefined;
  await waitForPortFree(port1, 15_000);

  // -------------------------------------------------------------------
  // Boot 2: a BRAND NEW persistent profile, seeded with the stripped
  // (pre-UR-039-shaped) layout for the SAME workspace, under the SAME
  // localStorage key captured above. If the key format assumption is
  // wrong for any reason, `assertRealRestoreHappened` below catches it —
  // it does not silently fall through to the fresh-layout path.
  // -------------------------------------------------------------------
  const port2 = await getFreePort();
  const url2 = `http://127.0.0.1:${port2}`;
  boot2Server = startServer(port2, sampleRoot);
  await waitForServer(url2, 120_000);

  // Seed the stripped layout via a ONE-SHOT `addInitScript`, guarded by its
  // own sentinel key. `addInitScript` runs before every navigation in the
  // context by design (that's the point for its usual auth-state use case)
  // — an UNGUARDED seed would silently re-inject this
  // stripped/pre-UR-039-shaped layout again on the state-3 `reload()` below,
  // permanently masking whatever the app itself had actually persisted by
  // then (confirmed empirically during TASK-022 IMPLEMENT: an earlier
  // version of this script did exactly that, and states 1/2 looked correct
  // while state 3 failed for a reason that had nothing to do with the
  // product code — the "old layout" kept coming back on every reload,
  // clobbering the app's own real write). The sentinel makes the seed apply
  // exactly once, on the very first navigation, standing in for "a
  // pre-UR-040 build once wrote this layout, then the app was upgraded" —
  // every navigation after that reflects only what the app itself persists.
  boot2ProfileDir = await mkdtemp(join(tmpdir(), 'afe-layout-migration-profile-'));
  boot2Context = await chromium.launchPersistentContext(boot2ProfileDir, {
    headless: process.env.HEADED !== '1'
  });
  const seedSentinelKey = '__afeLayoutMigrationSmokeSeedApplied';
  await boot2Context.addInitScript(
    ({ key, value, sentinelKey }) => {
      if (!window.localStorage.getItem(sentinelKey)) {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem(sentinelKey, '1');
      }
    },
    { key: layoutKey, value: JSON.stringify(JSON.stringify(strippedLayoutObject)), sentinelKey: seedSentinelKey }
  );

  const page2 = await boot2Context.newPage();
  const restoreLog = [];
  page2.on('console', msg => {
    const text = msg.text();
    if (/Restoring the layout|Nothing to restore|has been successfully restored|Storing the layout/.test(text)) {
      restoreLog.push(text);
    }
  });
  await page2.goto(url2, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForAppLoaded(page2);
  assertRealRestoreHappened(restoreLog, 'state 2 boot');

  // State 2 (old layout, panels missing): the migration must have added
  // BOTH panels back, present but not opened — same shape as
  // `initializeLayout` produces for a fresh book, so a fresh book and a
  // migrated old book are indistinguishable to the author.
  const migratedState = await readShellState(page2);
  assertPanelsPresentNotOpen(migratedState, 'state 2 (migrated old layout)');
  console.log('PASS state 2 (old layout, panels missing): migration added both panels, not opened.');

  await assertMigrationMarkersSet(page2);
  console.log('PASS state 2: per-widget migration-version markers are now set.');

  // Now the author closes ONE of the two panels, deliberately, AFTER the
  // migration ran — the exact scenario the marker exists to protect.
  await closeWidget(page2, 'ai-focused-editor.entity-cards');
  await forceStoreLayout(page2);
  restoreLog.length = 0;

  // -------------------------------------------------------------------
  // Case 3: a fresh page load of the SAME workspace/profile — nothing
  // seeded this time, this is the app's own real persisted state.
  // -------------------------------------------------------------------
  await page2.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForAppLoaded(page2);
  assertRealRestoreHappened(restoreLog, 'state 3 reload');

  const postCloseState = await readShellState(page2);
  const narrativeMap = postCloseState.get('ai-focused-editor.narrative-map');
  const entityCards = postCloseState.get('ai-focused-editor.entity-cards');

  if (!narrativeMap || !narrativeMap.present) {
    throw new Error(
      'state 3: "Narrative Map" (never closed) disappeared across reload — it should have been ' +
      'restored normally like any other still-open widget.'
    );
  }
  if (entityCards && entityCards.present) {
    throw new Error(
      'state 3 REGRESSION: "Knowledge Cards" (ai-focused-editor.entity-cards) was closed by the ' +
      'author AFTER the migration ran, then reappeared after a reload. The migration must run at ' +
      'most once per workspace (gated by the persisted per-widget marker in ' +
      '`ensurePanelMigrated`) — it must never re-add a panel just because it is not currently ' +
      `attached to the shell. Observed state: ${JSON.stringify(entityCards)}.`
    );
  }
  console.log(
    'PASS state 3 (post-migration close persists): "Narrative Map" still present, ' +
    '"Knowledge Cards" stayed closed after reload — the migration did not resurrect it.'
  );

  console.log(`Layout migration smoke passed: ${url2}`);
} catch (error) {
  console.error('Layout migration smoke failed.');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  if (boot2Context) {
    await boot2Context.close().catch(() => {});
  }
  if (boot1Browser) {
    await boot1Browser.close().catch(() => {});
  }
  await stopServer(boot1Server);
  await stopServer(boot2Server);
  await removeIsolatedSampleWorkspace(workspaceDir);
  if (boot2ProfileDir) {
    await rm(boot2ProfileDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Server/port plumbing (same shape as scripts/browser-smoke.mjs and the
// TASK-022 UR-039 research probe this script grew out of).
// ---------------------------------------------------------------------------

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
      if (response.ok || response.status < 500) {
        return;
      }
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
    if (free) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Port ${port} did not free up in time`);
}

function startServer(port, root) {
  const server = spawn(process.execPath, [
    'node_modules/@theia/cli/bin/theia.js',
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
    root
  ], {
    cwd: appDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  server.getOutput = () => output;
  return server;
}

async function stopServer(server) {
  if (!server) {
    return;
  }
  server.kill('SIGTERM');
  await Promise.race([
    once(server, 'exit'),
    new Promise(resolve => setTimeout(resolve, 5_000))
  ]);
}

async function waitForAppLoaded(page, timeoutMs = 60_000) {
  await page.waitForFunction(() =>
    document.title.includes('AI Focused Editor') ||
    Boolean(document.querySelector('.theia-ApplicationShell, #theia-app-shell, .p-Widget')),
  undefined, { timeout: timeoutMs });
  await page.waitForFunction(() =>
    (document.querySelector('#theia-statusBar')?.textContent ?? '').includes('AI:'),
  undefined, { timeout: timeoutMs });
  // Give initializeLayout/restoreLayout/onDidInitializeLayout (all async) a
  // moment to settle after the status bar signal above.
  await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------
// Theia DI container access from the renderer. `container._bindingDictionary`
// is inversify's internal storage — used because Theia binds services under
// Symbol/class keys, not string tokens, so there is no public "get by name"
// API from outside the bundle. Same lookup shape as
// `scripts/browser-smoke.mjs`'s `viewIconPresenceReaderScript`.
// ---------------------------------------------------------------------------

function containerLookupPrelude() {
  return `
    const container = window.theia && window.theia.container;
    if (!container) { throw new Error('Theia container is not available'); }
    const findKey = (label) => {
      for (const [candidate] of container._bindingDictionary._map.entries()) {
        const candidateLabel = candidate && (candidate.description || candidate.name);
        if (candidateLabel === label) { return candidate; }
      }
      throw new Error('No Theia binding found: ' + label);
    };
  `;
}

function viewIconPresenceReaderScript(widgetIds) {
  return `(() => {
    ${containerLookupPrelude()}
    try {
      const shell = container.get(findKey('ApplicationShell'));
      const widgetManager = container.get(findKey('WidgetManager'));
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
          isShellActive: shell.activeWidget === widget
        };
      });
      return { ok: true, results };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`;
}

async function readShellState(page) {
  const snapshot = await page.evaluate(viewIconPresenceReaderScript(WIDGET_IDS));
  if (!snapshot.ok) {
    throw new Error(`could not read shell state: ${snapshot.error}`);
  }
  return new Map(snapshot.results.map(result => [result.id, result]));
}

function assertPanelsPresentNotOpen(stateById, contextLabel) {
  for (const { id, label } of WIDGETS) {
    const result = stateById.get(id);
    if (!result || !result.present) {
      throw new Error(`${contextLabel}: "${label}" (${id}) is NOT present in the shell.`);
    }
    if (!result.isAttached || result.area !== 'right' || !result.inTabBar) {
      throw new Error(
        `${contextLabel}: "${label}" (${id}) exists but is not attached to the right panel ` +
        `(isAttached=${result.isAttached}, area=${JSON.stringify(result.area)}, inTabBar=${result.inTabBar}).`
      );
    }
    if (result.isShellActive || result.isCurrentInTabBar) {
      throw new Error(
        `${contextLabel}: "${label}" (${id}) is ACTIVE/revealed — it must be present as an icon ` +
        'only (activate: false, reveal: false), not opened.'
      );
    }
  }
}

async function forceStoreLayout(page) {
  // Empirically (TASK-022 UR-039 research probe), neither a real
  // `page.goto` navigation nor a synthetic `unload` event reliably reaches
  // `DefaultWindowService`'s real listener under Playwright/CDP. Calling
  // `ShellLayoutRestorer.storeLayout(app)` directly through the DI
  // container is the exact function `onUnload` would have invoked, so this
  // makes "a layout was saved" deterministic instead of depending on a
  // flaky browser-lifecycle event.
  const result = await page.evaluate(`(() => {
    ${containerLookupPrelude()}
    const restorer = container.get(findKey('ShellLayoutRestorer'));
    const app = container.get(findKey('FrontendApplication'));
    restorer.storeLayout(app);
    return { ok: true };
  })()`);
  if (!result.ok) {
    throw new Error('forceStoreLayout: storeLayout() did not report ok');
  }
}

async function closeWidget(page, widgetId) {
  const result = await page.evaluate(`(async () => {
    ${containerLookupPrelude()}
    const shell = container.get(findKey('ApplicationShell'));
    await shell.closeWidget(${JSON.stringify(widgetId)});
    return { ok: true };
  })()`);
  if (!result.ok) {
    throw new Error(`closeWidget(${widgetId}) did not report ok`);
  }
}

/**
 * Read the single `...:layout` localStorage entry back as a real JS object.
 * `LocalStorageService.setData` stores `JSON.stringify(data)`, and the
 * `data` `ShellLayoutRestorer.storeLayout` hands it is ITSELF already a
 * JSON string (`this.deflate(layoutData)`) — so the raw localStorage value
 * is double-encoded. Undo both layers to get the actual layout tree.
 */
async function readLayoutObject(page) {
  const raw = await page.evaluate(() => {
    const keys = Object.keys(window.localStorage);
    const layoutKey = keys.find(key => key.endsWith(':layout'));
    if (!layoutKey) {
      return { ok: false, error: `no localStorage key ending in ":layout" (keys: ${keys.join(', ')})` };
    }
    return { ok: true, key: layoutKey, value: window.localStorage.getItem(layoutKey) };
  });
  if (!raw.ok) {
    throw new Error(`readLayoutObject: ${raw.error}`);
  }
  const deflatedString = JSON.parse(raw.value);
  const layoutObject = JSON.parse(deflatedString);
  return { key: raw.key, layoutObject };
}

/**
 * Recursively drop any `WidgetDescription` (an object with
 * `constructionOptions.factoryId`) matching `factoryIds`, wherever it
 * appears in a parsed `ApplicationShell.LayoutData` tree — inside a
 * `widgets` ARRAY (dropped as an array element) or as a singular `widget`
 * property (dropped as a key). Mirrors exactly what
 * `ShellLayoutRestorer.parse()`'s `isWidgetsProperty`/`isWidgetProperty`
 * branches treat as "a widget lives here".
 */
function stripWidgetDescriptions(node, factoryIds) {
  const isTargetDescription = value =>
    Boolean(value) && typeof value === 'object' &&
    value.constructionOptions && factoryIds.has(value.constructionOptions.factoryId);

  // The right/left side panels don't store a flat `widgets` array of
  // `WidgetDescription`s — `SidePanelHandler.getLayoutData()`
  // (`@theia/core/lib/browser/shell/side-panel-handler.js`) stores
  // `items: [{ widget, rank, expanded, pinned }]`, wrapping each
  // description under a SINGULAR `widget` property one level down. Both
  // UR-039 panels live there (`defaultWidgetOptions.area: 'right'`), so an
  // array element counts as "this widget" if it either IS a
  // `WidgetDescription` itself (main/bottom panel's flatter shape) OR WRAPS
  // one under `.widget` (side panel's shape) — either way the whole element
  // is dropped, not just the nested `widget` key, so no empty/dangling
  // `{rank, expanded, pinned}` husk is left behind in `items`.
  const wrapsTargetWidget = item =>
    Boolean(item) && typeof item === 'object' &&
    (isTargetDescription(item) || isTargetDescription(item.widget));

  if (Array.isArray(node)) {
    return node
      .filter(item => !wrapsTargetWidget(item))
      .map(item => stripWidgetDescriptions(item, factoryIds));
  }
  if (node && typeof node === 'object') {
    const copy = {};
    for (const [key, value] of Object.entries(node)) {
      copy[key] = stripWidgetDescriptions(value, factoryIds);
    }
    return copy;
  }
  return node;
}

/** Self-check companion to {@link stripWidgetDescriptions}: does the tree still mention a factoryId? */
function describeWidgetPresence(node, factoryIds, found = {}) {
  if (Array.isArray(node)) {
    node.forEach(item => describeWidgetPresence(item, factoryIds, found));
  } else if (node && typeof node === 'object') {
    const candidates = [node, node.widget];
    for (const candidate of candidates) {
      if (candidate && candidate.constructionOptions && factoryIds.has(candidate.constructionOptions.factoryId)) {
        found[candidate.constructionOptions.factoryId] = true;
      }
    }
    for (const value of Object.values(node)) {
      describeWidgetPresence(value, factoryIds, found);
    }
  }
  return found;
}

/**
 * Guards against a silently-wrong key/format assumption in this script
 * turning "state 2/3 passed" into a false positive: if the seeded layout was
 * never actually found (e.g. the localStorage key this script computed does
 * not match what `WorkspaceStorageService` actually used), Theia falls back
 * to `createDefaultLayout()` — the SAME code path as a genuinely fresh book
 * — and both panels would appear via `initializeLayout`, not via the
 * migration this test exists to prove. The frontend logs
 * "Nothing to restore." in exactly that case (see
 * `ShellLayoutRestorer.restoreLayout` in `shell-layout-restorer.js`); its
 * absence here is the proof this run actually exercised the restore path.
 */
function assertRealRestoreHappened(restoreLog, contextLabel) {
  if (restoreLog.some(line => line.includes('Nothing to restore'))) {
    throw new Error(
      `${contextLabel}: the frontend logged "Nothing to restore." — the seeded/persisted layout ` +
      'was not found, so this run fell back to the fresh-layout path and does NOT prove the ' +
      `migration. Console lines observed: ${JSON.stringify(restoreLog)}`
    );
  }
  if (!restoreLog.some(line => line.includes('successfully restored'))) {
    throw new Error(
      `${contextLabel}: expected a "has been successfully restored" log line and did not see one. ` +
      `Console lines observed: ${JSON.stringify(restoreLog)}`
    );
  }
}

/**
 * Confirms `ensurePanelMigrated` actually wrote its persisted marker for
 * both panels (not just that the widgets happen to be present) — the
 * marker, not the widgets' live attachment, is the mechanism the boundary
 * in UR-040 depends on.
 */
async function assertMigrationMarkersSet(page) {
  const markers = await page.evaluate(() => {
    const keys = Object.keys(window.localStorage);
    const find = suffix => {
      const key = keys.find(k => k.endsWith(':' + suffix));
      return key ? JSON.parse(window.localStorage.getItem(key)) : undefined;
    };
    return {
      narrativeMap: find('ai-focused-editor.narrativeMap.layoutMigrationVersion'),
      entityCards: find('ai-focused-editor.entityCards.layoutMigrationVersion')
    };
  });
  if (typeof markers.narrativeMap !== 'number' || markers.narrativeMap < 1) {
    throw new Error(`narrativeMap layout-migration marker was not set as expected: ${JSON.stringify(markers)}`);
  }
  if (typeof markers.entityCards !== 'number' || markers.entityCards < 1) {
    throw new Error(`entityCards layout-migration marker was not set as expected: ${JSON.stringify(markers)}`);
  }
}
