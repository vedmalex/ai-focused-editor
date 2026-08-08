/**
 * The PERFORMANCE BUDGETS of WP-9a (TASK-022, plan `### WP-9a`).
 *
 * | Quantity                    | Target   | Status                 | Catches                       |
 * |-----------------------------|----------|------------------------|-------------------------------|
 * | Cold full rebuild           | <= 10 s  | assertion, ceiling 40 s| a quadratic walk              |
 * | One chapter re-indexed      | <= 400 ms| assertion, ceiling 1.6 s| a hidden full rebuild        |
 * | A 50-file batch             | <= 2 transactions | EXACT       | no coalescing                 |
 * | Resident memory             | ~50 MB   | observation, ceiling 200 MB | storing text, not ranges |
 *
 * WHY EVERY BUDGET HERE HAS A COUNTING TWIN, AND WHY THE TWIN IS THE REAL ONE.
 * A millisecond is not deterministic and this machine proves it: five identical
 * cold rebuilds of a 50-chapter manuscript measured 6, 345, 6, 7 and 6 ms — a 57x
 * spread on IDENTICAL work. Any assertion whose margin is smaller than that
 * spread is a coin toss wearing a number, and this repository already carries one
 * timing test sitting ~10% under its timeout that passes on a quiet machine and
 * trips under load. So each budget below is asserted TWICE: once against the
 * plan's wall-clock ceiling, which is deliberately generous enough that noise
 * cannot reach it, and once against an EXACT OPERATION COUNT, which is what
 * actually fails when the implementation regresses.
 *
 * THE HONEST LIMIT OF THE WALL-CLOCK BUDGETS, STATED RATHER THAN GLOSSED. At 200
 * chapters the cold rebuild measures ~0.2-0.6 s against a 40 s ceiling. Fitting
 * the measured points (50 chapters -> ~0.26 s, 200 -> ~0.57 s) gives a fixed cost
 * near 0.16 s and about 2 ms per chapter; a genuinely QUADRATIC rebuild would
 * therefore land near 1.8 s at this size — comfortably INSIDE both the 10 s
 * target and the 40 s ceiling. **The clock does not detect quadratic behaviour at
 * this fixture size.** What does is {@link countingStore}: `putDocument` must be
 * called exactly once per document and `listDocuments` exactly once per rebuild,
 * whatever N is. Those counts are exact, noise-free, and go from 1 to 209 the
 * moment somebody moves a whole-table read inside the per-file loop. The clock is
 * kept because the plan asks for it and because it still catches a catastrophic
 * regression; the counts are what make this a budget rather than a hope.
 *
 * WHY 200 CHAPTERS. It is the plan's number, and it is meaningful because it is
 * the size at which the per-chapter cost (~2 ms) dominates the fixed cost
 * (~160 ms) rather than drowning in it: at 50 chapters the fixed cost is 60% of
 * the total, at 200 it is 28%. A budget asserted over a five-document fixture
 * would be measuring process startup and SQLite's first page write, not scaling.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryWorkspaceSource,
  ManualTimerScheduler,
  NarrativeIndexMaintainer,
  NarrativeIndexSession,
  TestNarrativeFileWatcher,
  type DocumentMoveFreshness,
  type DuplicateEntityRecord,
  type DuplicateEventRecord,
  type EntityQuery,
  type EventQuery,
  type IndexableFile,
  type IndexedDocument,
  type IndexedDocumentInput,
  type IndexedEvent,
  type MentionDocumentCount,
  type MentionQuery,
  type NarrativeEntity,
  type NarrativeEvent,
  type NarrativeIndexStore,
  type NarrativeIndexWriter,
  type NarrativeMention,
  type NarrativeRelation,
  type NeighbourhoodQuery,
  type RelationQuery
} from '../../lib/common/index.js';
import { SqliteNarrativeIndexStore } from '../../lib/node/sqlite-narrative-index-store.js';
import { disposeAll, makeWorkspace } from './harness.mts';
import { CH, file, largeManuscript } from './manuscript-fixture.mts';

/** The plan's fixture size. */
const CHAPTERS = 200;
/** The smaller size the scaling comparison needs. */
const SMALL_CHAPTERS = 50;

const COLD_REBUILD_TARGET_MS = 10_000;
const COLD_REBUILD_CEILING_MS = 40_000;
const INCREMENT_TARGET_MS = 400;
const INCREMENT_CEILING_MS = 1_600;
const BATCH_FILES = 50;
const BATCH_TRANSACTION_CEILING = 2;
const MEMORY_TARGET_MB = 50;
const MEMORY_CEILING_MB = 200;

const NOW = 1_700_000_500_000;
const INDEXED_AT = 1_700_000_400_000;

const opened: { close(): void }[] = [];

/** Every measurement this file takes, printed once at the end. */
const observations: string[] = [];
function observe(line: string): void {
  observations.push(line);
}

// ---------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------

/** Exact call counts, by port method. Writer methods are prefixed `write.`. */
type OperationCounts = Record<string, number>;

/**
 * A store that DELEGATES and COUNTS.
 *
 * Written out by hand rather than as a `Proxy` so that it typechecks under
 * `strict` and so that adding a method to the port is a visible edit here — the
 * same reason the port names its traversal queries instead of accepting SQL.
 */
function countingStore(inner: NarrativeIndexStore): { store: NarrativeIndexStore; counts: OperationCounts } {
  const counts: OperationCounts = Object.create(null) as OperationCounts;
  const bump = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const wrapWriter = (writer: NarrativeIndexWriter): NarrativeIndexWriter => ({
    putDocument: (document: IndexedDocumentInput): number => (bump('write.putDocument'), writer.putDocument(document)),
    deleteDocument: (relPath: string): void => (bump('write.deleteDocument'), writer.deleteDocument(relPath)),
    moveDocument: (from: string, to: string, freshness: DocumentMoveFreshness): void =>
      (bump('write.moveDocument'), writer.moveDocument(from, to, freshness)),
    clearDocumentContent: (relPath: string): void =>
      (bump('write.clearDocumentContent'), writer.clearDocumentContent(relPath)),
    clearDerivedRelations: (): void => (bump('write.clearDerivedRelations'), writer.clearDerivedRelations()),
    putEntity: (entity: NarrativeEntity): void => (bump('write.putEntity'), writer.putEntity(entity)),
    putDuplicateEntity: (entityId: string, excludedRelPath: string): void =>
      (bump('write.putDuplicateEntity'), writer.putDuplicateEntity(entityId, excludedRelPath)),
    putMention: (mention: NarrativeMention): void => (bump('write.putMention'), writer.putMention(mention)),
    putRelation: (relation: NarrativeRelation): number => (bump('write.putRelation'), writer.putRelation(relation)),
    putEvent: (event: NarrativeEvent, relPath: string): void =>
      (bump('write.putEvent'), writer.putEvent(event, relPath)),
    putDuplicateEvent: (eventId: string, excludedRelPath: string): void =>
      (bump('write.putDuplicateEvent'), writer.putDuplicateEvent(eventId, excludedRelPath)),
    clearAll: (): void => (bump('write.clearAll'), writer.clearAll())
  });
  const store: NarrativeIndexStore = {
    lifecycle: () => (bump('lifecycle'), inner.lifecycle()),
    // The trailing comma is required: in an `.mts` file a bare `<T>` on an arrow
    // function is reserved syntax (TS7060), because it cannot be told apart
    // from a JSX tag without one.
    transaction: <T,>(body: (writer: NarrativeIndexWriter) => T): T =>
      (bump('transaction'), inner.transaction(writer => body(wrapWriter(writer)))),
    resetForRebuild: () => (bump('resetForRebuild'), inner.resetForRebuild()),
    close: () => inner.close(),
    getDocument: (relPath: string): IndexedDocument | undefined => (bump('getDocument'), inner.getDocument(relPath)),
    listDocuments: (): IndexedDocument[] => (bump('listDocuments'), inner.listDocuments()),
    getEntity: (entityId: string): NarrativeEntity | undefined => (bump('getEntity'), inner.getEntity(entityId)),
    findEntities: (query?: EntityQuery): NarrativeEntity[] => (bump('findEntities'), inner.findEntities(query)),
    getMentions: (query?: MentionQuery): NarrativeMention[] => (bump('getMentions'), inner.getMentions(query)),
    countMentionsByDocument: (query?: MentionQuery): MentionDocumentCount[] =>
      (bump('countMentionsByDocument'), inner.countMentionsByDocument(query)),
    listEvents: (query: EventQuery): IndexedEvent[] => (bump('listEvents'), inner.listEvents(query)),
    getDuplicateEvents: (): DuplicateEventRecord[] => (bump('getDuplicateEvents'), inner.getDuplicateEvents()),
    getEvent: (eventId: string): IndexedEvent | undefined => (bump('getEvent'), inner.getEvent(eventId)),
    getRelations: (query?: RelationQuery): NarrativeRelation[] => (bump('getRelations'), inner.getRelations(query)),
    neighbourhood: (query: NeighbourhoodQuery): NarrativeRelation[] =>
      (bump('neighbourhood'), inner.neighbourhood(query)),
    getDuplicateEntities: (): DuplicateEntityRecord[] => (bump('getDuplicateEntities'), inner.getDuplicateEntities())
  };
  return { store, counts };
}

interface Stack {
  raw: NarrativeIndexStore;
  store: NarrativeIndexStore;
  session: NarrativeIndexSession;
  source: InMemoryWorkspaceSource;
  maintainer: NarrativeIndexMaintainer;
  counts: OperationCounts;
}

function stack(name: string, files: readonly IndexableFile[]): Stack {
  const workspace = makeWorkspace(name);
  const raw = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0
  });
  opened.push(raw);
  const { store, counts } = countingStore(raw);
  const session = new NarrativeIndexSession({ store, schemaVersion: 1, now: () => NOW });
  const source = new InMemoryWorkspaceSource(files);
  const maintainer = new NarrativeIndexMaintainer({
    session,
    source,
    config: () => ({
      debounceMs: 400,
      fallbackTtlMs: 60_000,
      maxOpenWorkspaces: 8,
      databasePath: '.theia/narrative-index.db',
      diagnosticsEnabled: true
    }),
    scheduler: new ManualTimerScheduler(),
    watcher: new TestNarrativeFileWatcher(),
    now: () => NOW
  });
  maintainer.start();
  return { raw, store, session, source, maintainer, counts };
}

// ===========================================================================
// Budget 1 — the cold full rebuild
// ===========================================================================

test(`budget 1 — a cold full rebuild of ${CHAPTERS} chapters stays inside its ceiling`, () => {
  const files = largeManuscript(CHAPTERS);
  const built = stack('budget-cold', files);

  const startedAt = performance.now();
  const report = built.session.rebuild(files, { indexedAt: INDEXED_AT }).data;
  const elapsedMs = performance.now() - startedAt;

  assert.equal(report.documentsIndexed, files.length, 'the whole manuscript really was indexed');
  observe(
    `budget 1  cold rebuild of ${CHAPTERS} chapters: ${elapsedMs.toFixed(0)} ms ` +
      `(target ${COLD_REBUILD_TARGET_MS} ms, ceiling ${COLD_REBUILD_CEILING_MS} ms, ` +
      `margin x${(COLD_REBUILD_CEILING_MS / Math.max(elapsedMs, 1)).toFixed(0)})`
  );
  assert.ok(
    elapsedMs < COLD_REBUILD_CEILING_MS,
    `the cold rebuild took ${elapsedMs.toFixed(0)} ms, over the ${COLD_REBUILD_CEILING_MS} ms ceiling`
  );
});

test('budget 1 (deterministic) — a cold rebuild is LINEAR in the document count', () => {
  const measure = (name: string, chapters: number): { documents: number; counts: OperationCounts } => {
    const files = largeManuscript(chapters);
    const built = stack(name, files);
    const report = built.session.rebuild(files, { indexedAt: INDEXED_AT }).data;
    return { documents: report.documentsIndexed, counts: built.counts };
  };

  const small = measure('budget-linear-small', SMALL_CHAPTERS);
  const large = measure('budget-linear-large', CHAPTERS);

  for (const [label, measured] of [
    [`${SMALL_CHAPTERS} chapters`, small],
    [`${CHAPTERS} chapters`, large]
  ] as const) {
    // EXACTLY ONCE PER DOCUMENT. Not "at most a few times": a rebuild that
    // touched each document once per document is the quadratic shape the plan
    // names, and it shows up here as 209 * 209 rather than as a slow clock.
    assert.equal(
      measured.counts['write.putDocument'],
      measured.documents,
      `${label}: every document must be written exactly ONCE per rebuild`
    );
    // ONCE PER REBUILD, NOT ONCE PER FILE. This is the single line most likely
    // to turn a linear rebuild quadratic — a whole-table read moved inside the
    // per-file loop scans N rows N times while the wall clock barely notices.
    assert.equal(measured.counts['listDocuments'], 1, `${label}: the document table is read ONCE`);
    assert.equal(measured.counts['transaction'], 1, `${label}: and it is all ONE transaction`);
    assert.equal(measured.counts['getDocument'], undefined, `${label}: with no per-file point read at all`);
  }

  // The scaling statement itself, in counts rather than milliseconds: four times
  // the manuscript costs four times the writes, not sixteen.
  const ratio = large.counts['write.putDocument']! / small.counts['write.putDocument']!;
  const sizeRatio = large.documents / small.documents;
  observe(
    `budget 1  putDocument calls: ${small.counts['write.putDocument']} at ${small.documents} docs -> ` +
      `${large.counts['write.putDocument']} at ${large.documents} docs (ratio ${ratio.toFixed(2)}, ` +
      `documents ratio ${sizeRatio.toFixed(2)}, quadratic would be ${(sizeRatio * sizeRatio).toFixed(0)})`
  );
  assert.ok(
    Math.abs(ratio - sizeRatio) < 0.001,
    `writes must scale with the manuscript, not with its square (saw ${ratio}, expected ${sizeRatio})`
  );
});

// ===========================================================================
// Budget 2 — one chapter re-indexed
// ===========================================================================

test('budget 2 — re-indexing ONE chapter stays inside its ceiling', async () => {
  const files = largeManuscript(CHAPTERS);
  const built = stack('budget-increment', files);
  await built.maintainer.rebuildNow();

  built.source.put(file(CH(7), 'Изменено: [[char:hero-0|Первый]] и [[char:hero-3|Третий]].'));
  const startedAt = performance.now();
  const answer = await built.maintainer.updateDocument(CH(7));
  const elapsedMs = performance.now() - startedAt;

  assert.equal(answer.data.mode, 'incremental', 'and it was a real increment, not a quiet rebuild');
  observe(
    `budget 2  one chapter of ${CHAPTERS}: ${elapsedMs.toFixed(0)} ms ` +
      `(target ${INCREMENT_TARGET_MS} ms, ceiling ${INCREMENT_CEILING_MS} ms, ` +
      `margin x${(INCREMENT_CEILING_MS / Math.max(elapsedMs, 1)).toFixed(1)})`
  );
  assert.ok(
    elapsedMs < INCREMENT_CEILING_MS,
    `the increment took ${elapsedMs.toFixed(0)} ms, over the ${INCREMENT_CEILING_MS} ms ceiling`
  );
});

test('budget 2 (deterministic) — the increment writes ONE document, not the whole manuscript', async () => {
  const files = largeManuscript(CHAPTERS);
  const built = stack('budget-increment-counts', files);
  await built.maintainer.rebuildNow();
  for (const key of Object.keys(built.counts)) {
    delete built.counts[key];
  }

  built.source.put(file(CH(7), 'Изменено: [[char:hero-0|Первый]] и [[char:hero-3|Третий]].'));
  const answer = await built.maintainer.updateDocument(CH(7));

  assert.equal(answer.data.mode, 'incremental');
  assert.equal(
    built.counts['write.putDocument'],
    1,
    'THE budget-2 tooth, and it is a count rather than a clock: a pass that secretly rebuilt would show ' +
      `${files.length} here, and on a fast machine it would still come in under 400 ms`
  );
  assert.equal(built.counts['transaction'], 1, 'one transaction');
  assert.equal(built.counts['write.clearAll'], undefined, 'and no wholesale clear — that is a rebuild');
  assert.equal(built.counts['write.putMention'], 2, 'only the edited chapter contributed mentions');
  observe(`budget 2  increment operation counts: ${JSON.stringify(built.counts)}`);
});

// ===========================================================================
// Budget 3 — coalescing (an EXACT count, the plan's own word)
// ===========================================================================

test(`budget 3 — ${BATCH_FILES} files changed together cost at most ${BATCH_TRANSACTION_CEILING} transactions`, async () => {
  const files = largeManuscript(CHAPTERS);
  const built = stack('budget-batch', files);
  await built.maintainer.rebuildNow();

  const generationBefore = built.raw.lifecycle().generation;
  const changes: { path: string; type: 'updated' }[] = [];
  for (let index = 20; index < 20 + BATCH_FILES; index++) {
    const path = CH(index);
    built.source.put(file(path, `Пакет: [[char:hero-1|Один]] и [[char:hero-5|Пять]]. ${index}`));
    changes.push({ path, type: 'updated' });
  }

  const answer = await built.maintainer.applyChanges(changes);
  const transactions = built.raw.lifecycle().generation - generationBefore;

  assert.equal(answer.data.mode, 'incremental', 'the batch must not escalate, or this counts a rebuild');
  assert.equal(answer.data.documentsReindexed.length, BATCH_FILES, 'all fifty really were applied');
  observe(
    `budget 3  ${BATCH_FILES} files -> ${transactions} committed transaction(s) ` +
      `(ceiling ${BATCH_TRANSACTION_CEILING}, EXACT count via the generation counter)`
  );
  assert.ok(
    transactions <= BATCH_TRANSACTION_CEILING,
    `an implementation with no coalescing commits ${BATCH_FILES} times here; saw ${transactions}`
  );
  // `generation` advances once per COMMITTED write transaction, so this is a
  // direct read of the thing being budgeted rather than a proxy for it.
  assert.equal(transactions, 1, 'and in fact it is exactly one');
});

// ===========================================================================
// Budget 4 — resident memory (an OBSERVATION, per the plan's own status column)
// ===========================================================================

test(`budget 4 — resident memory over a ${CHAPTERS}-chapter index, recorded with the actual number`, async () => {
  const files = largeManuscript(CHAPTERS);
  const built = stack('budget-memory', files);

  globalThis.gc?.();
  const before = process.memoryUsage();
  await built.maintainer.rebuildNow();
  globalThis.gc?.();
  const after = process.memoryUsage();

  const heapMb = after.heapUsed / 1024 / 1024;
  const rssMb = after.rss / 1024 / 1024;
  const deltaMb = (after.heapUsed - before.heapUsed) / 1024 / 1024;
  observe(
    `budget 4  heapUsed ${heapMb.toFixed(1)} MB (delta over the rebuild ${deltaMb.toFixed(1)} MB), ` +
      `rss ${rssMb.toFixed(1)} MB — target ~${MEMORY_TARGET_MB} MB, ceiling ${MEMORY_CEILING_MB} MB`
  );

  // ASSERTED ON THE HEAP, REPORTED ON RSS, and the split is deliberate. `rss`
  // measures the whole Node process — the runtime, the SQLite page cache and the
  // test runner — and lands near 135 MB here whether the index holds anything at
  // all, so an assertion on it would have ~1.5x of margin against a number the
  // index barely influences. `heapUsed` is the part this package is responsible
  // for. The plan's status column calls this an OBSERVATION, and the line above
  // is that observation with its actual number.
  assert.ok(
    heapMb < MEMORY_CEILING_MB,
    `heap ${heapMb.toFixed(1)} MB is over the ${MEMORY_CEILING_MB} MB ceiling`
  );
});

test('budget 4 (deterministic) — the index stores RANGES, not TEXT', () => {
  // The memory number above cannot actually catch "the index stored the
  // chapters": 200 chapters of ~3 KB is ~0.7 MB of prose, so an index that kept
  // every byte would still sit far under a 200 MB ceiling. This is the tooth the
  // budget DESCRIBES, expressed so that it can fail — the whole readable
  // content of the index, serialized, against the corpus that produced it.
  const files = largeManuscript(CHAPTERS);
  const built = stack('budget-footprint', files);
  built.session.rebuild(files, { indexedAt: INDEXED_AT });

  const corpusBytes = files.reduce((total, item) => total + Buffer.byteLength(item.text, 'utf8'), 0);
  const indexBytes = Buffer.byteLength(
    JSON.stringify({
      documents: built.raw.listDocuments(),
      entities: built.raw.findEntities(),
      mentions: built.raw.getMentions(),
      relations: built.raw.getRelations()
    }),
    'utf8'
  );
  const ratio = indexBytes / corpusBytes;
  observe(
    `budget 4  index payload ${(indexBytes / 1024).toFixed(0)} KB against a corpus of ` +
      `${(corpusBytes / 1024).toFixed(0)} KB (ratio ${ratio.toFixed(2)})`
  );

  assert.ok(
    ratio < 1,
    `the index serializes to ${(ratio * 100).toFixed(0)}% of the manuscript. An index that stored chapter ` +
      'TEXT rather than ranges cannot be smaller than the text it stored, so this ratio is the direct ' +
      'form of what the memory budget is described as catching'
  );
  // No mention or relation may carry prose. `EvidenceRef` has no text field, so
  // this holds structurally today — the assertion is what makes ADDING one a
  // visible failure rather than a quiet doubling of the index.
  for (const mention of built.raw.getMentions()) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(mention.evidence, 'text'),
      'evidence must be a POINTER (path plus range), never a copy of the passage'
    );
  }
});

after(() => {
  for (const store of opened.reverse()) {
    try {
      store.close();
    } catch {
      // Already closed by the case itself.
    }
  }
  disposeAll();
  console.log('\n--- WP-9a budget observations ---');
  for (const line of observations) {
    console.log(`  ${line}`);
  }
});
