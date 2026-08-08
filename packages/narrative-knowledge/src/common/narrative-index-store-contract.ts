/**
 * The contract core of {@link NarrativeIndexStore} — runner-agnostic (TASK-022
 * WP-3, plan "Стратегия тестирования под двумя рантаймами").
 *
 * WHY THIS FILE EXISTS IN THIS SHAPE. The repository tests with `bun`, and
 * `bun` cannot resolve `node:sqlite`, so the production store is unreachable
 * from the main test run. The naive answer — "write one suite for both
 * adapters" — does not survive contact: `bun:test` and the `node` runner have
 * different APIs, so the real outcome is two copies that drift. The mechanism
 * that prevents that is here: PLAIN ASYNC FUNCTIONS that throw on mismatch,
 * with no `describe`, no `test`, no `expect`, and no import from any runner.
 * Two thin harnesses — one under `bun` against the in-memory adapter, one under
 * real `node` against SQLite — feed the SAME functions. There is physically one
 * body of assertions, so there is nothing to diverge.
 *
 * WHAT BELONGS HERE AND WHAT DOES NOT. Only behaviour BOTH adapters must have.
 * Durability, WAL, the writer lock, corruption recovery, `STRICT` typing and
 * every `CHECK` as a SCHEMA fact are node-only by nature and live in the node
 * run; putting them here would either fail against the in-memory adapter or,
 * worse, be weakened until it passed — which is how a suite ends up proving
 * nothing while looking thorough.
 */

import type {
  NarrativeDocumentKind,
  NarrativeEntity,
  NarrativeEvent,
  NarrativeIndexStore,
  NarrativeMention,
  NarrativeRelation
} from './graph';
import { isNarrativeIndexStoreError, rangeEvidence, wholeFileEvidence } from './graph';
import { check, deepEqual, equal, rejectsSomehow, rejectsWithKind } from './contract-assertions';

/**
 * How a harness produces a store for one case.
 *
 * `readOnly` asks for an instance that MAY NOT WRITE. The in-memory adapter
 * reaches that state by construction; the SQLite adapter reaches it the only
 * way it can in production — by opening a file whose writer lock is already
 * held. A harness that cannot produce one says so by returning `undefined`, and
 * the case then reports itself as unsupported rather than passing silently.
 */
export type MakeContractStore = (options?: {
  readOnly?: boolean;
}) => Promise<NarrativeIndexStore | undefined> | NarrativeIndexStore | undefined;

export interface NarrativeIndexStoreContractCase {
  name: string;
  run(makeStore: MakeContractStore): Promise<void>;
}

// --------------------------------------------------------------------------
// Assertions — hand-rolled and SHARED, see `contract-assertions.ts`
// --------------------------------------------------------------------------

/** As the shared helper, bound to this port's error narrowing so a call site
 *  does not have to pass it every time. */
async function rejects(body: () => unknown, kind: string, what: string): Promise<void> {
  return rejectsWithKind(body, kind, what, isNarrativeIndexStoreError);
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const CHAPTER = 'manuscript/ch-01.md';
const CARD = 'entities/krishna.yaml';
const OTHER_CARD = 'entities/arjuna.yaml';

/**
 * Two more cards, named so that BINARY order and Russian locale order DISAGREE
 * about them.
 *
 * `'Я'` is U+042F and `'а'` is U+0430, so by code point — which is what SQLite's
 * default collation compares, byte for byte over UTF-8 — the upper-case one
 * comes first. `localeCompare` under a Russian locale folds case and puts
 * `'арджуна'` first instead. Any list this port promises an order for has to be
 * sorted the first way in BOTH adapters, and these two paths are how the suite
 * finds out when one of them is sorted the second way.
 */
const CYRILLIC_CARD_UPPER = 'entities/Ярость.yaml';
const CYRILLIC_CARD_LOWER = 'entities/арджуна.yaml';

function chapterDocument() {
  return {
    relPath: CHAPTER,
    kind: 'chapter' as const,
    sizeBytes: 1024,
    mtimeMs: 1_700_000_000_000,
    contentHash: 'a'.repeat(64),
    chapterOrder: 0,
    // Manifest-derived, and beside `chapterOrder` on purpose: schema v3 stores
    // both or neither, and a fixture that carried only one would let an adapter
    // forget the other and still pass the round-trip case.
    title: 'Глава первая',
    indexedAt: 1_700_000_001_000
  };
}

function cardDocument(relPath: string) {
  return {
    relPath,
    kind: 'entity-card' as const,
    sizeBytes: 256,
    mtimeMs: 1_700_000_002_000,
    contentHash: 'b'.repeat(64),
    indexedAt: 1_700_000_003_000
  };
}

function entity(id: string, relPath: string, overrides: Partial<NarrativeEntity> = {}): NarrativeEntity {
  return {
    id,
    type: 'character',
    name: id,
    sourcePath: relPath,
    sourceUri: `file:///workspace/${relPath}`,
    origin: 'explicit',
    aliases: [],
    ...overrides
  };
}

function mention(entityId: string, overrides: Partial<NarrativeMention> = {}): NarrativeMention {
  return {
    entityId,
    kind: 'character',
    raw: `[[character:${entityId}]]`,
    resolved: true,
    evidence: rangeEvidence(CHAPTER, { start: { line: 3, character: 4 }, end: { line: 3, character: 20 } }),
    ...overrides
  };
}

function relation(overrides: Partial<NarrativeRelation> = {}): NarrativeRelation {
  return {
    sourceId: 'krishna',
    targetId: 'arjuna',
    relType: 'ownership',
    origin: 'explicit',
    ownerPath: CARD,
    sourceResolved: true,
    targetResolved: true,
    evidence: [wholeFileEvidence(CARD)],
    ...overrides
  };
}

/** Seed the two documents every other fixture hangs off. */
function seedDocuments(store: NarrativeIndexStore): void {
  store.transaction(writer => {
    writer.putDocument(chapterDocument());
    writer.putDocument(cardDocument(CARD));
    writer.putDocument(cardDocument(OTHER_CARD));
  });
}

/** Add further card documents, for the cases that need more than the three
 *  {@link seedDocuments} provides. Kept separate so that adding a card here
 *  cannot quietly change the document count every other case sees. */
function seedCards(store: NarrativeIndexStore, ...relPaths: readonly string[]): void {
  store.transaction(writer => {
    for (const relPath of relPaths) {
      writer.putDocument(cardDocument(relPath));
    }
  });
}

// --------------------------------------------------------------------------
// Fixtures for manuscript order (gh#47)
// --------------------------------------------------------------------------

const CHAPTER_ONE = 'manuscript/ordered-01.md';
const CHAPTER_TWO = 'manuscript/ordered-02.md';
const CHAPTER_THREE = 'manuscript/ordered-03.md';
/** Named by no manifest entry, so it has no `chapterOrder` at all. */
const UNLISTED_CHAPTER = 'manuscript/ordered-scratch.md';
/**
 * LISTED, WITH AN ORDER, AND STILL OUT OF THE BUILT BOOK — the state an
 * `include: false` manifest entry actually produces.
 *
 * THIS FIXTURE IS THE POINT OF THE gh#47 FIX, so it is worth stating what it
 * used to be. The first edition wrote `manifestIncluded: false` here and left
 * `buildIncluded` out of the port entirely. That combination is one the indexer
 * NEVER WRITES: `manifest-extraction` pushes an `include: false` entry into the
 * walk WITH an `order`, and the session sets `manifestIncluded: chapter !== undefined`,
 * i.e. `true`. So the exclusion rule was dead in the product while this case
 * stayed green — the tooth agreed with the code about a state neither would ever
 * meet. `manifestIncluded` stays `true` here on purpose: anything else would
 * re-create the fiction.
 */
const EXCLUDED_CHAPTER = 'manuscript/ordered-excluded.md';

function orderedChapter(relPath: string, order?: number, options: { listed?: boolean; built?: boolean } = {}) {
  return {
    relPath,
    kind: 'chapter' as const,
    sizeBytes: 512,
    mtimeMs: 1_700_000_004_000,
    contentHash: 'c'.repeat(64),
    ...(order === undefined ? {} : { chapterOrder: order }),
    manifestIncluded: options.listed ?? true,
    buildIncluded: options.built ?? true,
    indexedAt: 1_700_000_005_000
  };
}

function seedOrderedChapters(store: NarrativeIndexStore): void {
  store.transaction(writer => {
    writer.putDocument(orderedChapter(CHAPTER_ONE, 0));
    writer.putDocument(orderedChapter(CHAPTER_TWO, 1));
    writer.putDocument(orderedChapter(CHAPTER_THREE, 2));
    // Unlisted: no order, and `manifestIncluded` false — the ONE case where the
    // two columns agree, because a file the manifest never names is in neither.
    writer.putDocument(orderedChapter(UNLISTED_CHAPTER, undefined, { listed: false, built: false }));
    // Excluded: listed, ordered, out of the build. The columns DISAGREE, which
    // is what makes this case able to fail.
    writer.putDocument(orderedChapter(EXCLUDED_CHAPTER, 3, { listed: true, built: false }));
  });
}

/** Six mentions of one entity, inserted in an order that DISAGREES with the
 *  manuscript — see the note on the ascending case for why that matters. */
function seedOrderingMentions(store: NarrativeIndexStore): void {
  const at = (relPath: string, line: number, raw: string) =>
    mention('krishna', {
      raw,
      evidence: rangeEvidence(relPath, { start: { line, character: 0 }, end: { line, character: 8 } })
    });
  store.transaction(writer => {
    writer.putMention(at(CHAPTER_TWO, 5, 'ch2-line5'));
    // TWO ON ONE LINE, so the THIRD sort key has to decide. Every other fixture
    // here sits at character 0, which left `start_char` unbitten by any case —
    // an adapter that dropped it from its ORDER BY passed the whole suite.
    writer.putMention(
      mention('krishna', {
        raw: 'ch1-line2-col40',
        evidence: rangeEvidence(CHAPTER_ONE, { start: { line: 2, character: 40 }, end: { line: 2, character: 48 } })
      })
    );
    writer.putMention(at(CHAPTER_ONE, 9, 'ch1-line9'));
    writer.putMention(at(CHAPTER_ONE, 2, 'ch1-line2'));
    writer.putMention(mention('krishna', { raw: 'ch3-whole-file', evidence: wholeFileEvidence(CHAPTER_THREE) }));
    writer.putMention(at(UNLISTED_CHAPTER, 1, 'scratch-line1'));
    writer.putMention(at(EXCLUDED_CHAPTER, 1, 'excluded-line1'));
  });
}


// ---------------------------------------------------------------------------
// Fixtures for events (gh#48)
// ---------------------------------------------------------------------------

const TIMELINE = 'knowledge/timeline/main.yaml';

function timelineDocument(relPath: string = TIMELINE) {
  return {
    relPath,
    kind: 'timeline' as NarrativeDocumentKind,
    sizeBytes: 128,
    mtimeMs: 1_700_000_006_000,
    contentHash: 'e'.repeat(64),
    indexedAt: 1_700_000_007_000
  };
}

function event(id: string, overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    id,
    title: id,
    storyTime: { kind: 'unknown' },
    refs: [],
    origin: 'explicit',
    evidence: wholeFileEvidence(TIMELINE),
    sourceRefs: [],
    ...overrides
  };
}

async function open(makeStore: MakeContractStore, options?: { readOnly?: boolean }): Promise<NarrativeIndexStore> {
  const store = await makeStore(options);
  check(store !== undefined, `the harness could not produce a store (options=${JSON.stringify(options ?? {})})`);
  return store;
}

// --------------------------------------------------------------------------
// The contract
// --------------------------------------------------------------------------

export const NARRATIVE_INDEX_STORE_CONTRACT: readonly NarrativeIndexStoreContractCase[] = [
  {
    name: 'a fresh store is empty, writable, and at generation 0',
    async run(makeStore) {
      const store = await open(makeStore);
      const lifecycle = store.lifecycle();
      equal(lifecycle.generation, 0, 'fresh generation');
      equal(lifecycle.readOnly, false, 'fresh readOnly');
      equal(lifecycle.corrupted, false, 'fresh corrupted');
      equal(lifecycle.foreignWriter, false, 'fresh foreignWriter');
      equal(store.listDocuments().length, 0, 'fresh document count');
      equal(store.findEntities().length, 0, 'fresh entity count');
      equal(store.getEntity('krishna'), undefined, 'fresh getEntity');
      equal(store.getMentions().length, 0, 'fresh mention count');
      equal(store.getRelations().length, 0, 'fresh relation count');
      equal(store.getDuplicateEntities().length, 0, 'fresh duplicate count');
    }
  },
  {
    name: 'a document round-trips field for field, and re-writing it keeps its id',
    async run(makeStore) {
      const store = await open(makeStore);
      const input = chapterDocument();
      const docId = store.transaction(writer => writer.putDocument(input));
      const stored = store.getDocument(CHAPTER);
      check(stored !== undefined, 'document was not stored');
      equal(stored.docId, docId, 'docId');
      equal(stored.relPath, input.relPath, 'relPath');
      equal(stored.kind, input.kind, 'kind');
      equal(stored.sizeBytes, input.sizeBytes, 'sizeBytes');
      equal(stored.mtimeMs, input.mtimeMs, 'mtimeMs');
      equal(stored.contentHash, input.contentHash, 'contentHash');
      equal(stored.chapterOrder, input.chapterOrder, 'chapterOrder');
      equal(stored.title, input.title, 'title');
      equal(stored.indexedAt, input.indexedAt, 'indexedAt');
      equal(stored.manifestIncluded, true, 'manifestIncluded defaults to true');

      const secondId = store.transaction(writer =>
        writer.putDocument({ ...input, sizeBytes: 2048, contentHash: 'c'.repeat(64) })
      );
      equal(secondId, docId, 'docId is stable across a re-write of the same path');
      equal(store.getDocument(CHAPTER)?.sizeBytes, 2048, 'sizeBytes after re-write');
      equal(store.listDocuments().length, 1, 'a re-write does not create a second row');
    }
  },
  {
    name: 'a file the manifest does not list is stored with manifestIncluded false and no order',
    async run(makeStore) {
      const store = await open(makeStore);
      store.transaction(writer =>
        writer.putDocument({
          relPath: 'manuscript/scratch.md',
          kind: 'chapter',
          sizeBytes: 10,
          mtimeMs: 1,
          contentHash: 'd'.repeat(64),
          manifestIncluded: false,
          indexedAt: 2
        })
      );
      const stored = store.getDocument('manuscript/scratch.md');
      check(stored !== undefined, 'document was not stored');
      equal(stored.manifestIncluded, false, 'manifestIncluded');
      equal(stored.chapterOrder, undefined, 'chapterOrder of an unlisted file');
      equal(stored.title, undefined, 'title of an unlisted file');
    }
  },
  {
    // tech_spec ОВ-1, tooth A14 (schema v3, UR-031).
    //
    // ABSENT AND EMPTY ARE DIFFERENT CLAIMS: "the manifest does not name this
    // file" against "the manifest names it with an empty title". A reader that
    // renders a heading has to tell them apart, so no adapter may fold one into
    // the other — which is exactly what `title ?? ''` or a truthiness test on
    // the column would do, invisibly, on the commonest path.
    name: 'document.title: an empty title is KEPT and an absent one stays absent',
    async run(makeStore) {
      const store = await open(makeStore);
      const base = chapterDocument();
      store.transaction(writer => {
        writer.putDocument({ ...base, relPath: 'manuscript/empty-title.md', title: '' });
        const { title: _dropped, ...withoutTitle } = base;
        writer.putDocument({ ...withoutTitle, relPath: 'manuscript/no-title.md' });
      });
      equal(store.getDocument('manuscript/empty-title.md')?.title, '', 'an empty title is a value');
      equal(store.getDocument('manuscript/no-title.md')?.title, undefined, 'an absent title is absent');
      // And it survives the LIST read as well as the point read: the two go
      // through different queries in the SQLite adapter.
      const listed = store.listDocuments();
      equal(
        listed.find(document => document.relPath === 'manuscript/empty-title.md')?.title,
        '',
        'empty title through listDocuments'
      );
      equal(
        listed.find(document => document.relPath === 'manuscript/no-title.md')?.title,
        undefined,
        'absent title through listDocuments'
      );
    }
  },
  {
    name: 'each committed transaction advances the generation by exactly one',
    async run(makeStore) {
      const store = await open(makeStore);
      equal(store.lifecycle().generation, 0, 'before');
      store.transaction(writer => writer.putDocument(chapterDocument()));
      equal(store.lifecycle().generation, 1, 'after one transaction');
      store.transaction(writer => writer.putDocument(cardDocument(CARD)));
      equal(store.lifecycle().generation, 2, 'after two transactions');
    }
  },
  {
    name: 'a throwing transaction body commits nothing and does not advance the generation',
    async run(makeStore) {
      const store = await open(makeStore);
      store.transaction(writer => writer.putDocument(chapterDocument()));
      const before = store.lifecycle().generation;
      await rejectsSomehow(
        () =>
          store.transaction(writer => {
            writer.putDocument(cardDocument(CARD));
            throw new Error('deliberate failure inside the transaction');
          }),
        'a throwing transaction'
      );
      equal(store.getDocument(CARD), undefined, 'the half-written document');
      equal(store.lifecycle().generation, before, 'generation after a rolled-back transaction');
      equal(store.listDocuments().length, 1, 'document count after a rolled-back transaction');
    }
  },
  {
    name: 'document.generation is per document: re-indexing one leaves its neighbours untouched',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      const neighbourBefore = store.getDocument(CARD)?.generation;
      check(neighbourBefore !== undefined, 'neighbour was not stored');

      store.transaction(writer => writer.putDocument({ ...chapterDocument(), contentHash: 'e'.repeat(64) }));

      const touched = store.getDocument(CHAPTER)?.generation;
      const neighbourAfter = store.getDocument(CARD)?.generation;
      check(touched !== undefined && neighbourAfter !== undefined, 'documents disappeared');
      equal(neighbourAfter, neighbourBefore, 'the untouched neighbour generation');
      check(
        touched > neighbourBefore,
        `the re-indexed document should carry a newer generation (${touched} vs ${neighbourBefore})`
      );
    }
  },
  {
    name: 'an entity round-trips with every optional field, and its aliases survive',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      const full = entity('krishna', CARD, {
        name: 'Кришна',
        aliases: ['Govinda', 'Keshava'],
        epithets: ['Yadava'],
        summary: 'a summary',
        backstory: 'a backstory',
        arc: 'an arc',
        speechPatterns: ['calm'],
        notes: 'notes',
        evidence: wholeFileEvidence(CARD)
      });
      store.transaction(writer => writer.putEntity(full));
      deepEqual(store.getEntity('krishna'), full, 'entity round-trip');
    }
  },
  {
    name: 'findEntities filters by type, origin and a case-insensitive prefix over name and aliases',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD, { name: 'Кришна', aliases: ['Govinda'] }));
        writer.putEntity(entity('arjuna', OTHER_CARD, { name: 'Арджуна' }));
        writer.putEntity(entity('dharma', OTHER_CARD, { type: 'term', name: 'Dharma', origin: 'ai-candidate' }));
      });
      equal(store.findEntities({ type: 'character' }).length, 2, 'by type');
      equal(store.findEntities({ origin: 'ai-candidate' }).length, 1, 'by origin');
      equal(store.findEntities({ namePrefix: 'дхарм' }).length, 0, 'a prefix that matches nothing');
      equal(store.findEntities({ namePrefix: 'dhar' })[0]?.id, 'dharma', 'by name prefix, lowercased');
      equal(store.findEntities({ namePrefix: 'DHAR' })[0]?.id, 'dharma', 'by name prefix, uppercased');
      equal(store.findEntities({ namePrefix: 'govi' })[0]?.id, 'krishna', 'by ALIAS prefix');
      equal(store.findEntities({ limit: 2 }).length, 2, 'limit');
    }
  },
  {
    name: 'the name prefix folds case for CYRILLIC too, not only for ASCII',
    async run(makeStore) {
      // THE POINT OF THIS CASE. SQLite's `lower()`, its `LIKE` folding and its
      // `NOCASE` collation are all ASCII-ONLY: `lower('КРИШНА')` is `КРИШНА`.
      // An adapter that folds in SQL is therefore case-SENSITIVE for exactly
      // the alphabet this product is written in, while the in-memory adapter,
      // folding with `toLowerCase`, is not. Without this case the two adapters
      // could disagree on the product's primary language and the contract would
      // stay green — the drift the contract core exists to prevent.
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD, { name: 'Кришна', aliases: ['Говинда'] }));
      });
      equal(store.findEntities({ namePrefix: 'Кри' })[0]?.id, 'krishna', 'Cyrillic prefix, as written');
      equal(store.findEntities({ namePrefix: 'кри' })[0]?.id, 'krishna', 'Cyrillic prefix, lowercased');
      equal(store.findEntities({ namePrefix: 'КРИ' })[0]?.id, 'krishna', 'Cyrillic prefix, uppercased');
      equal(store.findEntities({ namePrefix: 'ГОВИ' })[0]?.id, 'krishna', 'Cyrillic ALIAS prefix, uppercased');
      equal(store.findEntities({ namePrefix: 'арджун' }).length, 0, 'a Cyrillic prefix that matches nothing');
    }
  },
  {
    name: 'a duplicated entity id names the definition IN EFFECT, not only the cards that collide',
    async run(makeStore) {
      // THE POINT OF THIS CASE. The store used to answer a collision with a
      // flat list of paths, which said "these files collide" and stopped —
      // while the extraction that produced the collision knew perfectly well
      // which card had won and threw the answer away at this boundary. The
      // assertion is a whole-record comparison ON PURPOSE: an adapter that
      // dropped the winner, or that swapped it with a loser, would still pass
      // an `includes` check on the excluded list.
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD));
        writer.putDuplicateEntity('krishna', OTHER_CARD);
      });
      deepEqual(
        store.getDuplicateEntities(),
        [{ entityId: 'krishna', keptRelPath: CARD, excludedRelPaths: [OTHER_CARD] }],
        'the collision record'
      );
      // And the winner is the card the INDEX actually holds — a `keptRelPath`
      // that disagreed with the entity row would be a diagnostic pointing the
      // author at the wrong file.
      equal(store.getEntity('krishna')?.sourcePath, CARD, 'the entity the index holds');
    }
  },
  {
    name: 'three cards claiming one id fold into ONE finding: one winner, two losers, in code-point order',
    async run(makeStore) {
      // Two things at once, and both of them are drift the suite exists to
      // catch. FIRST, aggregation: extraction reports one finding PER LOSING
      // CARD, storage reports one PER ID, and a third colliding card is where
      // an adapter that kept only the last loser — or only the first — would
      // show it. SECOND, order: these two paths sort one way by code point and
      // the other way under a Russian locale, so an adapter sorting with
      // `localeCompare` disagrees with SQLite here and nowhere else.
      const store = await open(makeStore);
      seedDocuments(store);
      seedCards(store, CYRILLIC_CARD_UPPER, CYRILLIC_CARD_LOWER);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD));
        // Written in the order that is NOT the expected one, so a store simply
        // echoing insertion order cannot pass by luck.
        writer.putDuplicateEntity('krishna', CYRILLIC_CARD_LOWER);
        writer.putDuplicateEntity('krishna', CYRILLIC_CARD_UPPER);
      });
      deepEqual(
        store.getDuplicateEntities(),
        [
          {
            entityId: 'krishna',
            keptRelPath: CARD,
            excludedRelPaths: [CYRILLIC_CARD_UPPER, CYRILLIC_CARD_LOWER]
          }
        ],
        'the three-way collision record'
      );
    }
  },
  {
    name: 'several ids colliding at once come back one record each, ordered by id',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      seedCards(store, CYRILLIC_CARD_UPPER);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD));
        writer.putEntity(entity('arjuna', OTHER_CARD));
        writer.putDuplicateEntity('krishna', CYRILLIC_CARD_UPPER);
        writer.putDuplicateEntity('arjuna', CYRILLIC_CARD_UPPER);
      });
      deepEqual(
        store.getDuplicateEntities(),
        [
          { entityId: 'arjuna', keptRelPath: OTHER_CARD, excludedRelPaths: [CYRILLIC_CARD_UPPER] },
          { entityId: 'krishna', keptRelPath: CARD, excludedRelPaths: [CYRILLIC_CARD_UPPER] }
        ],
        'two collisions, each with its own winner'
      );
    }
  },
  {
    name: 'a collision with no winner cannot be written, and neither can a card excluded from its own id',
    async run(makeStore) {
      // These two refusals are what make `keptRelPath` a REQUIRED field instead
      // of an optional one every reader would have to defend against. The first
      // says a duplicate cannot exist before the definition it lost to; the
      // second says one card cannot be both sides of one collision.
      const store = await open(makeStore);
      seedDocuments(store);
      await rejectsSomehow(
        () => store.transaction(writer => writer.putDuplicateEntity('krishna', OTHER_CARD)),
        'a duplicate of an id no card defines'
      );
      equal(store.getDuplicateEntities().length, 0, 'nothing was written by the refused call');

      store.transaction(writer => writer.putEntity(entity('krishna', CARD)));
      await rejectsSomehow(
        () => store.transaction(writer => writer.putDuplicateEntity('krishna', CARD)),
        'the kept card excluded from its own id'
      );
      deepEqual(store.getDuplicateEntities(), [], 'the store after both refusals');
    }
  },
  {
    name: 'the winner cannot be moved onto a card already excluded from the same id',
    async run(makeStore) {
      // The same invariant approached from the other side. Without this the
      // entity upsert is a back door: re-point the entity row at a losing card
      // and the record starts naming one path as both the definition in effect
      // and a definition excluded.
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD));
        writer.putDuplicateEntity('krishna', OTHER_CARD);
      });
      await rejectsSomehow(
        () => store.transaction(writer => writer.putEntity(entity('krishna', OTHER_CARD))),
        'moving the entity onto an excluded card'
      );
      deepEqual(
        store.getDuplicateEntities(),
        [{ entityId: 'krishna', keptRelPath: CARD, excludedRelPaths: [OTHER_CARD] }],
        'the record after the refused move'
      );
    }
  },
  {
    name: 'a collision does not outlive its winner: deleting the kept card ends it entirely',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      seedCards(store, CYRILLIC_CARD_UPPER);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD));
        writer.putDuplicateEntity('krishna', OTHER_CARD);
        writer.putDuplicateEntity('krishna', CYRILLIC_CARD_UPPER);
      });
      // Losing ONE loser narrows the finding; the winner is unaffected.
      store.transaction(writer => writer.deleteDocument(OTHER_CARD));
      deepEqual(
        store.getDuplicateEntities(),
        [{ entityId: 'krishna', keptRelPath: CARD, excludedRelPaths: [CYRILLIC_CARD_UPPER] }],
        'the record after one excluded card was deleted'
      );
      // Losing the WINNER ends the collision instead of leaving a finding whose
      // winner is gone. The remaining card is no longer a duplicate of
      // anything — it is whatever the next index pass says it is.
      store.transaction(writer => writer.deleteDocument(CARD));
      equal(store.getEntity('krishna'), undefined, 'the entity after its card was deleted');
      deepEqual(store.getDuplicateEntities(), [], 'the collision after its winner was deleted');
    }
  },
  {
    name: 'a mention with a range round-trips, and a mention WITHOUT a kind stays without one',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      const ranged = mention('krishna');
      const bare: NarrativeMention = {
        entityId: 'arjuna',
        raw: '[[arjuna]]',
        resolved: true,
        evidence: rangeEvidence(CHAPTER, { start: { line: 9, character: 0 }, end: { line: 9, character: 10 } })
      };
      store.transaction(writer => {
        writer.putMention(ranged);
        writer.putMention(bare);
      });
      deepEqual(store.getMentions({ entityId: 'krishna' }), [ranged], 'the kinded mention');
      const stored = store.getMentions({ entityId: 'arjuna' })[0];
      check(stored !== undefined, 'the bare mention was dropped');
      equal(stored.kind, undefined, 'kind of the bare form');
      equal(stored.label, undefined, 'label of the bare form');
      equal('kind' in stored, false, 'the bare form must not gain an invented kind key');
    }
  },
  {
    name: 'a whole-file mention round-trips with no range at all',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      const frontMatter = mention('krishna', { evidence: wholeFileEvidence(CHAPTER), raw: 'krishna' });
      store.transaction(writer => writer.putMention(frontMatter));
      const stored = store.getMentions({ entityId: 'krishna' })[0];
      check(stored !== undefined, 'the whole-file mention was dropped');
      equal(stored.evidence.evidenceKind, 'whole-file', 'evidenceKind');
      equal(stored.evidence.range, undefined, 'range');
      equal(stored.labelRange, undefined, 'labelRange');
    }
  },
  {
    name: 'a mention whose evidenceKind disagrees with its coordinates is REJECTED, not repaired',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      // Both shapes are unconstructible in TypeScript — the discriminated union
      // makes them so, which is half the protection. The cast is what lets the
      // OTHER half, the one that survives a `JSON.parse` or a repair script, be
      // exercised at all.
      const claimsRangeHasNone = {
        ...mention('krishna'),
        evidence: { path: CHAPTER, evidenceKind: 'range' }
      } as unknown as NarrativeMention;
      const claimsWholeFileHasRange = {
        ...mention('krishna'),
        evidence: {
          path: CHAPTER,
          evidenceKind: 'whole-file',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
        }
      } as unknown as NarrativeMention;

      await rejectsSomehow(
        () => store.transaction(writer => writer.putMention(claimsRangeHasNone)),
        "a mention claiming 'range' with no coordinates"
      );
      await rejectsSomehow(
        () => store.transaction(writer => writer.putMention(claimsWholeFileHasRange)),
        "a mention claiming 'whole-file' while carrying coordinates"
      );
      equal(store.getMentions().length, 0, 'nothing was written by the rejected calls');
    }
  },
  {
    name: 'a label range on a whole-file mention is REJECTED',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      const labelled = {
        ...mention('krishna'),
        evidence: wholeFileEvidence(CHAPTER),
        labelRange: { start: { line: 1, character: 1 }, end: { line: 1, character: 5 } }
      } as unknown as NarrativeMention;
      await rejectsSomehow(
        () => store.transaction(writer => writer.putMention(labelled)),
        'a label range on a whole-file mention'
      );
    }
  },
  {
    name: 'a broken mention is STORED, and findable as broken',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putMention(mention('krishna'));
        writer.putMention(mention('nobody', { resolved: false }));
      });
      equal(store.getMentions().length, 2, 'the broken mention was kept');
      const broken = store.getMentions({ brokenOnly: true });
      equal(broken.length, 1, 'broken mention count');
      equal(broken[0].entityId, 'nobody', 'the broken one');
    }
  },
  {
    // gh#47 — manuscript order, ASCENDING.
    //
    // THE FIXTURE IS BUILT OUT OF ORDER ON PURPOSE. Mentions are inserted
    // ch-02, then ch-01 line 9, then ch-01 line 2, so insertion order and
    // manuscript order DISAGREE about every pair. An adapter that ignores
    // `orderBy` and returns rows as inserted cannot pass by coincidence.
    name: 'orderBy chapter ascending: mentions read in manuscript order, across chapters and within one',
    async run(makeStore) {
      const store = await open(makeStore);
      seedOrderedChapters(store);
      seedOrderingMentions(store);
      const ordered = store.getMentions({ entityId: 'krishna', orderBy: 'chapter', direction: 'asc' });
      deepEqual(
        ordered.slice(0, 4).map(m => m.raw),
        ['ch1-line2', 'ch1-line2-col40', 'ch1-line9', 'ch2-line5'],
        'ascending manuscript order, and column decides within a line'
      );
    }
  },
  {
    // gh#47 — DESCENDING, which is not decoration: "latest appearance" and the
    // recent-mentions list are unobtainable without it except by transferring
    // every mention an entity has.
    name: 'orderBy chapter descending: the placeable mentions come back reversed',
    async run(makeStore) {
      const store = await open(makeStore);
      seedOrderedChapters(store);
      seedOrderingMentions(store);
      const ordered = store.getMentions({ entityId: 'krishna', orderBy: 'chapter', direction: 'desc' });
      deepEqual(
        ordered.slice(0, 4).map(m => m.raw),
        ['ch2-line5', 'ch1-line9', 'ch1-line2-col40', 'ch1-line2'],
        'descending manuscript order, column included'
      );
    }
  },
  {
    // gh#47 — the case the whole `MentionOrderExclusion` doc exists for, all
    // three reasons on ONE tree.
    //
    // WHAT WOULD FAIL WITHOUT IT: a NULL `chapter_order` sorts FIRST in SQLite
    // by default, so a mention in a file the manifest never names would be
    // reported as the character's first appearance — a confident, wrong answer
    // to the question this panel exists to answer.
    //
    // AND THE DESCENDING HALF IS NOT THE SAME ASSERTION TWICE: the tempting
    // implementation reverses the exclusion flag along with everything else,
    // which merely moves the lie to the other end — an unplaceable mention
    // becomes the LATEST appearance instead of the first.
    name: 'unplaceable mentions trail the ordered ones in BOTH directions',
    async run(makeStore) {
      const store = await open(makeStore);
      seedOrderedChapters(store);
      seedOrderingMentions(store);
      const unplaceable = ['ch3-whole-file', 'scratch-line1', 'excluded-line1'];
      for (const direction of ['asc', 'desc'] as const) {
        const ordered = store.getMentions({ entityId: 'krishna', orderBy: 'chapter', direction });
        equal(ordered.length, 7, `every mention is still returned (${direction})`);
        deepEqual(
          ordered.slice(4).map(m => m.raw),
          unplaceable,
          `unplaceable mentions trail, in insertion order (${direction})`
        );
      }
    }
  },
  {
    // gh#47 — `limit` AFTER ordering (the ISS-349 rule), and the two queries the
    // card actually issues.
    name: 'limit selects the first rows of the chosen order, not the first rows found',
    async run(makeStore) {
      const store = await open(makeStore);
      seedOrderedChapters(store);
      seedOrderingMentions(store);
      const first = store.getMentions({ entityId: 'krishna', orderBy: 'chapter', direction: 'asc', limit: 1 });
      deepEqual(first.map(m => m.raw), ['ch1-line2'], 'first appearance');
      const latest = store.getMentions({ entityId: 'krishna', orderBy: 'chapter', direction: 'desc', limit: 2 });
      deepEqual(latest.map(m => m.raw), ['ch2-line5', 'ch1-line9'], 'the two most recent');
    }
  },
  {
    // gh#47 — THE REJECTING CASE, and it guards two different mistakes.
    //
    // (1) `orderBy` must be OPT-IN. Every caller written before it relies on
    // insertion order, and an adapter that started sorting unconditionally
    // would rewrite results nothing in this suite otherwise looks at.
    //
    // (2) The order must come from the MANIFEST, not from the mentions. Moving
    // ch-02 ahead of ch-01 changes nothing about any mention row — so an
    // implementation that sorted by anything carried on the mention itself
    // (its id, its line, its insertion index) returns the old answer here and
    // is caught.
    name: 'ordering is opt-in, and it follows the manifest rather than the mention rows',
    async run(makeStore) {
      const store = await open(makeStore);
      seedOrderedChapters(store);
      seedOrderingMentions(store);
      deepEqual(
        store.getMentions({ entityId: 'krishna' }).map(m => m.raw),
        [
          'ch2-line5',
          'ch1-line2-col40',
          'ch1-line9',
          'ch1-line2',
          'ch3-whole-file',
          'scratch-line1',
          'excluded-line1'
        ],
        'without orderBy the result is insertion order'
      );
      // Renumber the manifest: ch-02 now comes first. Only DOCUMENT rows change.
      store.transaction(writer => {
        writer.putDocument({ ...orderedChapter(CHAPTER_ONE, 1) });
        writer.putDocument({ ...orderedChapter(CHAPTER_TWO, 0) });
      });
      deepEqual(
        store.getMentions({ entityId: 'krishna', orderBy: 'chapter', direction: 'asc' }).slice(0, 4).map(m => m.raw),
        ['ch2-line5', 'ch1-line2', 'ch1-line2-col40', 'ch1-line9'],
        'renumbering the manifest reorders the answer'
      );
    }
  },
  {
    // gh#47 — A LIMIT THE TWO ADAPTERS WOULD ANSWER DIFFERENTLY IS REJECTED.
    //
    // Both values below are reachable from a preference, and both used to
    // DIVERGE rather than fail: `-1` means "no limit" to SQLite's `LIMIT ?` and
    // "drop the last row" to `slice`, while `1.5` made SQLite throw a raw
    // `datatype mismatch` carrying none of this port's error kinds and made the
    // in-memory adapter return one row. Divergence is the failure here — the
    // wrong answer would have been "clamp them into agreement", which invents an
    // answer to a question nobody asked.
    name: 'a negative or fractional limit is REJECTED by both adapters, not answered differently',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD));
        writer.putMention(mention('krishna'));
      });
      await rejects(() => store.getMentions({ limit: -1 }), 'constraint-violation', 'a negative mention limit');
      await rejects(() => store.getMentions({ limit: 1.5 }), 'constraint-violation', 'a fractional mention limit');
      await rejects(() => store.findEntities({ limit: -1 }), 'constraint-violation', 'a negative entity limit');
      await rejects(() => store.findEntities({ limit: 1.5 }), 'constraint-violation', 'a fractional entity limit');
      // THE PAIRED POSITIVE, and it carries the real risk: a validator written
      // as `limit > 0` would reject zero, which is a legitimate answer a caller
      // can compute from a preference and which both adapters already handle.
      equal(store.getMentions({ limit: 0 }).length, 0, 'limit 0 is a real answer, not an error');
      equal(store.findEntities({ limit: 0 }).length, 0, 'limit 0 is a real answer for entities too');
      equal(store.getMentions({ limit: 1 }).length, 1, 'a valid limit still works');
    }
  },
  {
    // gh#47 — "which chapters is this character in, and how many".
    //
    // THE COUNTS AND THE ROW QUERY MUST AGREE, so the case checks them against
    // each other rather than against two hand-written expectations: a filter
    // that narrows one has to narrow the other identically, which is the whole
    // reason both are built from one `mentionFilter`.
    name: 'countMentionsByDocument groups the same filter, in ascending manuscript order',
    async run(makeStore) {
      const store = await open(makeStore);
      seedOrderedChapters(store);
      seedOrderingMentions(store);
      const counts = store.countMentionsByDocument({ entityId: 'krishna' });
      deepEqual(
        counts.map(row => `${row.relPath}:${row.mentionCount}`),
        [
          `${CHAPTER_ONE}:3`,
          `${CHAPTER_TWO}:1`,
          `${CHAPTER_THREE}:1`,
          `${EXCLUDED_CHAPTER}:1`,
          `${UNLISTED_CHAPTER}:1`
        ],
        'chapters in build order, then the unplaceable ones by path'
      );
      // The trailing group carries its REASON, not merely its position — the two
      // documents below are excluded for different reasons and a consumer that
      // renders "not in the built book" must not say it about an unlisted file.
      const byPath = new Map(counts.map(row => [row.relPath, row]));
      equal(byPath.get(CHAPTER_ONE)?.orderExclusion, undefined, 'an ordinary chapter is placeable');
      equal(byPath.get(EXCLUDED_CHAPTER)?.orderExclusion, 'not-in-built-book', 'listed, ordered, out of the build');
      equal(byPath.get(UNLISTED_CHAPTER)?.orderExclusion, 'no-chapter-order', 'the manifest never names it');
      // Totals agree with the row query — the aggregate is a different SHAPE of
      // the same answer, not a second answer.
      equal(
        counts.reduce((sum, row) => sum + row.mentionCount, 0),
        store.getMentions({ entityId: 'krishna' }).length,
        'the counts sum to the mentions'
      );
      equal(store.countMentionsByDocument({ entityId: 'nobody' }).length, 0, 'no mentions, no rows');
      // gh#47 F-47-18. The port PROMISES that `orderBy`/`direction`/`limit` are
      // ignored here — they describe an order over mentions, and this is a
      // different list. A promise in a doc comment binds nobody: an adapter that
      // honoured `limit` would truncate the spread, and every caller today
      // passes only `entityId`, so nothing would notice.
      deepEqual(
        store.countMentionsByDocument({ entityId: 'krishna', orderBy: 'chapter', direction: 'desc', limit: 1 }),
        counts,
        'ordering and capping a mention query do not reshape the per-document aggregate'
      );
    }
  },
  {
    // gh#48 WP-2. Story order is `sequence`; events without one TRAIL in both
    // directions. Same rule and same reason as unplaceable mentions: mirroring
    // the exclusion with the direction would make an unplaced event the "last
    // thing that happened" as readily as the first.
    name: 'events order by sequence, and the unsequenced trail in BOTH directions',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putEvent(event('e-late', { sequence: 300 }), TIMELINE);
        writer.putEvent(event('e-early', { sequence: 100 }), TIMELINE);
        writer.putEvent(event('e-unplaced'), TIMELINE);
      });
      const asc = store.listEvents({ orderBy: 'story', direction: 'asc' });
      deepEqual(asc.map(row => row.event.id), ['e-early', 'e-late', 'e-unplaced'], 'ascending story order');
      const desc = store.listEvents({ orderBy: 'story', direction: 'desc' });
      deepEqual(desc.map(row => row.event.id), ['e-late', 'e-early', 'e-unplaced'], 'the unplaced one still trails');
      equal(asc[2].orderExclusion, 'no-sequence', 'and it carries WHY');
      equal(asc[0].orderExclusion, undefined, 'a sequenced event is placeable');
    }
  },
  {
    /**
     * A CHAPTER INDEXED **AFTER** THE EVENT THAT NAMES IT (gh#48 WP-3 re-gate).
     *
     * EVERY OTHER EVENT CASE WRITES THE CHAPTER FIRST, and that shared order is
     * exactly what hid this: an adapter resolving the chapter ONCE, at write
     * time, is indistinguishable from one resolving it at read time as long as
     * the chapter is always already there. It is not always already there. The
     * ordinary sequence is the one this package's own pipeline tooth calls "a
     * fixable authoring mistake": the manifest lists a chapter, the author
     * writes the event first, and creates `content/ch-NN.md` afterwards. That
     * creation is a CHAPTER change, so it is applied INCREMENTALLY — no rebuild
     * re-writes the event — and an adapter holding a write-time snapshot answers
     * `chapter-not-indexed` forever, about a chapter its own `listDocuments`
     * reports as indexed.
     *
     * THE CASE IS WRITTEN AS TWO SEPARATE TRANSACTIONS on purpose. One
     * transaction would let an adapter resolve at commit and still pass, which
     * is not the claim: the claim is that a document written LATER, by an
     * unrelated pass, places the event.
     *
     * This is also an ISS-349 case (§5.3): the two adapters returned different
     * ROWS in different ORDERS for the identical sequence of port calls, and no
     * reader would have seen it, because `bun` can only run the in-memory one.
     */
    name: 'a chapter indexed AFTER the event places it — resolution is live, not a write-time snapshot',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      const LATE_CHAPTER = 'manuscript/ordered-late.md';
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putDocument(orderedChapter(CHAPTER_ONE, 0));
        writer.putEvent(event('e-here', { sequence: 100, chapterPath: CHAPTER_ONE }), TIMELINE);
        // Its chapter does not exist yet — the honest answer at THIS moment.
        writer.putEvent(event('e-later', { sequence: 200, chapterPath: LATE_CHAPTER }), TIMELINE);
      });
      equal(
        store.listEvents({ orderBy: 'manuscript', direction: 'asc' }).find(row => row.event.id === 'e-later')
          ?.orderExclusion,
        'chapter-not-indexed',
        'before its chapter exists, the event is honestly unplaceable'
      );

      // The author creates the file. A SEPARATE pass, exactly as the increment
      // applies it.
      store.transaction(writer => {
        writer.putDocument(orderedChapter(LATE_CHAPTER, 1));
      });

      const after = store.listEvents({ orderBy: 'manuscript', direction: 'asc' });
      deepEqual(
        after.map(row => row.event.id),
        ['e-here', 'e-later'],
        'once its chapter is indexed the event takes its place in manuscript order'
      );
      equal(after[1].orderExclusion, undefined, 'and it is no longer excluded');
      // PAIRED NEGATIVE, so "always placeable" cannot pass: an event naming a
      // chapter nobody ever creates stays excluded, and says the same why.
      store.transaction(writer => {
        writer.putEvent(event('e-ghost', { sequence: 300, chapterPath: 'manuscript/never.md' }), TIMELINE);
      });
      equal(
        store.listEvents({ orderBy: 'manuscript', direction: 'asc' }).find(row => row.event.id === 'e-ghost')
          ?.orderExclusion,
        'chapter-not-indexed',
        'a chapter that is never created keeps the event excluded'
      );
      // And the SAME liveness in the other direction: deleting the chapter puts
      // the event back into the trailing group rather than leaving it placed
      // against a document that is gone.
      store.transaction(writer => {
        writer.deleteDocument(LATE_CHAPTER);
      });
      equal(
        store.listEvents({ orderBy: 'manuscript', direction: 'asc' }).find(row => row.event.id === 'e-later')
          ?.orderExclusion,
        'chapter-not-indexed',
        'a deleted chapter excludes its events again'
      );
      // The author's stated path SURVIVES all of it — it is what a diagnostic
      // quotes, and losing it would make the two exclusions indistinguishable.
      equal(store.getEvent('e-later')?.event.chapterPath, LATE_CHAPTER, 'the named path is never dropped');
    }
  },
  {
    /**
     * AN EVENT CANNOT OUTLIVE THE FILE IT WAS READ FROM (gh#48 WP-3 re-gate).
     *
     * TWO HALVES OF ONE OWNERSHIP RULE, and neither adapter had a case for
     * either: SQLite spells it `event.doc_id NOT NULL REFERENCES document(...)
     * ON DELETE CASCADE`, the in-memory adapter has to spell it by hand, and
     * they had drifted in BOTH directions at once — in-memory accepted an event
     * with no source document where SQLite refused, and kept the events of a
     * deleted document where SQLite dropped them.
     *
     * IT IS NOT AN ACADEMIC DIFFERENCE. An event whose timeline file is gone is
     * an event nobody can navigate to, and "every event can navigate to at least
     * one evidence range" is an acceptance criterion of gh#48. The rule was
     * enforced in the adapter nothing writes to in production and absent from
     * the one every author uses — the exact shape of a guard that looks present.
     */
    name: 'an event needs its timeline document, and dies with it, in both adapters',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      // REFUSED, and refused as a NAMED constraint violation rather than as a
      // raw adapter error — the taxonomy is what lets a caller tell "the author
      // wrote something impossible" from "the database is broken".
      await rejects(
        () =>
          store.transaction(writer => {
            writer.putEvent(event('e-homeless'), 'knowledge/timeline/never-indexed.yaml');
          }),
        'constraint-violation',
        'an event whose timeline file is not indexed'
      );

      // PAIRED POSITIVE: with the document present the identical write lands.
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putEvent(event('e-kept', { sequence: 1 }), TIMELINE);
      });
      deepEqual(
        store.listEvents({ orderBy: 'story', direction: 'asc' }).map(row => row.event.id),
        ['e-kept'],
        'the same write against an indexed document succeeds'
      );

      // AND THE OTHER HALF: dropping the file drops its events.
      store.transaction(writer => {
        writer.deleteDocument(TIMELINE);
      });
      deepEqual(
        store.listEvents({ orderBy: 'story', direction: 'asc' }).map(row => row.event.id),
        [],
        'deleting the timeline file takes its events with it'
      );
      equal(store.getEvent('e-kept'), undefined, 'and the by-id read agrees with the list');
    }
  },
  {
    /**
     * `chapterPath` FILTERS ON WHAT THE AUTHOR WROTE, not on what resolved.
     *
     * The same liveness question from the other side: asking for one chapter's
     * events must return an event whose chapter is not indexed yet, because the
     * author DID assign it there. An adapter filtering through a resolved join
     * silently drops exactly the events a "what have I put in this chapter"
     * view most needs to show.
     */
    name: 'the chapterPath filter matches the stated chapter, indexed or not',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      const ABSENT = 'manuscript/not-written-yet.md';
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putDocument(orderedChapter(CHAPTER_ONE, 0));
        writer.putEvent(event('e-indexed', { sequence: 1, chapterPath: CHAPTER_ONE }), TIMELINE);
        writer.putEvent(event('e-absent', { sequence: 2, chapterPath: ABSENT }), TIMELINE);
      });
      deepEqual(
        store.listEvents({ orderBy: 'story', direction: 'asc', chapterPath: ABSENT }).map(row => row.event.id),
        ['e-absent'],
        'an unindexed chapter still answers for its events'
      );
      // PAIRED POSITIVE: the indexed chapter answers for its own and ONLY its
      // own, so "return everything" cannot pass the line above.
      deepEqual(
        store.listEvents({ orderBy: 'story', direction: 'asc', chapterPath: CHAPTER_ONE }).map(row => row.event.id),
        ['e-indexed'],
        'and an indexed chapter answers for exactly its own'
      );
    }
  },
  {
    // THE TIE-BREAK IS THE ID, NOT INSERTION ORDER, and that is what makes
    // "stable after restart" assertable: an author numbering in tens and then
    // writing two things "at the same time" is ordinary, and insertion order
    // does not survive a rebuild.
    name: 'events sharing a sequence are ordered by id, in both adapters',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putEvent(event('e-b', { sequence: 100 }), TIMELINE);
        writer.putEvent(event('e-a', { sequence: 100 }), TIMELINE);
      });
      deepEqual(store.listEvents({ orderBy: 'story' }).map(row => row.event.id), ['e-a', 'e-b'], 'id breaks the tie');
    }
  },
  {
    // gh#48. MANUSCRIPT order is a different question from story order, and an
    // event can be placeable in one and not the other — a flashback has a low
    // sequence and a late chapter. The exclusion reason is per ORDER for exactly
    // this reason.
    name: 'manuscript order follows the chapter, and its exclusions are its own',
    async run(makeStore) {
      const store = await open(makeStore);
      seedOrderedChapters(store);
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putEvent(event('e-flashback', { sequence: 10, chapterPath: CHAPTER_THREE }), TIMELINE);
        writer.putEvent(event('e-opening', { sequence: 900, chapterPath: CHAPTER_ONE }), TIMELINE);
        writer.putEvent(event('e-no-chapter', { sequence: 50 }), TIMELINE);
      });
      deepEqual(
        store.listEvents({ orderBy: 'story' }).map(row => row.event.id),
        ['e-flashback', 'e-no-chapter', 'e-opening'],
        'story order ignores chapters entirely'
      );
      const manuscript = store.listEvents({ orderBy: 'manuscript' });
      deepEqual(
        manuscript.map(row => row.event.id),
        ['e-opening', 'e-flashback', 'e-no-chapter'],
        'manuscript order follows the built book, and the chapterless event trails'
      );
      equal(manuscript[2].orderExclusion, 'no-chapter', 'with the reason that belongs to THIS order');
      equal(
        store.listEvents({ orderBy: 'story' }).find(row => row.event.id === 'e-no-chapter')?.orderExclusion,
        undefined,
        'and the SAME event is perfectly placeable in story order'
      );
    }
  },
  {
    name: 'listEvents filters by entity and role, and role narrows WITHIN the entity match',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putEvent(
          event('e1', { sequence: 1, refs: [{ role: 'participant', raw: 'char:ivan', entityId: 'ivan', resolved: true }] }),
          TIMELINE
        );
        writer.putEvent(
          event('e2', { sequence: 2, refs: [{ role: 'location', raw: 'location:ivan', entityId: 'ivan', resolved: true }] }),
          TIMELINE
        );
      });
      deepEqual(
        store.listEvents({ orderBy: 'story', entityId: 'ivan' }).map(r => r.event.id),
        ['e1', 'e2'],
        'both roles match the entity'
      );
      // "Where was Ivan present" is not "which events happen in Ivan": an
      // independent role filter would answer neither when both are given.
      deepEqual(
        store.listEvents({ orderBy: 'story', entityId: 'ivan', role: 'participant' }).map(r => r.event.id),
        ['e1'],
        'the role narrows within the entity match'
      );
      deepEqual(
        store.listEvents({ orderBy: 'story', role: 'location' }).map(r => r.event.id),
        ['e2'],
        'a role alone is a legible question too'
      );
    }
  },
  {
    name: 'an unresolved reference is STORED and findable, and brokenOnly finds only it',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putEvent(
          event('e-ok', { sequence: 1, refs: [{ role: 'participant', raw: 'char:ivan', entityId: 'ivan', resolved: true }] }),
          TIMELINE
        );
        writer.putEvent(
          event('e-broken', { sequence: 2, refs: [{ role: 'participant', raw: 'char:ghost', entityId: 'ghost', resolved: false }] }),
          TIMELINE
        );
      });
      deepEqual(
        store.listEvents({ orderBy: 'story', brokenOnly: true }).map(r => r.event.id),
        ['e-broken'],
        'only the event with an unresolved reference'
      );
      // PAIRED POSITIVE: the resolved one is still stored and still found.
      equal(store.listEvents({ orderBy: 'story' }).length, 2, 'a broken reference does not drop its event');
      equal(store.getEvent('e-broken')?.event.refs[0].resolved, false, 'and the flag round-trips');
    }
  },
  {
    name: 'putEvent REPLACES by id, and re-indexing a file does not double its events',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putEvent(event('e1', { sequence: 1, title: 'Первое' }), TIMELINE);
      });
      store.transaction(writer => {
        writer.putEvent(event('e1', { sequence: 1, title: 'Исправленное' }), TIMELINE);
      });
      equal(store.listEvents({ orderBy: 'story' }).length, 1, 'one id, one event');
      equal(store.getEvent('e1')?.event.title, 'Исправленное', 'the later write is in effect');
    }
  },
  {
    name: 'clearDocumentContent drops the events of THAT document and no other',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      const OTHER_TIMELINE = 'knowledge/timeline/side.yaml';
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putDocument(timelineDocument(OTHER_TIMELINE));
        writer.putEvent(event('e1', { sequence: 1 }), TIMELINE);
        writer.putEvent(event('e2', { sequence: 2 }), OTHER_TIMELINE);
      });
      store.transaction(writer => writer.clearDocumentContent(TIMELINE));
      deepEqual(
        store.listEvents({ orderBy: 'story' }).map(row => row.event.id),
        ['e2'],
        're-indexing one timeline file must not leave its previous events behind, nor take a neighbour with it'
      );
    }
  },
  {
    name: 'an event limit selects the first rows of the chosen order, and is validated like every other',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putDocument(timelineDocument());
        writer.putEvent(event('e-a', { sequence: 1 }), TIMELINE);
        writer.putEvent(event('e-b', { sequence: 2 }), TIMELINE);
        writer.putEvent(event('e-c', { sequence: 3 }), TIMELINE);
      });
      deepEqual(
        store.listEvents({ orderBy: 'story', direction: 'desc', limit: 2 }).map(r => r.event.id),
        ['e-c', 'e-b'],
        'the cap selects the first rows of the chosen order'
      );
      await rejects(() => store.listEvents({ orderBy: 'story', limit: -1 }), 'constraint-violation', 'a negative event limit');
      equal(store.listEvents({ orderBy: 'story', limit: 0 }).length, 0, 'zero is a real answer here too');
    }
  },
  {
    name: 'relType is part of identity: same ends, two types, two relations',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putRelation(relation({ relType: 'ownership' }));
        writer.putRelation(relation({ relType: 'mentor-of' }));
        // The same identity again — an upsert, not a third row.
        writer.putRelation(relation({ relType: 'ownership' }));
      });
      equal(store.getRelations().length, 2, 'relation count');
      equal(store.getRelations({ relType: 'mentor-of' }).length, 1, 'by relType');
    }
  },
  {
    // tech_spec ОВ-1, tooth A12 (schema v3, UR-031).
    //
    // AN ARTIFACT RETURNING TO A PREVIOUS OWNER IS AN ORDINARY STORY BEAT, and
    // under the v2 identity key — `(ends, type, origin, owner document)` — the
    // two `ownership:` entries that record it were INDISTINGUISHABLE. The second
    // `putRelation` therefore resolved to the first row and OVERWROTE its
    // story-time labels and note, so the manuscript said "Varuna, then Arjuna,
    // then Varuna again" and the index said "Varuna once".
    //
    // THE REJECTING CASE IS THE OLD KEY ITSELF: remove `listPosition` from the
    // identity in either adapter and this case fails on `relation count`, with
    // the first `putRelation`'s id returned twice.
    name: 'two ownership entries naming the SAME owner are TWO relations, told apart by listPosition',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      const ids = store.transaction(writer => [
        writer.putRelation(
          relation({ listPosition: 0, storyTimeTo: 'до изгнания', note: 'хранит лук' })
        ),
        writer.putRelation(
          relation({ listPosition: 1, storyTimeFrom: 'после войны', note: 'получает его обратно' })
        )
      ]);
      check(ids[0] !== ids[1], 'the second ownership entry was folded onto the first');
      const stored = store
        .getRelations({ relType: 'ownership' })
        .slice()
        .sort((left, right) => (left.listPosition ?? -1) - (right.listPosition ?? -1));
      equal(stored.length, 2, 'relation count');
      equal(stored[0].listPosition, 0, 'first hop position');
      equal(stored[0].storyTimeTo, 'до изгнания', 'first hop storyTimeTo');
      equal(stored[0].note, 'хранит лук', 'first hop note');
      equal(stored[0].storyTimeFrom, undefined, 'first hop has no storyTimeFrom');
      equal(stored[1].listPosition, 1, 'second hop position');
      equal(stored[1].storyTimeFrom, 'после войны', 'second hop storyTimeFrom');
      equal(stored[1].note, 'получает его обратно', 'second hop note');
      // And the UPSERT still works WITHIN one position, so the new term made the
      // key finer without making it useless: re-writing the same entry must not
      // produce a third row.
      store.transaction(writer =>
        writer.putRelation(relation({ listPosition: 1, storyTimeFrom: 'после войны', note: 'исправлено' }))
      );
      const after = store.getRelations({ relType: 'ownership' });
      equal(after.length, 2, 're-writing one entry did not add a row');
      equal(
        after.find(candidate => candidate.listPosition === 1)?.note,
        'исправлено',
        'the re-written entry was updated in place'
      );
    }
  },
  {
    // tech_spec ОВ-1, tooth A13 (schema v3, UR-031).
    //
    // THE ONLY SHAPE IN WHICH "`?? undefined` INSTEAD OF `!== null`" IS VISIBLE.
    // `listPosition: 0` is the FIRST owner of an artifact — the commonest value
    // the column ever holds — so a reader written with a truthiness test drops it
    // and the whole chain reads as though it began at the second hop. An adapter
    // that stores the four columns and does not read them back passes every
    // other case in this file.
    name: 'the ownership chronology round-trips verbatim, including listPosition 0 and the absences',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putRelation(
          relation({
            listPosition: 0,
            storyTimeFrom: 'век богов',
            storyTimeTo: 'до изгнания',
            note: 'заметка автора'
          })
        );
        // A relation from a list with NO story time and NO note: the three
        // strings must come back ABSENT, not as empty strings.
        writer.putRelation(relation({ relType: 'mentions', listPosition: 7 }));
        // And a fold that came from no list at all.
        writer.putRelation(
          relation({
            origin: 'derived',
            ownerPath: undefined,
            relType: 'co-occurrence',
            evidence: [wholeFileEvidence(CHAPTER)]
          })
        );
      });
      const owned = store.getRelations({ relType: 'ownership' })[0];
      check(owned !== undefined, 'the ownership relation was dropped');
      equal(owned.listPosition, 0, 'listPosition 0 survived — a truthiness read loses this');
      equal(owned.storyTimeFrom, 'век богов', 'storyTimeFrom');
      equal(owned.storyTimeTo, 'до изгнания', 'storyTimeTo');
      equal(owned.note, 'заметка автора', 'note');

      const mentioned = store.getRelations({ relType: 'mentions' })[0];
      check(mentioned !== undefined, 'the card-mention relation was dropped');
      equal(mentioned.listPosition, 7, 'listPosition of a relation with no chronology');
      equal(mentioned.storyTimeFrom, undefined, 'absent storyTimeFrom is absent, not empty');
      equal(mentioned.storyTimeTo, undefined, 'absent storyTimeTo is absent, not empty');
      equal(mentioned.note, undefined, 'absent note is absent, not empty');

      const derived = store.getRelations({ origin: 'derived' })[0];
      check(derived !== undefined, 'the derived relation was dropped');
      equal(derived.listPosition, undefined, 'a fold over every mention has no list position');
    }
  },
  {
    name: 'an invented relType is stored verbatim and never validated',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      const invented = 'вымышленный-тип-связи';
      store.transaction(writer => writer.putRelation(relation({ relType: invented })));
      equal(store.getRelations()[0]?.relType, invented, 'the opaque relType survived');
    }
  },
  {
    name: "a relation with origin other than 'derived' and no owning document is REJECTED",
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      await rejectsSomehow(
        () =>
          store.transaction(writer =>
            writer.putRelation(relation({ origin: 'ai-candidate', ownerPath: undefined }))
          ),
        'an ownerless ai-candidate relation'
      );
      await rejectsSomehow(
        () => store.transaction(writer => writer.putRelation(relation({ origin: 'explicit', ownerPath: undefined }))),
        'an ownerless explicit relation'
      );
      // And the paired POSITIVE case, without which "reject everything ownerless"
      // would pass: `derived` is the one origin allowed to have no document.
      store.transaction(writer =>
        writer.putRelation(
          relation({
            origin: 'derived',
            ownerPath: undefined,
            relType: 'co-occurrence',
            evidence: [wholeFileEvidence(CHAPTER)]
          })
        )
      );
      equal(store.getRelations({ origin: 'derived' }).length, 1, 'the derived relation was accepted');
    }
  },
  {
    name: 'an ai-candidate relation WITH an owning card is accepted — it is a normal mode, not an edge case',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer =>
        writer.putRelation(relation({ origin: 'ai-candidate', confidence: 0.42 }))
      );
      const stored = store.getRelations({ origin: 'ai-candidate' })[0];
      check(stored !== undefined, 'the ai-candidate relation was dropped');
      equal(stored.confidence, 0.42, 'confidence');
      equal(stored.ownerPath, CARD, 'ownerPath');
    }
  },
  {
    name: 'a relation with no evidence at all is REJECTED',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      await rejectsSomehow(
        () => store.transaction(writer => writer.putRelation(relation({ evidence: [] }))),
        'a relation with an empty evidence array'
      );
    }
  },
  {
    name: 'a relation with an unresolved end is STORED with the flag and findable as broken',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putRelation(relation());
        writer.putRelation(relation({ targetId: 'nobody', targetResolved: false, relType: 'ownership' }));
      });
      equal(store.getRelations().length, 2, 'the broken relation was kept, not dropped');
      const broken = store.getRelations({ brokenOnly: true });
      equal(broken.length, 1, 'broken relation count');
      equal(broken[0].targetId, 'nobody', 'the broken end');
      equal(broken[0].targetResolved, false, 'the flag survived');
    }
  },
  {
    name: 'deleting a document cascades to its entities, mentions and relations',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD));
        writer.putMention(mention('krishna'));
        writer.putRelation(relation());
      });
      store.transaction(writer => writer.deleteDocument(CARD));
      equal(store.getEntity('krishna'), undefined, 'the entity defined by the deleted card');
      equal(store.getRelations().length, 0, 'relations owned by the deleted card');
      equal(store.getMentions().length, 1, 'a mention in a DIFFERENT document is untouched');
      store.transaction(writer => writer.deleteDocument(CHAPTER));
      equal(store.getMentions().length, 0, 'mentions in the deleted chapter');
    }
  },
  {
    name: 'neighbourhood walks by depth and honours the type, origin and limit filters',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putRelation(relation({ sourceId: 'krishna', targetId: 'arjuna', relType: 'mentor-of' }));
        writer.putRelation(relation({ sourceId: 'arjuna', targetId: 'draupadi', relType: 'mentor-of' }));
        writer.putRelation(relation({ sourceId: 'draupadi', targetId: 'bhima', relType: 'mentor-of' }));
        writer.putRelation(
          relation({
            sourceId: 'krishna',
            targetId: 'sudama',
            relType: 'co-occurrence',
            origin: 'derived',
            ownerPath: undefined,
            evidence: [wholeFileEvidence(CHAPTER)]
          })
        );
      });
      equal(store.neighbourhood({ entityId: 'krishna', depth: 1 }).length, 2, 'depth 1');
      equal(store.neighbourhood({ entityId: 'krishna', depth: 2 }).length, 3, 'depth 2');
      equal(store.neighbourhood({ entityId: 'krishna', depth: 3 }).length, 4, 'depth 3');
      equal(
        store.neighbourhood({ entityId: 'krishna', depth: 3, relTypes: ['mentor-of'] }).length,
        3,
        'depth 3 filtered by relType'
      );
      equal(
        store.neighbourhood({ entityId: 'krishna', depth: 1, origins: ['derived'] }).length,
        1,
        'depth 1 filtered by origin'
      );
      equal(store.neighbourhood({ entityId: 'krishna', depth: 3, limit: 2 }).length, 2, 'limit');
      equal(store.neighbourhood({ entityId: 'nobody', depth: 3 }).length, 0, 'an entity with no relations');
    }
  },
  {
    name: 'resetForRebuild empties the store',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD));
        writer.putMention(mention('krishna'));
      });
      store.resetForRebuild();
      equal(store.listDocuments().length, 0, 'documents after reset');
      equal(store.findEntities().length, 0, 'entities after reset');
      equal(store.getMentions().length, 0, 'mentions after reset');
      // The store is still usable afterwards — a reset is the START of a
      // rebuild, not the end of the instance.
      seedDocuments(store);
      equal(store.listDocuments().length, 3, 'documents after re-seeding');
    }
  },
  {
    name: 'a read-only instance refuses to write, explicitly, and still reads',
    async run(makeStore) {
      const store = await open(makeStore, { readOnly: true });
      equal(store.lifecycle().readOnly, true, 'readOnly');
      await rejects(
        () => store.transaction(writer => writer.putDocument(chapterDocument())),
        'read-only',
        'a write on a read-only instance'
      );
      // Reading must not throw — that is the entire reason WAL was chosen.
      equal(store.listDocuments().length, 0, 'reads still work on a read-only instance');
      equal(store.getEntity('krishna'), undefined, 'point reads still work');
    }
  }
];
