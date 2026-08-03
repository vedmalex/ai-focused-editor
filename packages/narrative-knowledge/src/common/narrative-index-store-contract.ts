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
// Assertions — deliberately hand-rolled, see the module note
// --------------------------------------------------------------------------

class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractViolation';
  }
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ContractViolation(message);
  }
}

function equal<T>(actual: T, expected: T, what: string): void {
  if (!Object.is(actual, expected)) {
    throw new ContractViolation(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Serialize with sorted keys.
 *
 * KEY ORDER IS NOT PART OF THE CONTRACT and must not be asserted by accident.
 * The in-memory adapter returns a structural clone of what it was handed, so it
 * preserves the literal's key order; the SQLite adapter rebuilds the object
 * column by column and cannot. A plain `JSON.stringify` comparison would fail
 * for SQLite on that difference alone — a red test with nothing wrong behind it,
 * which is worse than no test because it teaches people to weaken the assertion.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function deepEqual(actual: unknown, expected: unknown, what: string): void {
  const a = stableStringify(actual);
  const b = stableStringify(expected);
  if (a !== b) {
    throw new ContractViolation(`${what}: expected ${b}, got ${a}`);
  }
}

/**
 * Assert that `body` throws this port's error with the given kind.
 *
 * The KIND is asserted, never the message: the in-memory adapter phrases its
 * refusal itself while SQLite's text comes from the engine, and an assertion on
 * wording would be an assertion about which adapter is running.
 */
async function rejects(body: () => unknown, kind: string, what: string): Promise<void> {
  let threw: unknown;
  let returned = false;
  try {
    await body();
    returned = true;
  } catch (error) {
    threw = error;
  }
  check(!returned, `${what}: expected a rejection, but the call returned normally`);
  check(
    isNarrativeIndexStoreError(threw) ? threw.kind === kind : false,
    `${what}: expected NarrativeIndexStoreError of kind '${kind}', got ${String(threw)}`
  );
}

/** As {@link rejects}, but the rejection may come from the ENGINE rather than
 *  from this port — a SQLite `CHECK` throws its own `Error`. What is asserted
 *  is only that the write did not succeed. */
async function rejectsSomehow(body: () => unknown, what: string): Promise<void> {
  let returned = false;
  try {
    await body();
    returned = true;
  } catch {
    return;
  }
  check(!returned, `${what}: expected a rejection, but the call returned normally`);
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const CHAPTER = 'manuscript/ch-01.md';
const CARD = 'entities/krishna.yaml';
const OTHER_CARD = 'entities/arjuna.yaml';

function chapterDocument() {
  return {
    relPath: CHAPTER,
    kind: 'chapter' as const,
    sizeBytes: 1024,
    mtimeMs: 1_700_000_000_000,
    contentHash: 'a'.repeat(64),
    chapterOrder: 0,
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
    name: 'a duplicated entity id is kept as a finding, naming every card that defines it',
    async run(makeStore) {
      const store = await open(makeStore);
      seedDocuments(store);
      store.transaction(writer => {
        writer.putEntity(entity('krishna', CARD));
        writer.putDuplicateEntity('krishna', OTHER_CARD);
      });
      const duplicates = store.getDuplicateEntities();
      equal(duplicates.length, 1, 'duplicate count');
      equal(duplicates[0].entityId, 'krishna', 'duplicate id');
      check(duplicates[0].relPaths.includes(OTHER_CARD), 'the second defining card is named');
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
