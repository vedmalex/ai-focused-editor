// TASK-022 HC-2 — Part A: read-only checks against the LIVE browser editor
// already running on http://127.0.0.1:3002 (pid 96102), opened on
// examples/sample-book. This script NEVER writes to the workspace and never
// starts/stops the server — it only connects a second Playwright client and
// reads the DOM / calls read-only services.

import { chromium } from 'playwright';

const url = 'http://127.0.0.1:3002';
const SHOT_DIR = '/Users/vedmalex/.claude/jobs/e93b16ad/tmp/hc2';

function log(section, obj) {
  console.log(`\n=== ${section} ===`);
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

const browser = await chromium.launch({ headless: true });
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

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean(document.querySelector('.theia-ApplicationShell, #theia-app-shell, .p-Widget')),
  undefined, { timeout: 60_000 });
  await page.waitForFunction(() =>
    (document.querySelector('#theia-statusBar')?.textContent ?? '').includes('AI:'),
  undefined, { timeout: 20_000 });

  log('CONNECTED', { url, title: await page.title() });

  // ---------------------------------------------------------------------
  // 1. Narrative Map
  // ---------------------------------------------------------------------
  await page.evaluate(async () => {
    const registry = window.__afeGetCommandRegistry();
    await registry.executeCommand('ai-focused-editor.narrative.openMap');
  });
  await page.waitForSelector('.afe-narrative-map-body', { timeout: 20_000 });
  // Force a data refresh (NOT a rebuild) so we see current index content.
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.afe-narrative-map-header button'));
    const refresh = btns.find(b => /refresh/i.test(b.textContent || ''));
    refresh?.click();
  });
  await page.waitForTimeout(1500);
  await page.waitForSelector('.afe-narrative-graph, .afe-empty-state', { timeout: 20_000 });

  const mapFacts = await page.evaluate(() => {
    const timelineRows = Array.from(document.querySelectorAll('.afe-narrative-timeline-row')).map(row => ({
      order: row.querySelector('.afe-narrative-timeline-order')?.textContent ?? '',
      title: row.querySelector('.afe-narrative-timeline-title')?.textContent ?? '',
      excluded: !!row.querySelector('.afe-narrative-timeline-flag'),
      chips: Array.from(row.querySelectorAll('.afe-narrative-chip')).map(c => c.textContent ?? '')
    }));
    const ownershipItems = Array.from(document.querySelectorAll('.afe-narrative-ownership-item')).map(item => ({
      chain: item.querySelector('.afe-narrative-ownership-chain')?.textContent ?? '',
      notes: Array.from(item.querySelectorAll('.afe-narrative-ownership-notes li')).map(li => li.textContent ?? '')
    }));
    const nodes = Array.from(document.querySelectorAll('.afe-narrative-graph-node')).map(n => ({
      kind: n.getAttribute('class'),
      label: n.querySelector('text')?.textContent ?? '',
      title: n.querySelector('circle title')?.textContent ?? ''
    }));
    const edges = Array.from(document.querySelectorAll('.afe-narrative-graph-edge')).map(e => ({
      title: e.querySelector('title')?.textContent ?? ''
    }));
    return { timelineRows, ownershipItems, nodeCount: nodes.length, edgeCount: edges.length, nodes, edges };
  });
  log('NARRATIVE MAP facts', mapFacts);

  await page.locator('.afe-narrative-map').screenshot({ path: `${SHOT_DIR}/01-narrative-map.png` });
  const ownershipEl = page.locator('.afe-narrative-ownership').first();
  if (await ownershipEl.count() > 0) {
    await ownershipEl.scrollIntoViewIfNeeded();
    await ownershipEl.screenshot({ path: `${SHOT_DIR}/01b-ownership-timeline.png` });
  } else {
    log('NARRATIVE MAP WARNING', 'no .afe-narrative-ownership element found on live instance');
  }

  // ---------------------------------------------------------------------
  // 2. Entity Cards
  // ---------------------------------------------------------------------
  await page.evaluate(async () => {
    const registry = window.__afeGetCommandRegistry();
    await registry.executeCommand('ai-focused-editor.entities.openCards');
  });
  await page.waitForSelector('.afe-entity-cards', { timeout: 20_000 });
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.afe-entity-cards-header button'));
    const refresh = btns.find(b => /refresh/i.test(b.textContent || ''));
    refresh?.click();
  });
  await page.waitForTimeout(1500);

  const cardFacts = await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('.afe-entity-group')).map(section => {
      const kindClass = Array.from(section.classList).find(c => c !== 'afe-entity-group');
      const heading = section.querySelector('h4')?.textContent ?? '';
      const cards = Array.from(section.querySelectorAll('.afe-entity-card')).map(card => ({
        id: card.querySelector('.afe-entity-id')?.textContent ?? '',
        name: card.querySelector('.afe-entity-card-title strong')?.textContent ?? '',
        path: card.querySelector('.afe-entity-path')?.textContent ?? ''
      }));
      return { kind: kindClass, heading, cardOrder: cards };
    });
    return { groups };
  });
  log('ENTITY CARDS facts', cardFacts);
  await page.locator('.afe-entity-cards').screenshot({ path: `${SHOT_DIR}/02-entity-cards.png` });

  // ---------------------------------------------------------------------
  // 3. manuscript_find_entities — substring-in-epithet match
  // ---------------------------------------------------------------------
  const toolResult = await page.evaluate(async () => {
    const container = window.theia.container;
    const key = window.__afeGetBindingByLabel('ToolInvocationRegistry');
    const registry = container.get(key);
    const tool = registry.getFunction('manuscript_find_entities');
    if (!tool) { return { ok: false, error: 'manuscript_find_entities not registered' }; }
    const raw = await tool.handler(JSON.stringify({ query: 'Kaurava' }));
    return { ok: true, raw: JSON.parse(raw) };
  });
  log('manuscript_find_entities("Kaurava") result', toolResult);

  const toolResult2 = await page.evaluate(async () => {
    const container = window.theia.container;
    const key = window.__afeGetBindingByLabel('ToolInvocationRegistry');
    const registry = container.get(key);
    const tool = registry.getFunction('manuscript_find_entities');
    const raw = await tool.handler(JSON.stringify({ query: 'Madhu' }));
    return JSON.parse(raw);
  });
  log('manuscript_find_entities("Madhu") result (cross-check, mid-epithet)', toolResult2);

  // Negative control: a query that is NOT a name prefix and not present at all.
  const toolResultNone = await page.evaluate(async () => {
    const container = window.theia.container;
    const key = window.__afeGetBindingByLabel('ToolInvocationRegistry');
    const registry = container.get(key);
    const tool = registry.getFunction('manuscript_find_entities');
    const raw = await tool.handler(JSON.stringify({ query: 'zzz-nonexistent-zzz' }));
    return JSON.parse(raw);
  });
  log('manuscript_find_entities("zzz-nonexistent-zzz") negative control', toolResultNone);

  await page.screenshot({ path: `${SHOT_DIR}/03-find-entities-context.png`, fullPage: false });

  // ---------------------------------------------------------------------
  // 4. Book Doctor
  // ---------------------------------------------------------------------
  await page.evaluate(async () => {
    const registry = window.__afeGetCommandRegistry();
    registry.executeCommand('ai-focused-editor.book.doctor').catch(err => {
      window.__afeDoctorError = String(err && err.message || err);
    });
  });
  // Give it time to gather + either open a quick pick or open the report directly.
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOT_DIR}/04-book-doctor-raw.png`, fullPage: true });

  const quickPickVisible = await page.locator('.quick-input-widget').isVisible().catch(() => false);
  log('Book Doctor: quick-input visible?', quickPickVisible);

  if (quickPickVisible) {
    const items = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.quick-input-widget .monaco-list-row')).map(row => row.textContent ?? '');
    });
    log('Book Doctor quick-pick items', items);
    // Look for the "open full report" sentinel row and select it; otherwise Escape.
    const reportRow = page.locator('.quick-input-widget .monaco-list-row', { hasText: /report/i }).first();
    if (await reportRow.count() > 0) {
      await reportRow.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(1500);
  }

  // The report opens as an untitled Markdown editor (Monaco). Grab its text.
  const doctorReportText = await page.evaluate(() => {
    // Theia/Monaco: find any editor whose model text starts with a doctor-report-looking heading.
    const anyMonaco = window.monaco;
    if (!anyMonaco || !anyMonaco.editor) { return { ok: false, error: 'monaco global not found' }; }
    const models = anyMonaco.editor.getModels();
    const candidate = models.find(m => /Fixable|Findings|Book Doctor|doctor/i.test(m.getValue()));
    if (!candidate) {
      return { ok: false, error: 'no doctor-report-looking model found', modelCount: models.length, uris: models.map(m => m.uri.toString()) };
    }
    return { ok: true, uri: candidate.uri.toString(), text: candidate.getValue() };
  });
  log('Book Doctor report text', doctorReportText);

  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOT_DIR}/05-book-doctor-report.png`, fullPage: true });

  console.log('\n=== PART A DONE ===');
} catch (error) {
  console.error('PART A FAILED');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  await page.screenshot({ path: `${SHOT_DIR}/ERROR-part-a.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
