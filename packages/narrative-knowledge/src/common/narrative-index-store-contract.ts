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
  NarrativeEntity,
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
/** Listed WITH an order, and excluded from the built book anyway — the two are
 *  independent columns, and a fixture that conflated them would let an adapter
 *  pass by testing the wrong one. */
const EXCLUDED_CHAPTER = 'manuscript/ordered-excluded.md';

function orderedChapter(relPath: string, order?: number, manifestIncluded = true) {
  return {
    relPath,
    kind: 'chapter' as const,
    sizeBytes: 512,
    mtimeMs: 1_700_000_004_000,
    contentHash: 'c'.repeat(64),
    ...(order === undefined ? {} : { chapterOrder: order }),
    manifestIncluded,
    indexedAt: 1_700_000_005_000
  };
}

function seedOrderedChapters(store: NarrativeIndexStore): void {
  store.transaction(writer => {
    writer.putDocument(orderedChapter(CHAPTER_ONE, 0));
    writer.putDocument(orderedChapter(CHAPTER_TWO, 1));
    writer.putDocument(orderedChapter(CHAPTER_THREE, 2));
    writer.putDocument(orderedChapter(UNLISTED_CHAPTER, undefined, false));
    writer.putDocument(orderedChapter(EXCLUDED_CHAPTER, 3, false));
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
    writer.putMention(at(CHAPTER_ONE, 9, 'ch1-line9'));
    writer.putMention(at(CHAPTER_ONE, 2, 'ch1-line2'));
    writer.putMention(mention('krishna', { raw: 'ch3-whole-file', evidence: wholeFileEvidence(CHAPTER_THREE) }));
    writer.putMention(at(UNLISTED_CHAPTER, 1, 'scratch-line1'));
    writer.putMention(at(EXCLUDED_CHAPTER, 1, 'excluded-line1'));
  });
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
        ordered.slice(0, 3).map(m => m.raw),
        ['ch1-line2', 'ch1-line9', 'ch2-line5'],
        'ascending manuscript order'
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
        ordered.slice(0, 3).map(m => m.raw),
        ['ch2-line5', 'ch1-line9', 'ch1-line2'],
        'descending manuscript order'
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
        equal(ordered.length, 6, `every mention is still returned (${direction})`);
        deepEqual(
          ordered.slice(3).map(m => m.raw),
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
        ['ch2-line5', 'ch1-line9', 'ch1-line2', 'ch3-whole-file', 'scratch-line1', 'excluded-line1'],
        'without orderBy the result is insertion order'
      );
      // Renumber the manifest: ch-02 now comes first. Only DOCUMENT rows change.
      store.transaction(writer => {
        writer.putDocument({ ...orderedChapter(CHAPTER_ONE, 1) });
        writer.putDocument({ ...orderedChapter(CHAPTER_TWO, 0) });
      });
      deepEqual(
        store.getMentions({ entityId: 'krishna', orderBy: 'chapter', direction: 'asc' }).slice(0, 3).map(m => m.raw),
        ['ch2-line5', 'ch1-line2', 'ch1-line9'],
        'renumbering the manifest reorders the answer'
      );
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
