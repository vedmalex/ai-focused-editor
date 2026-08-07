import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import {
  assertNarrativeKnowledgeRoundTrip,
  probeReaderScript,
  assertNarrativeToolsRegistered,
  toolRegistryReaderScript,
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

const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const appDir = join(repoRoot, 'apps/browser');
const sampleBookSource = join(repoRoot, 'examples/sample-book');
// TASK-022 ISS-365: drive an isolated, disposable copy of the fixture
// manuscript, never examples/sample-book itself — see
// createIsolatedSampleWorkspace's doc comment for why.
const { workspaceDir: smokeWorkspaceDir, sampleRoot } = await createIsolatedSampleWorkspace(sampleBookSource);
const port = Number(process.env.AFE_SMOKE_PORT || await getFreePort());
const url = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [
  'node_modules/@theia/cli/bin/theia.js',
  'start',
  '--hostname',
  '127.0.0.1',
  '--port',
  String(port),
  sampleRoot
], {
  cwd: appDir,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
server.stdout.on('data', chunk => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', chunk => {
  serverOutput += chunk.toString();
});

let browser;
try {
  await waitForServer(url, 120_000);
  browser = await chromium.launch({
    headless: process.env.HEADED !== '1'
  });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__afeSmokeGetBindingByKeyName = name => {
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
    window.__afeSmokeGetCommandRegistry = () =>
      window.theia.container.get(window.__afeSmokeGetBindingByKeyName('CommandRegistry'));
  });
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });

  await page.waitForFunction(() =>
    document.title.includes('AI Focused Editor') ||
    Boolean(document.querySelector('.theia-ApplicationShell, #theia-app-shell, .p-Widget')),
  undefined, {
    timeout: 60_000
  });

  await page.waitForFunction(() => {
    const shellText = document.querySelector('#theia-app-shell')?.textContent ?? '';
    return document.title.includes('sample-book') ||
      shellText.includes('chapter-01.md') ||
      shellText.includes('sample-book');
  }, undefined, {
    timeout: 45_000
  });

  await page.waitForFunction(() =>
    (document.querySelector('#theia-statusBar')?.textContent ?? '').includes('AI:'),
  undefined, {
    timeout: 20_000
  });

  // UR-039: the Narrative Map and Entity Cards panels must be visible as
  // icons in the right side panel from the FIRST launch, without the user
  // having to search for and run their open command — this is what
  // `NarrativeMapViewContribution.initializeLayout` /
  // `EntityCardsViewContribution.initializeLayout` now provide (mirroring
  // `ManuscriptTreeViewContribution` and `@theia/outline-view`, which already
  // did this for the left/right panels the author DID find on first launch).
  //
  // This check runs BEFORE any `entities.refreshCards`/open command below —
  // deliberately, since the whole point is to observe presence that Theia's
  // OWN startup layout produced, not presence this script caused by opening
  // the view itself. A command-driven smoke (execute the open command, then
  // check the widget exists) is exactly the "green by construction" shape
  // that missed this defect in the field: it never asks whether the widget
  // was DISCOVERABLE, only whether it CAN be opened.
  await assertViewIconsPresentOnStartup(
    () => page.evaluate(viewIconPresenceReaderScript([
      'ai-focused-editor.narrative-map',
      'ai-focused-editor.entity-cards',
      'ai-focused-editor.entity-card'
    ])),
    'browser',
    [
      { id: 'ai-focused-editor.narrative-map', label: 'Narrative Map' },
      { id: 'ai-focused-editor.entity-cards', label: 'Knowledge Cards' },
      // gh#47 WP-5. Added here on the SAME day the panel was written, not later:
      // this check is the only one that distinguishes "present in the shell"
      // from "openable by command", and it is what caught UR-039.
      { id: 'ai-focused-editor.entity-card', label: 'Knowledge Card' }
    ]
  );

  await assertCommandsRegistered(page, [
    'ai-focused-editor.workspace.validate',
    'ai-focused-editor.manuscriptTree.refresh',
    'ai-focused-editor.sources.refresh',
    'ai-focused-editor.entities.refreshCards',
    'ai-focused-editor.bookBuild.buildMarkdown',
    'ai-focused-editor.bookBuild.buildHtml',
    'ai-focused-editor.semanticMarkdown.preview.refresh'
  ]);

  await executeCommand(page, 'ai-focused-editor.manuscriptTree.refresh');
  await executeCommand(page, 'ai-focused-editor.sources.refresh');
  await executeCommand(page, 'ai-focused-editor.entities.refreshCards');

  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return text.includes('Sources') &&
      text.includes('Knowledge Cards');
  }, undefined, {
    timeout: 20_000
  });

  await startCommand(page, 'ai-focused-editor.workspace.validate');
  await page.waitForFunction(() =>
    document.body.innerText.includes('Manuscript workspace:'),
  undefined, {
    timeout: 20_000
  });

  // TASK-022 WP-0: the narrative-knowledge RPC round-trip, read off the value
  // the frontend probe recorded at start.
  await assertNarrativeKnowledgeRoundTrip(
    () => page.evaluate(probeReaderScript()),
    'browser'
  );

  // TASK-022 WP-6: the four read-only AI tools reached the invocation registry.
  // `bindToolProvider` runs inside a ContainerModule no `bun` lane can
  // instantiate, so this is the only place a missing binding is visible at all.
  await assertNarrativeToolsRegistered(
    () => page.evaluate(toolRegistryReaderScript()),
    'browser'
  );

  // TASK-022 ISS-354 AC-6: prove the index actually BUILDS and POPULATES in
  // this target, not only that the RPC channel answers with the right shape
  // (the probe above only ever observes `absent`/`not-built`).
  await assertNarrativeKnowledgeRebuildReady(
    () => page.evaluate(rebuildRoundTripReaderScript()),
    'browser'
  );

  // TASK-022 #46 follow-up: NOW that the index is `ready` and populated, prove
  // the exact three-envelope precondition `applyDiagnostics()` requires before
  // it will publish anything — `getMentions`/`getRelations`/`getDuplicateEntities`
  // all `ready`, all the SAME `generation`. Never observed against a live
  // backend before this: no `bun` lane can instantiate the contribution, and
  // `getDuplicateEntities` never crossed the real RPC boundary in the unit tests.
  await assertNarrativeKnowledgeDiagnosticsEnvelopesAgree(
    () => page.evaluate(diagnosticsEnvelopesReaderScript()),
    'browser'
  );

  // TASK-022 ISS-359: the index must update ITSELF from an on-disk edit, with
  // NO call to `rebuild()` anywhere in the check — the one shape of proof that
  // catches "the file watcher never starts in a running application" (every
  // check above either observes the never-populated start-up probe or drives
  // `rebuild()` explicitly, which works whether or not a maintainer exists at
  // all). Runs LAST and edits/restores a real fixture file on disk.
  await assertNarrativeKnowledgeWatcherSelfUpdates(
    () => page.evaluate(watcherStatusSnapshotReaderScript()),
    'browser'
  );

  // TASK-022 UR-043: the OPEN Entity Cards widget (opened above by
  // `entities.refreshCards` at line ~143, still open here) must redraw itself
  // from the backend's `onIndexChanged` push. This is deliberately the LAST
  // check in the file and runs after the watcher self-update tooth above —
  // it needs the index already `ready` and this exact card indexed, which
  // that tooth's own predecessor (`assertNarrativeKnowledgeRebuildReady`)
  // already established.
  await assertEntityCardsWidgetSelfUpdatesOnPush(
    () => page.evaluate(entityCardsWidgetTextReaderScript()),
    'browser'
  );

  console.log(`Browser smoke passed: ${url}`);
} catch (error) {
  console.error('Browser smoke failed.');
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
  await Promise.race([
    once(server, 'exit'),
    new Promise(resolve => setTimeout(resolve, 5_000))
  ]);
  await removeIsolatedSampleWorkspace(smokeWorkspaceDir);
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

/**
 * Renderer-side reader (TASK-022 UR-039): report, for each widget id, whether
 * it is already attached to the shell and where — WITHOUT touching the
 * widget's open/toggle command. `WidgetManager.tryGetWidget` returns a widget
 * only if one was already created; `ApplicationShell.getAreaFor`/
 * `getTabBarFor` report where an ALREADY-ATTACHED widget lives. Neither call
 * creates or opens anything, so a `present`/`isAttached` result here can only
 * be explained by Theia's own startup layout (`initializeLayout`), never by
 * this reader.
 *
 * Same binding-lookup shape as the other readers in
 * `narrative-knowledge-round-trip.mjs` (`candidate.description || candidate.name`),
 * repeated here rather than imported: this check is about shell/view state,
 * not the narrative-knowledge index that file is scoped to.
 */
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
        if (!widget) {
          return { id, present: false };
        }
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
      return { ok: true, results };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`;
}

/**
 * Assert each `expectedWidgets` entry is attached to the RIGHT panel at
 * startup, but neither active nor the current tab — i.e. present as an icon,
 * not opened. Three distinct failure messages on purpose, same reasoning as
 * `assertNarrativeToolsRegistered`: "not present at all" (no
 * `initializeLayout`, or the widget/view-contribution binding is missing —
 * this is exactly the `EntityCardsViewContribution` gap UR-039 found, where
 * the class had no `FrontendApplicationContribution` binding at all), "present
 * but not in the right panel" (wrong `defaultWidgetOptions.area`, or attached
 * without ever reaching `addWidget`), and "present but already open"
 * (violates the `activate: false, reveal: false` requirement — the panel
 * must not steal focus or force itself open on every launch).
 */
async function assertViewIconsPresentOnStartup(readSnapshot, target, expectedWidgets) {
  const snapshot = await readSnapshot();
  if (!snapshot || !snapshot.ok) {
    throw new Error(
      `[${target}] could not read shell/view state: ${snapshot ? snapshot.error : 'nothing returned'}`
    );
  }
  const byId = new Map(snapshot.results.map(result => [result.id, result]));
  for (const { id, label } of expectedWidgets) {
    const result = byId.get(id);
    if (!result || !result.present) {
      throw new Error(
        `[${target}] "${label}" (${id}) is NOT present in the shell at startup — no command was executed ` +
        'to open it, so it should have been attached by initializeLayout(). It has no icon in the side ' +
        'panel on first launch.'
      );
    }
    if (!result.isAttached || result.area !== 'right' || !result.inTabBar) {
      throw new Error(
        `[${target}] "${label}" (${id}) exists but is not attached to the right panel at startup ` +
        `(isAttached=${result.isAttached}, area=${JSON.stringify(result.area)}, inTabBar=${result.inTabBar}).`
      );
    }
    if (result.isShellActive || result.isCurrentInTabBar) {
      throw new Error(
        `[${target}] "${label}" (${id}) is ACTIVE/revealed at startup — it must be present as an icon only ` +
        '(activate: false, reveal: false), not opened.'
      );
    }
  }
  console.log(
    `PASS [${target}] startup side-panel icons present without opening: ${expectedWidgets.map(w => w.label).join(', ')}`
  );
}

async function assertCommandsRegistered(page, commandIds) {
  const missingCommands = await page.evaluate(ids => {
    const registry = window.__afeSmokeGetCommandRegistry();
    return ids.filter(id => !registry.getCommand(id));
  }, commandIds);

  if (missingCommands.length > 0) {
    throw new Error(`Missing Theia command(s): ${missingCommands.join(', ')}`);
  }
}

async function executeCommand(page, commandId) {
  const result = await page.evaluate(async id => {
    const registry = window.__afeSmokeGetCommandRegistry();
    try {
      await Promise.race([
        registry.executeCommand(id),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Command timed out: ${id}`)), 10_000))
      ]);
      return {
        ok: true
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }, commandId);

  if (!result.ok) {
    throw new Error(result.message);
  }
}

async function startCommand(page, commandId) {
  const result = await page.evaluate(id => {
    const registry = window.__afeSmokeGetCommandRegistry();
    registry.executeCommand(id).catch(error => {
      window.__afeSmokeCommandError = error instanceof Error ? error.message : String(error);
    });
    return {
      ok: true
    };
  }, commandId);

  if (!result.ok) {
    throw new Error(`Failed to start command: ${commandId}`);
  }
}
