/**
 * The FOUR INDEX INVARIANTS (TASK-022 WP-9a, plan `### WP-9a`).
 *
 *   1. EQUIVALENCE      — an increment lands on the index a full rebuild builds.
 *   2. LOCALITY         — re-indexing one document leaves its neighbours alone
 *                         (tech_spec ОВ-1 tooth A5, `document.generation`).
 *   3. REBUILDABILITY   — the database is a FULLY REBUILDABLE CACHE, and an
 *                         author's `ai-candidate` decision survives a rebuild
 *                         from clean state (UR-012).
 *   4. IDENTITY CONTINUITY — a move changes where a thing lives, never what it
 *                         is.
 *
 * WHY UNDER `node` AND NOT IN A SHARED CONTRACT CORE. The plan's readiness block
 * says "четыре утверждения зелёные под `node`", and the reason is not
 * bureaucratic: three of the four are about things only SQLite does. `doc_id` is
 * a real rowid four tables join to; `generation` is a real column written under
 * a compare-and-set; `fresh: true` really deletes a file and rebuilds a schema.
 * Run against the in-memory double these would be assertions about a `Map`, and
 * `bun` cannot resolve `node:sqlite` at all, so there is no lane in which both
 * could be true at once.
 *
 * EVERY ASSERTION HERE IS PAIRED WITH THE STATE THAT VIOLATES IT. That is the
 * standing lesson of this task: eight teeth came back green on the first try and
 * only one of them was working code. An assertion nobody can fail on purpose is
 * not an assertion, so each block below either constructs the violating state
 * outright or carries a REJECTING half whose absence would let a degenerate
 * implementation ("never write the column", "never change anything") pass.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryWorkspaceSource,
  ManualTimerScheduler,
  NarrativeIndexMaintainer,
  NarrativeIndexSession,
  TestNarrativeFileWatcher,
  type IndexableFile,
  type NarrativeIndexStore
} from '../../lib/common/index.js';
import { SqliteNarrativeIndexStore } from '../../lib/node/sqlite-narrative-index-store.js';
import { disposeAll, makeWorkspace, must } from './harness.mts';
import {
  ARJUNA_CARD,
  CH,
  GANDIVA_CARD,
  KRISHNA_CARD,
  KRISHNA_DUPLICATE_CARD,
  LEGACY_CARD,
  UNLISTED_CHAPTER,
  file,
  hardManuscript,
  manuscriptWithoutManifest
} from './manuscript-fixture.mts';

const SCHEMA_VERSION = 1;
const INDEXED_AT = 1_700_000_400_000;
const NOW = 1_700_000_500_000;

const opened: { close(): void }[] = [];

function makeStore(name: string): NarrativeIndexStore {
  const workspace = makeWorkspace(name);
  const store = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0
  });
  opened.push(store);
  return store;
}

interface Built {
  store: NarrativeIndexStore;
  session: NarrativeIndexSession;
  source: InMemoryWorkspaceSource;
  maintainer: NarrativeIndexMaintainer;
}

/** Stand a maintenance stack up over real SQLite and build the index once. */
async function build(name: string, files: IndexableFile[] = hardManuscript()): Promise<Built> {
  const store = makeStore(name);
  const session = new NarrativeIndexSession({ store, schemaVersion: SCHEMA_VERSION, now: () => NOW });
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
  await maintainer.rebuildNow();
  source.resetReads();
  return { store, session, source, maintainer };
}

/**
 * Everything about an index that is a FACT rather than a row id.
 *
 * `docId` is excluded ON PURPOSE — it is stable while a row lives and explicitly
 * NOT across rebuilds, so including it would make "equal to a full rebuild"
 * false for a reason that has nothing to do with correctness. `generation` is
 * excluded for the same reason and a sharper one: it COUNTS WRITES, so an
 * incrementally-reached index and a freshly-rebuilt one differ there by
 * construction. Invariant 2 asserts that column directly instead.
 */
function fingerprint(store: NarrativeIndexStore): unknown {
  const stable = (rows: unknown[]): unknown[] =>
    [...rows].sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1));
  return {
    documents: store.listDocuments().map(document => ({
      relPath: document.relPath,
      kind: document.kind,
      contentHash: document.contentHash,
      chapterOrder: document.chapterOrder ?? null,
      manifestIncluded: document.manifestIncluded
    })),
    entities: stable(
      store.findEntities().map(entity => ({
        id: entity.id,
        type: entity.type,
        name: entity.name,
        sourcePath: entity.sourcePath,
        origin: entity.origin,
        aliases: [...entity.aliases].sort()
      }))
    ),
    duplicates: store.getDuplicateEntities(),
    mentions: stable(
      store.getMentions().map(mention => ({
        entityId: mention.entityId,
        path: mention.evidence.path,
        kind: mention.evidence.evidenceKind,
        resolved: mention.resolved,
        raw: mention.raw
      }))
    ),
    relations: stable(
      store.getRelations().map(relation => ({
        sourceId: relation.sourceId,
        targetId: relation.targetId,
        relType: relation.relType,
        origin: relation.origin,
        ownerPath: relation.ownerPath ?? null,
        sourceResolved: relation.sourceResolved,
        targetResolved: relation.targetResolved,
        evidence: relation.evidence.map(item => item.path)
      }))
    )
  };
}

/** Build `files` from scratch in a SECOND store. Nothing incremental touches it. */
function fullRebuildOf(name: string, files: readonly IndexableFile[]): NarrativeIndexStore {
  const store = makeStore(name);
  new NarrativeIndexSession({ store, schemaVersion: SCHEMA_VERSION, now: () => NOW }).rebuild(files, {
    indexedAt: INDEXED_AT
  });
  return store;
}

// ===========================================================================
// Invariant 1 — EQUIVALENCE
// ===========================================================================

test('invariant 1 — a sequence of increments over the HARD fixture equals a full rebuild of the result', async () => {
  const built = await build('inv1');
  const tree = new Map(hardManuscript().map(item => [item.path, item]));

  assert.ok(
    built.store
      .getRelations({ origin: 'derived' })
      .some(relation => relation.sourceId === 'arjuna' && relation.targetId === 'krishna'),
    'the fixture starts with a krishna/arjuna co-occurrence edge, supported by ch-01 and ch-04'
  );

  // (a) EDIT TWO CHAPTERS SO A DERIVED EDGE MUST DISAPPEAR.
  //
  // THIS STEP IS LOAD-BEARING AND IT WAS ADDED AFTER THE TOOTH FAILED TO BITE.
  // The first draft of this sequence only ever ADDED co-occurrences, and an
  // implementation whose `clearDerivedRelations` was a NO-OP passed it — an
  // upsert covers an addition perfectly. Co-occurrence is a fold over ALL
  // mentions, so only the REMOVAL of the last chapter supporting a pair can
  // prove the derived layer is recomputed wholesale rather than accumulated.
  // krishna and arjuna share ch-01 and ch-04; both are stripped here.
  for (const path of [CH(1), CH(4)]) {
    const stripped = file(path, 'Только: [[char:krishna|Кришна]].');
    built.source.put(stripped);
    tree.set(path, stripped);
  }
  const stripAnswer = await built.maintainer.applyChanges([
    { path: CH(1), type: 'updated' },
    { path: CH(4), type: 'updated' }
  ]);
  assert.equal(stripAnswer.data.mode, 'incremental', 'a chapter edit must not escalate');
  assert.equal(
    built.store
      .getRelations({ origin: 'derived' })
      .filter(relation => relation.sourceId === 'arjuna' && relation.targetId === 'krishna').length,
    0,
    'the edge must be GONE. An implementation that only upserts derived relations leaves it behind, and ' +
      'an upsert cannot express a deletion'
  );

  // (b) move a chapter — byte-identical, so it pairs
  built.source.move(CH(5), 'content/ch-05-moved.md');
  tree.delete(CH(5));
  tree.set(
    'content/ch-05-moved.md',
    file('content/ch-05-moved.md', must(hardManuscript().find(f => f.path === CH(5)), 'ch-05').text)
  );
  const moveAnswer = await built.maintainer.applyChanges([
    { path: CH(5), type: 'deleted' },
    { path: 'content/ch-05-moved.md', type: 'added' }
  ]);
  assert.equal(moveAnswer.data.mode, 'incremental', 'a paired move must not escalate');
  assert.equal(moveAnswer.data.documentsMoved.length, 1, 'and it really paired');

  // (c) delete the unlisted chapter
  built.source.remove(UNLISTED_CHAPTER);
  tree.delete(UNLISTED_CHAPTER);
  const deleteAnswer = await built.maintainer.applyChanges([{ path: UNLISTED_CHAPTER, type: 'deleted' }]);
  assert.equal(deleteAnswer.data.mode, 'incremental', 'a chapter deletion must not escalate');

  // (d) add a brand-new chapter that references an EXISTING card
  const added = file('content/ch-07.md', 'Новая глава: [[char:balarama|Баларама]] и [[char:krishna|Кришна]].');
  built.source.put(added);
  tree.set('content/ch-07.md', added);
  const addAnswer = await built.maintainer.applyChanges([{ path: 'content/ch-07.md', type: 'added' }]);
  assert.equal(addAnswer.data.mode, 'incremental', 'a chapter addition must not escalate');

  const rebuilt = fullRebuildOf('inv1-ref', [...tree.values()]);
  assert.deepEqual(
    fingerprint(built.store),
    fingerprint(rebuilt),
    'four increments — edit, move, delete, add — must reach exactly the index a rebuild of the final ' +
      'tree reaches. A derived layer that is upserted rather than recomputed diverges here, because ' +
      'an upsert cannot express the deletion of a co-occurrence edge'
  );
});

test('invariant 1 REJECTING — the fingerprint really does discriminate, so the check above is not vacuous', () => {
  const base = fullRebuildOf('inv1-r-a', hardManuscript());

  // The SMALLEST possible divergence: one chapter names a different character.
  // If the comparator could not see this, invariant 1 would pass against any
  // implementation at all — which is exactly how a contract suite on this task
  // was once green by fixture coincidence.
  const perturbed = fullRebuildOf(
    'inv1-r-b',
    hardManuscript().map(item =>
      item.path === CH(2) ? file(CH(2), 'Один: [[char:balarama|Баларама]].') : item
    )
  );
  assert.notDeepEqual(
    fingerprint(base),
    fingerprint(perturbed),
    'a comparator blind to a changed mention would make invariant 1 unfalsifiable'
  );

  // And it is equal to ITSELF rebuilt twice, so the discrimination above is not
  // simply "everything always differs" (e.g. a timestamp leaking into it).
  const twin = fullRebuildOf('inv1-r-c', hardManuscript());
  assert.deepEqual(
    fingerprint(base),
    fingerprint(twin),
    'two rebuilds of the same tree must be identical — otherwise invariant 1 could never hold and the ' +
      'assertion above would be passing for the wrong reason'
  );
});

test('invariant 1 — equivalence also holds on a workspace with NO manifest', async () => {
  const built = await build('inv1-nomanifest', manuscriptWithoutManifest());
  assert.equal(
    built.session.documentOf(CH(1))?.chapterOrder,
    undefined,
    'with no manifest NOTHING has a provable position'
  );

  const edited = file(CH(2), 'Без манифеста: [[char:arjuna|Арджуна]].');
  built.source.put(edited);
  const answer = await built.maintainer.updateDocument(CH(2));
  assert.equal(answer.data.mode, 'incremental');

  const expected = manuscriptWithoutManifest().map(item => (item.path === CH(2) ? edited : item));
  assert.deepEqual(
    fingerprint(built.store),
    fingerprint(fullRebuildOf('inv1-nomanifest-ref', expected)),
    'a manuscript with no manifest is still an index, and the increment must still equal the rebuild'
  );
});

// ===========================================================================
// AC-1 (issue #46) / ISS-352 — ORDER STABILITY, not merely composition
// ===========================================================================

test(
  'AC-1 (ISS-352) — findEntities() and getMentions() come back in the SAME ORDER from two ' +
    'independent full rebuilds of the same tree',
  () => {
    // `fingerprint()` above (:115-159) is the comparator every invariant-1 test
    // uses, and for THAT purpose it deliberately re-sorts `entities`/`mentions`
    // by `JSON.stringify` before diffing (:116-117) — invariant 1 is about an
    // incremental sequence reaching the same CONTENT as a rebuild, and a
    // derived-layer fold is allowed to land its rows in a different order than
    // a fresh walk without being wrong. That is the right call for invariant 1,
    // but it means NOTHING at this level pins the ORDER a caller of
    // `findEntities()` / `getMentions()` actually observes — and AC-1
    // (issue #46) is a claim about exactly that: "a stable list of entities and
    // mentions" is a claim about reproducible ORDER, not merely reproducible
    // membership. An implementation whose full rebuild returns the same set of
    // entities/mentions in a DIFFERENT order every time — e.g. iterating a
    // `Map` built from something less deterministic than a sorted walk — would
    // pass every `fingerprint()`-based assertion in this file while failing
    // AC-1 outright, and nothing here would say so.
    //
    // NO FIELD NEEDS STRIPPING HERE, unlike `fingerprint()`'s `documents`
    // section (whose exclusion of `docId`/`generation` is explained at
    // :105-113). `docId` and `generation` are real columns on `document` /
    // real fields on `IndexedDocument` (`toDocument`,
    // `sqlite-narrative-index-store.ts:239-248`), but `findEntities()` and
    // `getMentions()` return the PORT-LEVEL `NarrativeEntity` / `NarrativeMention`
    // shapes (`graph/narrative-entity.ts`, `graph/narrative-mention.ts`), and
    // NEITHER type carries a rowid or a generation counter at all: `toMention`
    // (`sqlite-narrative-index-store.ts:290-296`) assembles the object field by
    // field and never assigns `doc_id`/`mention_id` onto it, and an entity's
    // stored payload is `JSON.stringify` of the very `NarrativeEntity` object
    // the caller constructed — which has no such field either. So a bare
    // `assert.deepEqual` on the array, ORDER INCLUDED, is the correct
    // comparison here, not an approximation forced to ignore technical noise:
    // there is no technical field left for two independent rebuilds to
    // legitimately disagree on.
    const first = fullRebuildOf('ac1-order-a', hardManuscript());
    const second = fullRebuildOf('ac1-order-b', hardManuscript());

    assert.deepEqual(
      first.findEntities(),
      second.findEntities(),
      'AC-1: findEntities() must return entities in the SAME order on every rebuild of an identical tree. ' +
        'Order is a structural guarantee today (`ORDER BY e.entity_id`, sqlite-narrative-index-store.ts) ' +
        'but was never pinned by a test at this level — a pass discriminating only on composition would let ' +
        'an order-unstable rebuild through'
    );
    assert.deepEqual(
      first.getMentions(),
      second.getMentions(),
      'AC-1: getMentions() must return mentions in the SAME order on every rebuild of an identical tree ' +
        '(`ORDER BY m.mention_id`, sqlite-narrative-index-store.ts), for the same reason'
    );
  }
);

test(
  'AC-1 order-stability REJECTING — the assertion above really pins order, not merely re-deriving ' +
    'fingerprint()',
  () => {
    // The smallest possible order-only perturbation that fingerprint() would
    // NOT catch: the same two rebuilds, but one side's arrays are reversed
    // before comparison. If the assertion above could not tell reversed from
    // forward, it would be dead weight duplicating fingerprint() rather than
    // adding the order guarantee it claims to add.
    const first = fullRebuildOf('ac1-order-r-a', hardManuscript());
    const second = fullRebuildOf('ac1-order-r-b', hardManuscript());

    assert.ok(
      first.findEntities().length > 1,
      'the fixture must carry more than one entity for a reversal to be observable at all'
    );
    assert.notDeepEqual(
      first.findEntities(),
      [...second.findEntities()].reverse(),
      'a comparator blind to order would make the AC-1 assertion pass against a reversed list, which is ' +
        'exactly the failure mode a same-composition-different-order implementation would produce'
    );
    assert.notDeepEqual(
      first.getMentions(),
      [...second.getMentions()].reverse(),
      'same check for mentions'
    );
  }
);

// ===========================================================================
// Invariant 2 — LOCALITY (tech_spec ОВ-1 tooth A5)
// ===========================================================================

test('invariant 2 — re-indexing ONE document moves ONLY its own `generation`', async () => {
  const built = await build('inv2');
  const before = new Map(built.store.listDocuments().map(document => [document.relPath, document.generation]));
  assert.ok(before.size > 1, 'the fixture must have neighbours for this to say anything');

  built.source.put(file(CH(2), 'Изменено: [[char:arjuna|Арджуна]].'));
  const answer = await built.maintainer.updateDocument(CH(2));

  // Guard against the ESCALATION LOOPHOLE: a pass that quietly rebuilt
  // everything would rewrite every row and this invariant would be measuring a
  // rebuild. `mode` is reported precisely so a test can tell the two apart.
  assert.equal(answer.data.mode, 'incremental', 'this must be a genuine increment, not a quiet rebuild');
  assert.deepEqual(answer.data.documentsReindexed, [CH(2)], 'exactly one document was re-extracted');

  const moved = built.store
    .listDocuments()
    .filter(document => before.get(document.relPath) !== document.generation)
    .map(document => document.relPath);
  assert.deepEqual(
    moved,
    [CH(2)],
    'ОВ-1 tooth A5: `document.generation` is PER-DOCUMENT. An implementation that stamped the committed ' +
      'generation onto every row — or that re-extracted the workspace to be safe — moves all twelve here'
    );
  assert.equal(
    must(built.store.getDocument(CH(2)), 'the edited document').generation,
    built.store.lifecycle().generation,
    'and the one that DID move carries the generation the transaction committed'
  );
});

test('invariant 2 REJECTING — a FULL rebuild moves EVERY `generation`, so the column is not simply frozen', async () => {
  const built = await build('inv2-r');
  const before = new Map(built.store.listDocuments().map(document => [document.relPath, document.generation]));

  await built.maintainer.rebuildNow();

  const unmoved = built.store
    .listDocuments()
    .filter(document => before.get(document.relPath) === document.generation)
    .map(document => document.relPath);
  assert.deepEqual(
    unmoved,
    [],
    'without this half, an implementation that NEVER wrote `generation` at all would satisfy the ' +
      'locality assertion perfectly — nothing would ever move, including the document that changed'
  );
});

// ===========================================================================
// Invariant 3 — REBUILDABILITY (UR-012)
// ===========================================================================

test("invariant 3 — an author's `ai-candidate` decision survives a rebuild from CLEAN state", async () => {
  const built = await build('inv3');
  const candidatesBefore = built.store
    .getRelations({ origin: 'ai-candidate' })
    .map(relation => `${relation.sourceId}->${relation.targetId}`);
  assert.deepEqual(
    candidatesBefore,
    ['gandiva->arjuna'],
    'the hand-built fixture really does carry one — without it the `CHECK` that ОВ-1 added for UR-012 ' +
      'would have no case that exercises it at all'
  );

  // `fresh: true` DELETES the database file and rebuilds the schema. This is the
  // "чистое состояние" the plan names, not a `DELETE FROM`.
  built.session.rebuild(hardManuscript(), { indexedAt: INDEXED_AT, fresh: true });

  const survivor = must(
    built.store.getRelations({ origin: 'ai-candidate' })[0],
    "the author's ai-candidate relation after a fresh rebuild"
  );
  assert.equal(survivor.sourceId, 'gandiva');
  assert.equal(survivor.targetId, 'arjuna');
  assert.equal(
    survivor.ownerPath,
    GANDIVA_CARD,
    'it came back BECAUSE it lives in the card of its own `source_id` — an implementation that kept the ' +
      "author's decision only in the database loses it to the very first rebuild"
  );
});

test('invariant 3 PERTURBATION — a relation that exists ONLY in the database is ERASED by a rebuild', async () => {
  const built = await build('inv3-p');

  // Construct the violating state directly: an `ai-candidate` relation written
  // straight into the store, present in NO source file. This is precisely the
  // shape the invariant forbids, and the only way to prove the rebuild really
  // discards database-only state rather than merging over it.
  built.store.transaction(writer => {
    writer.putRelation({
      sourceId: 'gandiva',
      targetId: 'balarama',
      relType: 'ownership',
      origin: 'ai-candidate',
      sourceResolved: true,
      targetResolved: true,
      ownerPath: GANDIVA_CARD,
      evidence: [{ path: GANDIVA_CARD, evidenceKind: 'whole-file' }]
    });
  });
  assert.equal(
    built.store.getRelations({ origin: 'ai-candidate' }).length,
    2,
    'the violating state was really constructed'
  );

  built.session.rebuild(hardManuscript(), { indexedAt: INDEXED_AT, fresh: true });

  assert.deepEqual(
    built.store.getRelations({ origin: 'ai-candidate' }).map(relation => relation.targetId),
    ['arjuna'],
    'the database-only relation is GONE and the card-borne one remains. That asymmetry IS the invariant: ' +
      'the database is a fully rebuildable cache, so its contents can never be a source of truth'
  );
});

test('invariant 3 — the MATCHED PAIR on `origin`: a stated value is kept, an absent one reads `explicit`', async () => {
  const built = await build('inv3-pair');
  built.session.rebuild(hardManuscript(), { indexedAt: INDEXED_AT, fresh: true });

  const ownership = built.store
    .getRelations({ relPath: GANDIVA_CARD })
    .filter(relation => relation.relType === 'ownership');
  const byTarget = new Map(ownership.map(relation => [relation.targetId, relation]));

  assert.equal(
    must(byTarget.get('arjuna'), 'the entry WITH origin: ai-candidate').origin,
    'ai-candidate',
    'the entry that states its provenance keeps it'
  );
  assert.equal(
    must(byTarget.get('krishna'), 'the entry with NO origin field').origin,
    'explicit',
    'and the entry that states none reads as `explicit`. These two are a MATCHED PAIR on one card: an ' +
      'implementation that stamps a single origin on every entry fails one of them whichever value it ' +
      'picks, which is what neither assertion alone can catch'
  );
  assert.equal(
    must(byTarget.get('nobody-at-all'), 'the entry naming an unknown id').targetResolved,
    false,
    'and a broken end is STORED WITH THE FLAG rather than dropped or silently self-labelled (ISS-319)'
  );
});

test('invariant 3 — a rebuild from clean state restores the WHOLE index, not merely the relations', async () => {
  const built = await build('inv3-whole');
  const before = fingerprint(built.store);

  built.session.rebuild(hardManuscript(), { indexedAt: INDEXED_AT, fresh: true });

  assert.deepEqual(
    fingerprint(built.store),
    before,
    'aliases, the duplicate-id finding, the broken mention and the unlisted chapter all have to come ' +
      'back identically — "the database is a rebuildable cache" is a claim about the whole of it'
  );
  // Named explicitly, because each is a fixture feature that a narrower rebuild
  // could silently drop while the relations still matched.
  assert.deepEqual(
    built.store.getDuplicateEntities()[0]?.keptRelPath,
    KRISHNA_CARD,
    'the duplicate-id collision survives, and still names the SAME winner'
  );
  assert.deepEqual(
    built.store.getDuplicateEntities()[0]?.excludedRelPaths,
    [KRISHNA_DUPLICATE_CARD],
    'and the same loser'
  );
  assert.deepEqual(
    must(built.store.getEntity('krishna'), 'krishna').aliases,
    ['Говинда', 'Мадхава'],
    'aliases survive'
  );
  assert.equal(
    must(built.store.getEntity('balarama'), 'the legacy card').origin,
    'explicit',
    'and the legacy card — no `origin` field at all — still reads as author-written'
  );
});

// ===========================================================================
// Invariant 4 — IDENTITY CONTINUITY
// ===========================================================================

test('invariant 4 — a moved CARD keeps its entity id, which was never derived from the path', async () => {
  const built = await build('inv4-card');
  assert.equal(
    must(built.store.getEntity('arjuna'), 'arjuna').sourcePath,
    ARJUNA_CARD,
    'the fixture card is `warrior-3.yaml` and the entity is `arjuna` — the filename and the id DISAGREE, ' +
      'which is the only arrangement under which this test can fail'
  );

  built.source.move(ARJUNA_CARD, 'entities/characters/renamed-hero.yaml');
  const answer = await built.maintainer.applyChanges([
    { path: ARJUNA_CARD, type: 'deleted' },
    { path: 'entities/characters/renamed-hero.yaml', type: 'added' }
  ]);
  assert.equal(answer.data.documentsMoved.length, 1, 'the byte-identical pair really was paired');

  const entity = must(built.store.getEntity('arjuna'), 'arjuna after the move');
  assert.equal(entity.id, 'arjuna', 'the id comes from the YAML `id:` field and a move cannot touch it');
  assert.equal(
    built.store.getEntity('renamed-hero'),
    undefined,
    'an implementation deriving the id from the FILENAME would have invented `renamed-hero` here — and ' +
      'against a fixture whose filename equalled its id, it would have looked identical to a correct one'
  );
  assert.equal(
    entity.sourcePath,
    'entities/characters/renamed-hero.yaml',
    '`sourcePath` is DENORMALIZED into the entity payload, so a move that only re-keyed the document row ' +
      'would leave it naming a file that no longer exists'
  );
  assert.ok(
    built.store.getMentions({ entityId: 'arjuna' }).some(mention => mention.resolved),
    'and references to it still resolve'
  );
});

test('invariant 4 — a moved CHAPTER keeps its `doc_id`, and nothing still cites the old path', async () => {
  const built = await build('inv4-chapter');
  const before = must(built.session.documentOf(CH(1)), 'ch-01 before');

  built.source.move(CH(1), 'content/ch-01-renamed.md');
  await built.maintainer.applyChanges([
    { path: CH(1), type: 'deleted' },
    { path: 'content/ch-01-renamed.md', type: 'added' }
  ]);

  const afterDocument = must(built.session.documentOf('content/ch-01-renamed.md'), 'ch-01 after');
  assert.equal(
    afterDocument.docId,
    before.docId,
    'the rowid must SURVIVE — it is the only thing the pairing buys, and a pass that applied the pair as ' +
      'delete-then-insert renumbers it here'
  );
  assert.equal(built.session.documentOf(CH(1)), undefined, 'the old path is gone');
  assert.equal(built.store.getMentions({ relPath: CH(1) }).length, 0, 'no mention still cites it');
  for (const relation of built.store.getRelations()) {
    for (const evidence of relation.evidence) {
      assert.notEqual(evidence.path, CH(1), 'and no relation is still evidenced by the old path');
    }
  }
});

test('invariant 4 — identity does NOT depend on the pairing: a move WITH an edit lands on the same ids', async () => {
  // tech_spec :609 — "ЛЮБОЕ спаривание (включая НИ ОДНОГО) даёт индекс, равный
  // полной перестройке на итоговом дереве". The pairing is an OPTIMISATION, so
  // the case where it deliberately does NOT fire must reach the same identities.
  const built = await build('inv4-unpaired');
  const moved = file(
    'entities/characters/renamed-hero.yaml',
    ['id: arjuna', 'name: Арджуна', 'aliases:', '  - Партха', '  - Савьясачин'].join('\n')
  );
  built.source.remove(ARJUNA_CARD);
  built.source.put(moved);

  const answer = await built.maintainer.applyChanges([
    { path: ARJUNA_CARD, type: 'deleted' },
    { path: 'entities/characters/renamed-hero.yaml', type: 'added' }
  ]);
  assert.deepEqual(answer.data.documentsMoved, [], 'the bytes differ, so nothing may pair');
  assert.equal(
    answer.data.mode,
    'rebuild',
    'an UNPAIRED card change is workspace-level and escalates — which is the path this case is here to ' +
      'exercise, since the paired one never reaches it'
  );

  const entity = must(built.store.getEntity('arjuna'), 'arjuna after an unpaired move');
  assert.equal(entity.sourcePath, 'entities/characters/renamed-hero.yaml');
  assert.deepEqual(entity.aliases, ['Партха', 'Савьясачин'], 'and the edit really was applied');

  const expected = hardManuscript()
    .filter(item => item.path !== ARJUNA_CARD)
    .concat([moved]);
  assert.deepEqual(
    fingerprint(built.store),
    fingerprint(fullRebuildOf('inv4-unpaired-ref', expected)),
    'pairing or no pairing, the index is the one a rebuild of the final tree produces'
  );
});

/**
 * CHARACTERIZING, NOT ASSERTING — and the difference is the point.
 *
 * `entity.sourceUri` is NOT repaired by a paired move: `moveDocument` rewrites
 * the denormalized `sourcePath` inside `entity.payload`
 * (`sqlite-narrative-index-store.ts:1056-1060`) and the in-memory adapter does
 * the same for its object (`in-memory-narrative-index-store.ts:496-497`), but
 * NEITHER touches `sourceUri`. So after a rename the entity still reports the
 * URI of the file it used to live at.
 *
 * THIS IS PINNED RATHER THAN FIXED, on purpose. tech_spec ОВ-5 (:722) states the
 * constraint that produces it: "Вывести одно из другого можно только зная
 * workspace root, который `src/common` знать не обязан и не должен" — the port
 * cannot derive a URI from a relative path, so repairing it in the SQLite
 * adapter alone would make the two adapters disagree, which is the one thing the
 * port exists to prevent. Inventing a fix here would be re-deriving a decided
 * design; the honest move is a test that fails the moment the behaviour changes
 * in EITHER direction, exactly as this package already pins the ASCII-only
 * asymmetry (`entity-card-extraction.ts:33-35`).
 *
 * Reported as a finding of WP-9a. A full rebuild repairs it, which is asserted
 * below so the blast radius is recorded and not merely asserted about.
 */
test('invariant 4 FINDING (characterizing) — `sourceUri` does NOT follow a paired move; a rebuild repairs it', async () => {
  const built = await build('inv4-uri');
  const originalUri = must(built.store.getEntity('arjuna'), 'arjuna').sourceUri;

  built.source.move(ARJUNA_CARD, 'entities/characters/renamed-hero.yaml');
  await built.maintainer.applyChanges([
    { path: ARJUNA_CARD, type: 'deleted' },
    { path: 'entities/characters/renamed-hero.yaml', type: 'added' }
  ]);

  const afterMove = must(built.store.getEntity('arjuna'), 'arjuna after the move');
  assert.equal(
    afterMove.sourceUri,
    originalUri,
    'CURRENT BEHAVIOUR, pinned so it cannot change unnoticed: `sourceUri` still names the OLD path while ' +
      '`sourcePath` names the new one. If a later work package repairs this, THIS ASSERTION is the one ' +
      'that must be updated — deliberately, with the ОВ-5 constraint answered'
  );
  assert.notEqual(
    afterMove.sourcePath,
    afterMove.sourceUri.replace('file:///workspace/', ''),
    'the two fields genuinely disagree after a move — which is what makes this a finding and not a ' +
      'restatement of the assertion above'
  );

  // The blast radius: the divergence does not outlive the next full rebuild.
  built.session.rebuild(
    hardManuscript()
      .filter(item => item.path !== ARJUNA_CARD)
      .concat([
        file(
          'entities/characters/renamed-hero.yaml',
          must(hardManuscript().find(f => f.path === ARJUNA_CARD), 'the card').text
        )
      ]),
    { indexedAt: INDEXED_AT, fresh: true }
  );
  assert.equal(
    must(built.store.getEntity('arjuna'), 'arjuna after a rebuild').sourceUri,
    'file:///workspace/entities/characters/renamed-hero.yaml',
    'a full rebuild re-reads the file and the caller supplies the new URI, so the staleness is bounded ' +
      'by the next rebuild rather than permanent'
  );
});

/**
 * CHARACTERIZING, NOT ASSERTING — the same discipline as the `sourceUri`
 * finding just above, and the same failure shape seen from a second angle
 * (ISS-355).
 *
 * `entity.evidence` is a SECOND denormalized pointer at the card's own path,
 * independent of `sourcePath` — set once at extraction time to
 * `wholeFileEvidence(document.path)` (`entity-card-extraction.ts:328`) and
 * never touched again after that. `moveDocument` repairs `sourcePath` inside
 * the same JSON payload (`sqlite-narrative-index-store.ts:1084-1092`,
 * `in-memory-narrative-index-store.ts:515-519`), but in BOTH adapters the loop
 * that walks the moved document's owned entities only ever writes
 * `entity.sourcePath = to` — `entity.evidence.path` is left exactly as it was.
 *
 * AC-3 (issue #46) does not reach this: its letter is about MENTION and
 * RELATION evidence, and `NarrativeEntity.evidence` is optional by design for
 * an unrelated reason (`graph/narrative-entity.ts:48-53` — the legacy
 * transport shape cannot carry one). And every real navigation consumer reads
 * the REPAIRED `sourcePath`, never `evidence.path`, so this is not user-visible
 * today. But nothing at the STORE level pinned the staleness before this test
 * — if that workaround is ever removed, only one browser-level test would
 * catch it. This is pinned rather than fixed, exactly as ISS-355 records it,
 * so the next reader does not mistake the tooth for an endorsement: if a
 * future work package repairs this, THIS ASSERTION is the one that must be
 * updated — deliberately.
 */
test(
  'ISS-355 FINDING (characterizing) — entity.evidence.path does NOT follow a paired move; sourcePath does',
  async () => {
    const built = await build('iss355-evidence');
    const before = must(built.store.getEntity('arjuna'), 'arjuna before the move');
    const originalEvidencePath = must(
      before.evidence,
      'arjuna must carry whole-file evidence from card extraction'
    ).path;
    assert.equal(
      originalEvidencePath,
      ARJUNA_CARD,
      'the evidence starts out pointing at the card\'s own path, same as sourcePath'
    );

    built.source.move(ARJUNA_CARD, 'entities/characters/renamed-hero.yaml');
    await built.maintainer.applyChanges([
      { path: ARJUNA_CARD, type: 'deleted' },
      { path: 'entities/characters/renamed-hero.yaml', type: 'added' }
    ]);

    const after = must(built.store.getEntity('arjuna'), 'arjuna after the move');
    assert.equal(
      after.sourcePath,
      'entities/characters/renamed-hero.yaml',
      'sourcePath IS repaired by the move — this is the field every real navigation consumer reads'
    );
    assert.equal(
      must(after.evidence, 'arjuna after the move still carries evidence').path,
      ARJUNA_CARD,
      'CURRENT BEHAVIOUR, pinned so it cannot change unnoticed (ISS-355): evidence.path still names the ' +
        'OLD path while sourcePath names the new one. Not a letter-of-AC-3 violation — entity.evidence is ' +
        'optional and AC-3 is about mention/relation evidence — but a real staleness at the store level ' +
        'that today only real navigation code (which reads sourcePath, not evidence.path) papers over'
    );
    assert.notEqual(
      after.evidence?.path,
      after.sourcePath,
      'the two denormalized copies of the same fact genuinely disagree after a move — what makes this a ' +
        'finding and not a restatement of the assertion above'
    );
  }
);

// ===========================================================================
// The fixture itself has to be what it claims to be
// ===========================================================================

test('the fixture carries every feature the four invariants rely on', async () => {
  const built = await build('fixture-audit');
  const store = built.store;

  assert.deepEqual(
    must(store.getEntity('krishna'), 'krishna').aliases,
    ['Говинда', 'Мадхава'],
    'ALIASES'
  );
  assert.equal(store.getDuplicateEntities().length, 1, 'DUPLICATE ID');
  assert.equal(store.getMentions({ brokenOnly: true }).length, 1, 'BROKEN MENTION');
  assert.equal(
    store.getRelations({ brokenOnly: true }).length,
    1,
    'BROKEN RELATION END — a different source from a broken mention (F-TS3-1)'
  );
  assert.equal(
    must(store.getDocument(UNLISTED_CHAPTER), 'the unlisted chapter').chapterOrder,
    undefined,
    'A CHAPTER THE MANIFEST DOES NOT LIST'
  );
  assert.equal(must(store.getEntity('balarama'), 'the legacy card').origin, 'explicit', 'LEGACY CARD');
  assert.equal(store.getRelations({ origin: 'ai-candidate' }).length, 1, 'HAND-BUILT ai-candidate RELATION');

  // The liberal walk: these three files ARRIVE and are REFUSED. A fixture that
  // omitted them would make the refusal green because nothing was offered.
  for (const path of ['sources/citations.yaml', 'sources/excerpts.jsonl', 'knowledge/plans/act-1.yaml']) {
    assert.ok(
      hardManuscript().some(item => item.path === path),
      `${path} must be OFFERED to the pipeline`
    );
    assert.equal(store.getDocument(path), undefined, `${path} must not become a document`);
  }
  assert.equal(
    store.getRelations().filter(relation => relation.ownerPath?.startsWith('sources/')).length,
    0,
    'and they contribute no relation (source 5 is an absence, and this is where it is observable)'
  );
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
});
