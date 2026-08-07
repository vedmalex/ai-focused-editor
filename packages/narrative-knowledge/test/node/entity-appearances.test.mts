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
import { NodeNarrativeKnowledgeService } from '../../lib/node/node-narrative-knowledge-service.js';
import { SqliteNarrativeIndexStore } from '../../lib/node/sqlite-narrative-index-store.js';
import { hashContent } from '../../lib/node/narrative-workspace-scan.js';
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

/**
 * The REAL service, with its one dependency replaced.
 *
 * THE EARLIER EDITION OF THIS FILE DID NOT DO THIS, and that was the ninth
 * "green by coincidence" of this task: it reimplemented the composition here and
 * asserted against its own copy, so mutating `getEntityAppearances` — the cache
 * key, the `withExcerpt` branch, the exclusion remap, the way `spread` and
 * `first` are folded into the envelope — reddened nothing at all. The class is
 * property-injected, so overriding the ONE seam it needs is enough to exercise
 * the shipped method.
 */
class TestKnowledgeService extends NodeNarrativeKnowledgeService {
  // A plain field, not a parameter property: node's strip-only TypeScript mode
  // (which is how this lane runs) does not implement the latter.
  readonly bound: NarrativeIndexSession;

  constructor(bound: NarrativeIndexSession) {
    super();
    this.bound = bound;
  }

  protected override session(): NarrativeIndexSession {
    return this.bound;
  }
}

test('two appearances in ONE chapter quote DIFFERENT passages', async () => {
  const { session, root } = buildIndex();
  const service = new TestKnowledgeService(session);
  const answer = await service.getEntityAppearances(root, 'krishna', { direction: 'asc', withExcerpt: true });

  // The failure this refuses: caching the finished excerpt per document would
  // make these two identical, and both would look plausible on screen.
  const inFirst = answer.data.appearances.filter(entry => entry.mention.evidence.path === CH1);
  assert.equal(inFirst.length, 2);
  assert.equal(inFirst[0].excerpt, '[[char:krishna|Кришна]]');
  assert.equal(inFirst[1].excerpt, '[[char:krishna|Говинда]]');
});

test('ascending really is manuscript order, and descending is its mirror', async () => {
  const { session, root } = buildIndex();
  const service = new TestKnowledgeService(session);
  const ascending = await service.getEntityAppearances(root, 'krishna', { direction: 'asc' });
  const descending = await service.getEntityAppearances(root, 'krishna', { direction: 'desc' });
  assert.deepEqual(ascending.data.appearances.map(entry => entry.mention.evidence.path), [CH1, CH1, CH2]);
  assert.deepEqual(descending.data.appearances.map(entry => entry.mention.evidence.path), [CH2, CH1, CH1]);
});

test('first, the recent list and the spread arrive in ONE envelope', async () => {
  const { session, root } = buildIndex();
  const service = new TestKnowledgeService(session);
  const answer = await service.getEntityAppearances(root, 'krishna', {
    direction: 'desc',
    limit: 2,
    withExcerpt: true,
    withSpread: true,
    withFirst: true
  });
  // The whole reason the result is a composite: a card showing "first seen"
  // beside "mentioned in N chapters" must not build them from two generations.
  assert.equal(answer.data.first?.mention.evidence.path, CH1);
  assert.equal(answer.data.appearances.length, 2, 'the recent list is capped');
  assert.deepEqual(
    answer.data.spread?.map(row => `${row.relPath}:${row.mentionCount}`),
    [`${CH1}:2`, `${CH2}:1`],
    'and the spread is NOT capped by the same limit'
  );
  // `first` is quoted like any other appearance — one projection, not two.
  assert.equal(answer.data.first?.excerpt, '[[char:krishna|Кришна]]');
});

test('the parts are opt-in: without the flags there is no first and no spread', async () => {
  const { session, root } = buildIndex();
  const service = new TestKnowledgeService(session);
  const answer = await service.getEntityAppearances(root, 'krishna', { direction: 'desc' });
  assert.equal(answer.data.first, undefined);
  assert.equal(answer.data.spread, undefined);
  assert.equal(answer.data.appearances[0].excerpt, undefined, 'and no file was read for a quotation');
});

test('a chapter edited after indexing yields no quotation, and says why', async () => {
  const { session, root } = buildIndex();
  writeFileSync(join(root, CH1), `Новый заголовок\n\n${CH1_TEXT}`, 'utf8');
  const service = new TestKnowledgeService(session);
  const answer = await service.getEntityAppearances(root, 'krishna', { direction: 'asc', withExcerpt: true });
  for (const entry of answer.data.appearances.filter(item => item.mention.evidence.path === CH1)) {
    assert.equal(entry.excerpt, undefined, 'a shifted chapter must not be quoted');
    assert.equal(entry.excerptUnavailable, 'document-changed');
  }
  // PAIRED POSITIVE in the same run: the untouched chapter still quotes, so the
  // assertion above refuses a stale read rather than reporting a broken one.
  const untouched = answer.data.appearances.find(item => item.mention.evidence.path === CH2);
  assert.equal(untouched?.excerpt, '[[char:krishna|Кришна]]');
});
