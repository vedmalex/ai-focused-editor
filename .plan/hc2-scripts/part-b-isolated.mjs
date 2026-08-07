// TASK-022 HC-2 — Part B: mutating checks (point 4, rename+delete) plus the
// fixture-dependent sub-checks that examples/sample-book cannot exercise as
// it currently sits on disk (multi-hop ownership chain, cyrillic-vs-latin
// locale sort, id != filename card). Runs against an ISOLATED, disposable
// copy of the fixture manuscript — examples/sample-book itself is never
// opened or written by this script.
//
// Synthetic fixtures added ONLY inside the temp copy (never in the repo):
//   1. entities/artifacts/gandiva.yaml restored to its ORIGINAL, git-committed
//      three-hop ownership chain (varuna -> agni -> arjuna) — the working
//      tree's copy has been manually shortened by the author to one hop.
//   2. entities/characters/mystery-file.yaml: id `yarost`, name "Ярость"
//      (Cyrillic) — filename deliberately does NOT match id, and its notes
//      field carries a `[[char:arjuna|Arjuna]]` mention, so ONE fixture
//      exercises three otherwise-untestable HC-2 sub-checks at once: locale
//      sort order (Cyrillic before Latin, UR-032), id != filename display,
//      and mention-click resolution (which is what "clicking a mention opens
//      the exact place" empirically means for this widget — see the
//      task's own context.md, evidence source 3).

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import net from 'node:net';
import { chromium } from 'playwright';
import {
  createIsolatedSampleWorkspace,
  removeIsolatedSampleWorkspace
} from '../../scripts/narrative-knowledge-round-trip.mjs';

const repoRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const appDir = join(repoRoot, 'apps/browser');
const sampleBookSource = join(repoRoot, 'examples/sample-book');
const SHOT_DIR = '/Users/vedmalex/.claude/jobs/e93b16ad/tmp/hc2';

function log(section, obj) {
  console.log(`\n=== ${section} ===`);
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
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

/** Bring a right-panel widget to the FRONT (active tab) regardless of the
 *  open command's activate/reveal flags — needed because Narrative Map and
 *  Entity Cards share the same panel as tabs, and only the active tab is
 *  visible/screenshot-able. */
async function activateWidget(page, widgetId) {
  await page.evaluate(async id => {
    const container = window.theia.container;
    const shell = container.get(window.__afeGetBindingByLabel('ApplicationShell'));
    const widgetManager = container.get(window.__afeGetBindingByLabel('WidgetManager'));
    const widget = widgetManager.tryGetWidget(id) || await widgetManager.getOrCreateWidget(id, undefined);
    await shell.activateWidget(widget.id);
  }, widgetId);
  await page.waitForTimeout(300);
}

async function waitForServer(targetUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(targetUrl);
      if (response.ok || response.status < 500) { return; }
      lastError = new Error(`Unexpected HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${targetUrl}`);
}

const GANDIVA_ORIGINAL_THREE_HOP = `# Artifact card for Arjuna's celestial bow.
id: gandiva
name: Gandiva
aliases:
  - The great bow
epithets:
  - Bow of Indra
  - Terror of the Kaurava host
summary: The divine bow wielded by Arjuna, emblem of his martial duty.
backstory: >-
  Forged for the gods and passed through Varuna to Arjuna, Gandiva sounds like
  thunder when drawn and never tires its bearer across the longest battle.
arc: Lowered in despair at the opening of the dialogue, then raised again once
  Arjuna resolves to act.
notes: Appears in chapter-01 and part-01/chapter-03 as a barometer of Arjuna's resolve.
ownership:
  - owner: varuna
    to: The age of the gods
    note: Lord of the waters guards the celestial bow before it reaches mortals.
  - owner: agni
    from: The age of the gods
    to: The burning of Khandava
    note: Handed to the fire god to arm a warrior worthy of the deed.
  - owner: arjuna
    from: The burning of Khandava
    note: Bestowed on Arjuna; becomes the emblem of his martial duty ever after.
`;

const YAROST_FIXTURE = `id: yarost
name: Ярость
aliases: []
epithets:
  - Пламя гнева
summary: >-
  Synthetic HC-2 test fixture (TASK-022), added only to this isolated copy to
  exercise Cyrillic-vs-Latin locale sort (UR-032) and an id that does not
  match its filename.
notes: >-
  Cross-reference mention target for the HC-2 rename check [[char:arjuna|Arjuna]]
`;

const { workspaceDir, sampleRoot } = await createIsolatedSampleWorkspace(sampleBookSource);
console.log(`Isolated workspace: ${sampleRoot}`);

// --- synthetic fixtures, isolated copy ONLY -------------------------------
const gandivaPath = join(sampleRoot, 'entities/artifacts/gandiva.yaml');
writeFileSync(gandivaPath, GANDIVA_ORIGINAL_THREE_HOP, 'utf8');
const yarostPath = join(sampleRoot, 'entities/characters/mystery-file.yaml');
writeFileSync(yarostPath, YAROST_FIXTURE, 'utf8');

const port = await getFreePort();
const url = `http://127.0.0.1:${port}`;
log('PORT', { port, url, excluded: [3000, 3001, 3002] });

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
server.stdout.on('data', c => { serverOutput += c.toString(); });
server.stderr.on('data', c => { serverOutput += c.toString(); });

let browser;
try {
  await waitForServer(url, 120_000);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  await page.addInitScript(() => {
    window.__afeGetBindingByLabel = label => {
      const container = window.theia?.container;
      if (!container) { throw new Error('Theia container is not available.'); }
      for (const [key] of container._bindingDictionary._map.entries()) {
        const candidateLabel = key && (key.description || key.name);
        if (candidateLabel === label) { return key; }
      }
      throw new Error(`No Theia binding found: ${label}`);
    };
    window.__afeGetCommandRegistry = () =>
      window.theia.container.get(window.__afeGetBindingByLabel('CommandRegistry'));
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean(document.querySelector('.theia-ApplicationShell, #theia-app-shell, .p-Widget')),
  undefined, { timeout: 60_000 });
  await page.waitForFunction(() =>
    (document.querySelector('#theia-statusBar')?.textContent ?? '').includes('AI:'),
  undefined, { timeout: 20_000 });
  log('CONNECTED (isolated)', { url });

  // Build the index once via an explicit rebuild — this is BEFORE any of the
  // HC-2 point-4 rename/delete steps, so it is not the thing being tested;
  // it just gets the isolated copy's index populated so the checks below
  // read something real.
  const rebuildResult = await page.evaluate(async () => {
    const container = window.theia.container;
    const wsKey = window.__afeGetBindingByLabel('WorkspaceService');
    const ws = container.get(wsKey);
    await ws.ready;
    const root = (ws.tryGetRoots()[0] || (await ws.roots)[0]);
    const rootUri = root.resource.toString();
    const svcKey = window.__afeGetBindingByLabel('NarrativeKnowledgeService');
    const svc = container.get(svcKey);
    const availability = await svc.getRebuildAvailability(rootUri);
    if (!availability.available) { return { ok: false, error: availability.reason }; }
    const envelope = await svc.rebuild(rootUri);
    return { ok: true, rootUri, state: envelope.state, report: envelope.data };
  });
  log('Initial rebuild (isolated copy)', rebuildResult);
  if (!rebuildResult.ok) { throw new Error(`initial rebuild failed: ${rebuildResult.error}`); }

  // -----------------------------------------------------------------------
  // Narrative Map: 3-hop ownership chain + locale sort context
  // -----------------------------------------------------------------------
  await page.evaluate(async () => {
    await window.__afeGetCommandRegistry().executeCommand('ai-focused-editor.narrative.openMap');
  });
  await page.waitForSelector('.afe-narrative-map-body', { timeout: 20_000 });
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.afe-narrative-map-header button'));
    btns.find(b => /refresh/i.test(b.textContent || ''))?.click();
  });
  await page.waitForTimeout(1500);

  const ownershipFacts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.afe-narrative-ownership-item')).map(item => ({
      chain: item.querySelector('.afe-narrative-ownership-chain')?.textContent ?? '',
      notes: Array.from(item.querySelectorAll('.afe-narrative-ownership-notes li')).map(li => li.textContent ?? '')
    }));
  });
  log('ISOLATED — 3-hop ownership chain', ownershipFacts);
  await activateWidget(page, 'ai-focused-editor.narrative-map');
  await page.locator('.afe-narrative-map').screenshot({ path: `${SHOT_DIR}/06-isolated-ownership-3hop.png` });

  // -----------------------------------------------------------------------
  // Entity Cards: locale sort + id != filename + mention-click (pre-rename)
  // -----------------------------------------------------------------------
  await page.evaluate(async () => {
    await window.__afeGetCommandRegistry().executeCommand('ai-focused-editor.entities.openCards');
  });
  await page.waitForSelector('.afe-entity-cards', { timeout: 20_000 });
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.afe-entity-cards-header button'));
    btns.find(b => /refresh/i.test(b.textContent || ''))?.click();
  });
  await page.waitForTimeout(1500);

  const charOrder = await page.evaluate(() => {
    const section = document.querySelector('.afe-entity-group.character');
    return Array.from(section.querySelectorAll('.afe-entity-card')).map(card => ({
      id: card.querySelector('.afe-entity-id')?.textContent ?? '',
      name: card.querySelector('.afe-entity-card-title strong')?.textContent ?? '',
      path: card.querySelector('.afe-entity-path')?.textContent ?? ''
    }));
  });
  log('ISOLATED — Characters section order (locale sort + id!=filename check)', charOrder);
  await activateWidget(page, 'ai-focused-editor.entity-cards');
  await page.locator('.afe-entity-cards').screenshot({ path: `${SHOT_DIR}/07-isolated-locale-sort-id-mismatch.png` });

  // Click the injected [[char:arjuna|Arjuna]] mention inside the Ярость card's notes.
  await activateWidget(page, 'ai-focused-editor.entity-cards');
  const preRenameClick = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.afe-entity-card'));
    const yarostCard = cards.find(c => c.querySelector('.afe-entity-id')?.textContent === 'yarost');
    if (!yarostCard) { return { ok: false, error: 'yarost card not found' }; }
    const mention = yarostCard.querySelector('.afe-entity-mention');
    if (!mention) { return { ok: false, error: 'no mention span found in yarost card', html: yarostCard.innerHTML.slice(0, 500) }; }
    const title = mention.getAttribute('title');
    mention.click();
    return { ok: true, mentionText: mention.textContent, mentionTitle: title };
  });
  log('ISOLATED — pre-rename mention click on Arjuna reference', preRenameClick);
  await page.waitForTimeout(1500);
  const openedTabsPreRename = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.theia-tab .p-TabBar-tabLabel')).map(el => el.textContent));
  log('ISOLATED — open editor tabs after pre-rename mention click', openedTabsPreRename);
  await page.screenshot({ path: `${SHOT_DIR}/08-mention-click-opens-arjuna.png`, fullPage: true });

  // -----------------------------------------------------------------------
  // HC-2 point 4: rename entities/characters/arjuna.yaml on DISK, live app,
  // no reload, no "Rebuild Index" command.
  // -----------------------------------------------------------------------
  const arjunaPath = join(sampleRoot, 'entities/characters/arjuna.yaml');
  const arjunaRenamedPath = join(sampleRoot, 'entities/characters/arjuna-renamed.yaml');
  renameSync(arjunaPath, arjunaRenamedPath);
  log('RENAMED ON DISK', { from: arjunaPath, to: arjunaRenamedPath });

  // Poll the index status/documents via the same read the ISS-359 watcher
  // check uses, WITHOUT ever calling rebuild(), to give the file watcher a
  // bounded window to notice the rename on its own.
  const watcherPoll = await page.evaluate(async () => {
    const container = window.theia.container;
    const wsKey = window.__afeGetBindingByLabel('WorkspaceService');
    const ws = container.get(wsKey);
    await ws.ready;
    const root = (ws.tryGetRoots()[0] || (await ws.roots)[0]);
    const rootUri = root.resource.toString();
    const svcKey = window.__afeGetBindingByLabel('NarrativeKnowledgeService');
    const svc = container.get(svcKey);
    const before = await svc.getIndexStatus(rootUri);
    const deadline = Date.now() + 30000;
    let last = before;
    while (Date.now() < deadline) {
      const entities = await svc.findEntities(rootUri);
      const arjuna = entities.data.find(e => e.id === 'arjuna');
      const status = await svc.getIndexStatus(rootUri);
      last = status;
      if (arjuna && /arjuna-renamed\.yaml$/.test(arjuna.sourcePath)) {
        return { ok: true, generationBefore: before.generation, generationAfter: status.generation, arjunaSourcePath: arjuna.sourcePath };
      }
      await new Promise(r => setTimeout(r, 500));
    }
    const entities = await svc.findEntities(rootUri);
    const arjuna = entities.data.find(e => e.id === 'arjuna');
    return { ok: false, timedOut: true, generationBefore: before.generation, generationAfterTimeout: last.generation, arjunaSourcePathAtTimeout: arjuna?.sourcePath };
  });
  log('ISOLATED — watcher self-update poll after rename (NO rebuild() called)', watcherPoll);

  // Now refresh the WIDGETS (data refresh only, not a rebuild command) and
  // observe what the UI shows.
  await page.evaluate(async () => {
    await window.__afeGetCommandRegistry().executeCommand('ai-focused-editor.entities.refreshCards');
    await window.__afeGetCommandRegistry().executeCommand('ai-focused-editor.narrative.refreshMap');
  });
  await page.waitForTimeout(1500);

  const postRenameCards = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.afe-entity-card'));
    const arjunaCard = cards.find(c => c.querySelector('.afe-entity-id')?.textContent === 'arjuna');
    return arjunaCard
      ? { present: true, path: arjunaCard.querySelector('.afe-entity-path')?.textContent ?? '' }
      : { present: false };
  });
  log('ISOLATED — Entity Cards after rename+refresh', postRenameCards);
  await activateWidget(page, 'ai-focused-editor.entity-cards');
  await page.locator('.afe-entity-cards').screenshot({ path: `${SHOT_DIR}/09-post-rename-entity-cards.png` });

  const postRenameMap = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('.afe-narrative-graph-node')).map(n => n.querySelector('text')?.textContent ?? '');
    const chips = Array.from(document.querySelectorAll('.afe-narrative-chip')).map(c => c.textContent ?? '');
    return { nodeLabels: nodes, chipLabels: chips };
  });
  log('ISOLATED — Narrative Map after rename+refresh (Arjuna still present?)', postRenameMap);
  await activateWidget(page, 'ai-focused-editor.narrative-map');
  await page.locator('.afe-narrative-map').screenshot({ path: `${SHOT_DIR}/10-post-rename-narrative-map.png` });

  // Problems panel: should show NO broken link for arjuna yet (rename kept the id resolvable).
  await page.evaluate(async () => {
    await window.__afeGetCommandRegistry().executeCommand('problemsView:toggle');
  });
  await page.waitForTimeout(1500);
  const problemsAfterRename = await page.evaluate(() => document.body.innerText);
  const arjunaBrokenMentionAfterRename = /arjuna/i.test(problemsAfterRename) && /broken|unresolved|missing/i.test(problemsAfterRename);
  log('ISOLATED — Problems panel mentions "arjuna" + broken/unresolved/missing after RENAME (should be false)', {
    arjunaBrokenMentionAfterRename
  });
  await page.screenshot({ path: `${SHOT_DIR}/11-problems-after-rename.png`, fullPage: true });

  // Re-click the mention inside the yarost card — should now resolve to the NEW path.
  await activateWidget(page, 'ai-focused-editor.entity-cards');
  const postRenameClick = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.afe-entity-card'));
    const yarostCard = cards.find(c => c.querySelector('.afe-entity-id')?.textContent === 'yarost');
    const mention = yarostCard?.querySelector('.afe-entity-mention');
    if (!mention) { return { ok: false }; }
    mention.click();
    return { ok: true };
  });
  await page.waitForTimeout(1500);
  const openedTabsPostRename = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.theia-tab .p-TabBar-tabLabel')).map(el => el.textContent));
  log('ISOLATED — post-rename mention click result + open tabs', { postRenameClick, openedTabsPostRename });
  await page.screenshot({ path: `${SHOT_DIR}/12-mention-click-opens-renamed.png`, fullPage: true });

  // -----------------------------------------------------------------------
  // Delete the renamed card entirely — mentions should self-break, no reload.
  // -----------------------------------------------------------------------
  rmSync(arjunaRenamedPath);
  log('DELETED ON DISK', { path: arjunaRenamedPath });

  const watcherPollDelete = await page.evaluate(async () => {
    const container = window.theia.container;
    const wsKey = window.__afeGetBindingByLabel('WorkspaceService');
    const ws = container.get(wsKey);
    const root = (ws.tryGetRoots()[0] || (await ws.roots)[0]);
    const rootUri = root.resource.toString();
    const svcKey = window.__afeGetBindingByLabel('NarrativeKnowledgeService');
    const svc = container.get(svcKey);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const entities = await svc.findEntities(rootUri);
      const stillThere = entities.data.some(e => e.id === 'arjuna');
      if (!stillThere) { return { ok: true, arjunaGoneFromIndex: true }; }
      await new Promise(r => setTimeout(r, 500));
    }
    return { ok: false, timedOut: true };
  });
  log('ISOLATED — watcher self-update poll after DELETE (NO rebuild() called)', watcherPollDelete);

  await page.evaluate(async () => {
    await window.__afeGetCommandRegistry().executeCommand('ai-focused-editor.entities.refreshCards');
    await window.__afeGetCommandRegistry().executeCommand('ai-focused-editor.narrative.refreshMap');
  });
  await page.waitForTimeout(1500);

  const postDeleteCards = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.afe-entity-card'));
    const arjunaCard = cards.find(c => c.querySelector('.afe-entity-id')?.textContent === 'arjuna');
    return { arjunaCardStillPresent: !!arjunaCard };
  });
  log('ISOLATED — Entity Cards after delete+refresh (Arjuna card should be GONE)', postDeleteCards);

  await page.waitForTimeout(2000); // give applyDiagnostics() a window to publish markers
  const problemsAfterDeleteText = await page.evaluate(() => document.body.innerText);
  log('ISOLATED — Problems panel body text after DELETE (look for arjuna broken-link markers)', {
    containsArjuna: /arjuna/i.test(problemsAfterDeleteText),
    snippet: problemsAfterDeleteText.slice(0, 4000)
  });
  await page.screenshot({ path: `${SHOT_DIR}/13-problems-after-delete.png`, fullPage: true });

  console.log('\n=== PART B DONE ===');
} catch (error) {
  console.error('PART B FAILED');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  if (browser) { await browser.close(); }
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise(r => setTimeout(r, 5000))]);
  if (process.exitCode === 1 && serverOutput.trim()) {
    console.error('\nTheia server output (tail):\n' + serverOutput.trim().slice(-4000));
  }
  await removeIsolatedSampleWorkspace(workspaceDir);
  console.log(`Removed isolated workspace: ${workspaceDir}`);
}
