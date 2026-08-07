/**
 * `getEntityAppearances` end to end (gh#47 WP-7).
 *
 * WHY THIS RUNS AGAINST A REAL STORE AND REAL FILES. Everything the method
 * composes is already covered one layer down — ordering by the store contract,
 * quoting by the excerpt teeth. What is NOT covered by either is the composition
 * itself: that the document lookup feeds the right hash to the right appearance,
 * that a chapter shared by two appearances is read once and still yields TWO
 * DIFFERENT passages, and that the spread and the list come back under one
 * envelope. That last one is the whole reason the result is a composite, and no
 * unit test of a pure function can see it.
 *
 * The service class itself needs Theia DI, so this exercises the same assembly
 * against `NarrativeIndexSession` + the SQLite store directly — the layer where
 * the composition lives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NarrativeIndexSession } from '../../lib/common/index.js';
import { SqliteNarrativeIndexStore } from '../../lib/node/sqlite-narrative-index-store.js';
import { hashContent } from '../../lib/node/narrative-workspace-scan.js';
import { readVerifiedDocument, sliceExcerpt } from '../../lib/node/evidence-excerpt.js';
import { NARRATIVE_INDEX_SCHEMA_VERSION } from '../../lib/node/narrative-index-schema.js';
import { makeWorkspace } from './harness.mts';

const CH1 = 'content/ch-01.md';
const CH2 = 'content/ch-02.md';
const CARD = 'entities/characters/krishna.yaml';

/** Two mentions in ONE chapter, deliberately: the read cache is keyed by
 *  document, and a cache that returned the finished excerpt would hand the
 *  second one the first one's passage. */
const CH1_TEXT = ['Первое: [[char:krishna|Кришна]].', '', 'Второе: [[char:krishna|Говинда]].'].join('\n');
const CH2_TEXT = 'Позже: [[char:krishna|Кришна]].';

function buildIndex(): { session: NarrativeIndexSession; root: string; store: SqliteNarrativeIndexStore } {
  const workspace = makeWorkspace('appearances');
  mkdirSync(join(workspace.root, 'content'), { recursive: true });
  mkdirSync(join(workspace.root, 'entities/characters'), { recursive: true });
  const files = [
    { path: 'manifest.yaml', text: [`content:`, `  - path: ${CH1}`, '    title: Первая', `  - path: ${CH2}`, '    title: Вторая'].join('\n') },
    { path: CARD, text: ['id: krishna', 'name: Кришна'].join('\n') },
    { path: CH1, text: CH1_TEXT },
    { path: CH2, text: CH2_TEXT }
  ];
  for (const file of files) {
    writeFileSync(join(workspace.root, file.path), file.text, 'utf8');
  }
  const store = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0
  });
  const session = new NarrativeIndexSession({ store, schemaVersion: NARRATIVE_INDEX_SCHEMA_VERSION });
  const report = session.rebuild(
    files.map(file => ({
      path: file.path,
      text: file.text,
      sizeBytes: Buffer.byteLength(file.text, 'utf8'),
      mtimeMs: 1,
      contentHash: hashContent(file.text)
    }))
  );
  assert.equal(report.state.state, 'ready', 'the fixture must produce a ready index');
  return { session, root: workspace.root, store };
}

/** The composition the service performs, with the same one-read-per-document
 *  rule. Kept here rather than imported because the service needs Theia DI. */
async function appearancesWith(session: NarrativeIndexSession, root: string, direction: 'asc' | 'desc') {
  const answer = session.getMentions({ entityId: 'krishna', orderBy: 'chapter', direction });
  const texts = new Map<string, Awaited<ReturnType<typeof readVerifiedDocument>>>();
  const out: { path: string; excerpt?: string; unavailable?: string }[] = [];
  for (const mention of answer.data) {
    const relPath = mention.evidence.path;
    const document = session.getDocument(relPath);
    assert.ok(document, `document row for ${relPath}`);
    const key = `${relPath}::${document.contentHash}`;
    let verified = texts.get(key);
    if (verified === undefined) {
      verified = await readVerifiedDocument(root, relPath, document.contentHash);
      texts.set(key, verified);
    }
    if (verified.text === undefined) {
      out.push({ path: relPath, unavailable: verified.unavailable });
      continue;
    }
    const excerpt = sliceExcerpt(verified.text, mention.evidence);
    out.push({ path: relPath, ...(excerpt.text === undefined ? { unavailable: excerpt.unavailable } : { excerpt: excerpt.text }) });
  }
  return { out, reads: texts.size, state: answer.state };
}

test('two appearances in ONE chapter are read once and still quote DIFFERENT passages', async () => {
  const { session, root } = buildIndex();
  const { out, reads } = await appearancesWith(session, root, 'asc');

  assert.equal(reads, 2, 'one read per DOCUMENT, not per appearance');
  // The failure this refuses: a cache keyed by document that stored the finished
  // excerpt would make these two identical, and both would look plausible.
  const first = out.filter(entry => entry.path === CH1);
  assert.equal(first.length, 2);
  assert.notEqual(first[0].excerpt, first[1].excerpt, 'the two mentions in one chapter are different passages');
  assert.equal(first[0].excerpt, '[[char:krishna|Кришна]]');
  assert.equal(first[1].excerpt, '[[char:krishna|Говинда]]');
});

test('ascending really is manuscript order, and descending is its mirror', async () => {
  const { session, root } = buildIndex();
  const ascending = await appearancesWith(session, root, 'asc');
  const descending = await appearancesWith(session, root, 'desc');
  assert.deepEqual(ascending.out.map(entry => entry.path), [CH1, CH1, CH2]);
  assert.deepEqual(descending.out.map(entry => entry.path), [CH2, CH1, CH1]);
});

test('the spread counts documents and agrees with the mention rows', async () => {
  const { session } = buildIndex();
  const spread = session.countMentionsByDocument({ entityId: 'krishna' });
  assert.deepEqual(
    spread.map(row => `${row.relPath}:${row.mentionCount}`),
    [`${CH1}:2`, `${CH2}:1`]
  );
  assert.equal(
    spread.reduce((sum, row) => sum + row.mentionCount, 0),
    session.getMentions({ entityId: 'krishna' }).data.length
  );
});

test('a chapter edited after indexing yields no quotation, and says why', async () => {
  const { session, root } = buildIndex();
  // Lines inserted ABOVE, so the stored coordinates still resolve — onto text
  // that is real and is not the mention.
  writeFileSync(join(root, CH1), `Новый заголовок\n\n${CH1_TEXT}`, 'utf8');
  const { out } = await appearancesWith(session, root, 'asc');
  for (const entry of out.filter(item => item.path === CH1)) {
    assert.equal(entry.excerpt, undefined, 'a shifted chapter must not be quoted');
    assert.equal(entry.unavailable, 'document-changed');
  }
  // PAIRED POSITIVE in the same run: the untouched chapter still quotes, so the
  // assertion above is refusing a stale read rather than reporting a broken one.
  const untouched = out.find(item => item.path === CH2);
  assert.equal(untouched?.excerpt, '[[char:krishna|Кришна]]');
});
