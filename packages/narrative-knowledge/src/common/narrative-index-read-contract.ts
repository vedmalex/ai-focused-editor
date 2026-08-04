/**
 * The contract core of the READING surface — runner-agnostic (TASK-022 WP-4a).
 *
 * SECOND CORE, SAME SCHEME, AND THE SEPARATION IS DELIBERATE.
 * `narrative-index-store-contract.ts` is about the STORE PORT: what
 * `putMention` refuses, what a rolled-back transaction leaves behind. This one
 * is about what the SERVICE answers: which state comes back with which data,
 * what a passage's context contains, and what a full rebuild writes. Mixing
 * them would make the store's contract grow a dependency on extraction.
 *
 * WHY IT IS A CONTRACT CORE AT ALL, RATHER THAN A `bun` TEST. Everything here
 * runs through `NarrativeIndexSession`, which speaks only to the port — so the
 * SAME assertions execute against the in-memory adapter under `bun` and against
 * real SQLite under `node`. That is the only arrangement in which WP-4a's
 * readiness block is honest: "a contract case for EVERY reading method" means
 * every reading method against every adapter, and ОВ-1's group-B teeth are
 * expressly the ones that need extraction AND a built index, which is exactly
 * what a rebuild through a real store gives them.
 *
 * WHAT IS ASSERTED ABOUT ORDER, AND WHY IT IS ASSERTED AT ALL (ISS-349). Two
 * reads promise an order — `listDocuments` by `relPath` and `findEntities` by
 * `id` — and the two adapters used to disagree about it: SQLite sorts with its
 * default `BINARY` collation, the in-memory adapter used `localeCompare`. No
 * case noticed, because every fixture happened to use names the two orders
 * agree about. The Cyrillic pair below is chosen so they DISAGREE: `Я` is
 * U+042F and `а` is U+0430, so by code point the upper-case word comes first,
 * and under any Russian locale it comes second.
 */

import { check, deepEqual, equal } from './contract-assertions';
import type { MakeContractStore } from './narrative-index-store-contract';
import { isRangeEvidence, type NarrativeIndexStore } from './graph';
import { NarrativeIndexSession, type IndexableFile } from './narrative-index-session';
import type { IndexState } from './index-state';
import { NARRATIVE_CONTEXT_SECTIONS, type NarrativeContextSection } from './narrative-context';

export interface NarrativeIndexReadContractCase {
  name: string;
  run(makeStore: MakeContractStore): Promise<void>;
}

/** Schema version handed to every session here. Any number does: `indexVersion`
 *  is asserted as `${this}.${generation}`, not against the real DDL. */
const CONTRACT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// The fixture manuscript
// ---------------------------------------------------------------------------

const CH = (n: number) => `content/ch-0${n}.md`;
/** The document every context case asks about. */
const SUBJECT = CH(3);

/**
 * The pair whose BINARY order and Russian-locale order disagree ON PURPOSE.
 *
 * The paths must sit at `entities/<directory>/<file>` for `classifyDocument` to
 * see them as cards at all — a two-segment `entities/Ярость.yaml` classifies as
 * nothing, so the disagreeing names are carried in the LAST segment where the
 * order actually gets compared.
 */
const CYRILLIC_UPPER_CARD = 'entities/characters/Ярость.yaml';
const CYRILLIC_LOWER_CARD = 'entities/characters/арджуна.yaml';
const CYRILLIC_UPPER_ID = 'Ярость';
const CYRILLIC_LOWER_ID = 'арджуна';

function file(path: string, text: string, overrides: Partial<IndexableFile> = {}): IndexableFile {
  return {
    path,
    uri: `file:///workspace/${path}`,
    text,
    sizeBytes: text.length,
    mtimeMs: 1_700_000_000_000,
    // Not a real SHA-256: nothing in the session hashes anything, it only
    // COMPARES hashes. A value derived from the text is what makes "same bytes,
    // different mtime" expressible without a crypto import in `src/common`.
    contentHash: `hash-of-${path}-${text.length}`,
    ...overrides
  };
}

/**
 * A small manuscript that exercises every source the index has.
 *
 * WHAT IS IN IT AND WHY EACH PIECE IS THERE:
 *   - five ordered chapters, so "spoiler-safe" has a before and an after;
 *   - a chapter (`ch-06`) whose only reference lives in FRONT MATTER, for
 *     ОВ-1's tooth B11;
 *   - an artifact card whose `ownership.owner` names nobody, for B9 and ОВ-2's
 *     tooth 8;
 *   - a duplicate id across two cards, so `findings` has its second source;
 *   - `sources/citations.yaml` and `sources/excerpts.jsonl` with REAL content,
 *     for B12 — they have to ARRIVE in order to be refused;
 *   - `knowledge/plans/ch-03.yaml` with non-empty `beats`, for ОВ-2's tooth 6;
 *   - the Cyrillic card pair, for ISS-349.
 */
function manuscript(): IndexableFile[] {
  return [
    file(
      'manifest.yaml',
      [
        'content:',
        ...[1, 2, 3, 4, 5, 6].map(n => `  - path: content/ch-0${n}.md\n    title: Chapter ${n}`)
      ].join('\n')
    ),
    file(
      'entities/characters/krishna.yaml',
      ['id: krishna', 'name: Кришна', 'aliases:', '  - Говинда'].join('\n')
    ),
    file('entities/characters/arjuna.yaml', ['id: arjuna', 'name: Арджуна'].join('\n')),
    file(CYRILLIC_UPPER_CARD, [`id: ${CYRILLIC_UPPER_ID}`, 'name: Ярость'].join('\n')),
    file(CYRILLIC_LOWER_CARD, [`id: ${CYRILLIC_LOWER_ID}`, 'name: Арджуна-кириллица'].join('\n')),
    // Source 2: a TYPED author relation whose target names no card at all.
    file(
      'entities/artifacts/gandiva.yaml',
      ['id: gandiva', 'name: Гандива', 'ownership:', '  - owner: nobody-at-all', '    from: before the war'].join('\n')
    ),
    // A second card claiming `gandiva` — the duplicate source of `findings`.
    file('entities/artifacts/gandiva-copy.yaml', ['id: gandiva', 'name: Гандива (копия)'].join('\n')),

    file(CH(1), 'Together: [[char:krishna|Кришна]] and [[char:arjuna|Арджуна]].'),
    file(CH(2), 'Alone: [[char:krishna|Кришна]].'),
    file(
      CH(3),
      [
        '---',
        'characters: "[[char:arjuna|Арджуна]]"',
        '---',
        '',
        'Here stands [[char:krishna|Кришна]] holding [[artifact:gandiva|Гандива]],',
        'and a reference to [[char:nobody|Никто]] that resolves to nothing.'
      ].join('\n')
    ),
    file(CH(4), 'Later: [[char:krishna|Кришна]].'),
    file(CH(5), 'Last: [[char:krishna|Кришна]].'),
    // B11: the ONLY reference is in front matter, so a reader that drops
    // front-matter mentions produces nothing here at all.
    file(
      'content/ch-06.md',
      ['---', 'characters: "[[char:krishna|Кришна]]"', '---', '', 'No tags in this prose.'].join('\n')
    ),

    // B12: real content, and it must produce NOT ONE relation row.
    file(
      'sources/citations.yaml',
      ['citations:', '  - id: gita-1-1', '    target: content/ch-01.md', '    line: 3'].join('\n')
    ),
    file(
      'sources/excerpts.jsonl',
      '{"sourceId":"gita","sourcePath":"sources/gita.md","targetPath":"content/ch-01.md","targetLine":3}'
    ),
    // ОВ-2 tooth 6: scenes EXIST on disk, and are still `unavailable`.
    file(
      'knowledge/plans/ch-03.yaml',
      ['scenes:', '  - title: The standoff', '    beats:', '      - Krishna speaks', '      - Arjuna lowers the bow'].join('\n')
    )
  ];
}

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

interface Built {
  store: NarrativeIndexStore;
  session: NarrativeIndexSession;
}

async function build(
  makeStore: MakeContractStore,
  files: readonly IndexableFile[] = manuscript()
): Promise<Built> {
  const store = await makeStore();
  check(store !== undefined, 'the harness could not produce a writable store');
  const session = new NarrativeIndexSession({
    store,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    now: () => 1_700_000_500_000
  });
  session.rebuild(files, { indexedAt: 1_700_000_400_000 });
  return { store, session };
}

/** Ask for a context on the subject chapter with the given options. */
function contextOf(session: NarrativeIndexSession, options = {}) {
  return session.getContextForDocument({
    documentUri: `file:///workspace/${SUBJECT}`,
    relPath: SUBJECT,
    options
  });
}

function stateName(state: IndexState): string {
  return state.state;
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

export const NARRATIVE_INDEX_READ_CONTRACT: NarrativeIndexReadContractCase[] = [
  // -- the rebuild itself ---------------------------------------------------
  {
    name: 'a full rebuild indexes exactly the four document kinds, and nothing else',
    async run(makeStore) {
      const { store, session } = await build(makeStore);
      const paths = store.listDocuments().map(document => document.relPath);
      check(paths.includes('manifest.yaml'), 'the manifest is a document');
      check(paths.includes(CH(1)), 'a chapter is a document');
      check(paths.includes('entities/characters/krishna.yaml'), 'a card is a document');
      // Source 5 and `knowledge/**` classify as NOTHING, so they never become
      // documents even though the walk handed them over.
      check(!paths.includes('sources/citations.yaml'), 'citations are not a document');
      check(!paths.includes('sources/excerpts.jsonl'), 'excerpts are not a document');
      check(!paths.includes('knowledge/plans/ch-03.yaml'), 'a scene plan is not a document');
      equal(stateName(session.state()), 'ready', 'state after a successful rebuild');
    }
  },
  {
    name: 'a rebuild is ONE transaction: the generation advances by exactly one',
    async run(makeStore) {
      const store = await makeStore();
      check(store !== undefined, 'writable store');
      const session = new NarrativeIndexSession({ store, schemaVersion: CONTRACT_SCHEMA_VERSION });
      const before = store.lifecycle().generation;
      session.rebuild(manuscript());
      equal(store.lifecycle().generation, before + 1, 'generation after one rebuild');
      session.rebuild(manuscript());
      equal(store.lifecycle().generation, before + 2, 'generation after a second rebuild');
    }
  },
  {
    name: 'a rebuild REMOVES documents that are no longer on disk',
    async run(makeStore) {
      const { store, session } = await build(makeStore);
      const smaller = manuscript().filter(item => item.path !== CH(5));
      const report = session.rebuild(smaller, { indexedAt: 1_700_000_400_001 }).data;
      equal(report.documentsRemoved, 1, 'documents removed');
      equal(store.getDocument(CH(5)), undefined, 'the removed chapter is gone');
      equal(store.getMentions({ relPath: CH(5) }).length, 0, 'its mentions went with it');
    }
  },

  // -- ОВ-1 group B: the conveyor teeth ------------------------------------
  {
    name: 'B3 — a touched mtime over UNCHANGED bytes is not a change, and adds no mention',
    async run(makeStore) {
      const { store, session } = await build(makeStore);
      const before = store.getMentions({ relPath: CH(1) });
      check(before.length > 0, 'the fixture chapter has mentions to begin with');

      // Same bytes, same size, a DIFFERENT mtime — what `git checkout` does to
      // an entire manuscript. The prefilter misses; `contentHash` is the
      // authority and it matches.
      const touched = manuscript().map(item =>
        item.path === CH(1) ? { ...item, mtimeMs: item.mtimeMs + 60_000 } : item
      );
      const report = session.rebuild(touched, { indexedAt: 1_700_000_400_002 }).data;

      check(
        report.unchangedDocuments.includes(CH(1)),
        'a touched mtime over identical bytes must be reported as UNCHANGED — an implementation ' +
          'whose freshness key is the (size, mtime) prefilter alone reports it as changed'
      );
      deepEqual(store.getMentions({ relPath: CH(1) }), before, 'the mention rows are the same rows');
      const row = store.getDocument(CH(1));
      equal(row?.contentHash, manuscript().find(item => item.path === CH(1))!.contentHash, 'the hash did not move');
      equal(row?.mtimeMs, 1_700_000_000_000 + 60_000, 'while the refreshed mtime WAS persisted');
    }
  },
  {
    name: 'B9 — a broken relation END is stored WITH the flag and reaches findings',
    async run(makeStore) {
      const { store, session } = await build(makeStore);
      const ownership = store.getRelations({ relType: 'ownership' });
      check(ownership.length === 1, `exactly one ownership relation, saw ${ownership.length}`);
      const relation = ownership[0]!;
      // (a) the row EXISTS — an implementation that DROPS a relation whose
      // target names nothing fails here.
      equal(relation.sourceId, 'gandiva', 'ownership source');
      equal(relation.targetId, 'nobody-at-all', 'ownership target, verbatim');
      // (b) it carries the flag — today's `readOwnership` turns an unknown
      // owner into its own label and stores it as if resolved; that fails here.
      equal(relation.targetResolved, false, 'the unresolved end is FLAGGED');
      equal(relation.sourceResolved, true, 'the resolved end is not');
      check(
        store.getRelations({ brokenOnly: true }).some(item => item.targetId === 'nobody-at-all'),
        'the broken relation is reachable through the broken-only index'
      );
      // (c) it reaches the consumer, through the passage that mentions the
      // artifact.
      const context = contextOf(session).data;
      check(context !== undefined, 'the subject chapter has a context');
      check(
        context.findings.some(
          finding => finding.kind === 'broken-relation' && finding.entityId === 'nobody-at-all'
        ),
        'a findings assembly built from only two sources fails here'
      );
    }
  },
  {
    name: 'B10 — an ownership relation arrives whole-file, with NO invented range',
    async run(makeStore) {
      const { store } = await build(makeStore);
      const relation = store.getRelations({ relType: 'ownership' })[0]!;
      equal(relation.evidence.length, 1, 'one evidence ref');
      equal(relation.evidence[0]!.evidenceKind, 'whole-file', 'evidence kind');
      equal(relation.evidence[0]!.range, undefined, 'no coordinates were invented');
      equal(relation.evidence[0]!.path, 'entities/artifacts/gandiva.yaml', 'evidence path');
    }
  },
  {
    name: 'B11 — a reference that exists ONLY in front matter is indexed, whole-file, unlabelled',
    async run(makeStore) {
      const { store } = await build(makeStore);
      const mentions = store.getMentions({ relPath: 'content/ch-06.md' });
      // An implementation that DROPS front-matter mentions gets zero here, and
      // "do not extract source 4" would otherwise pass as correct.
      equal(mentions.length, 1, 'the front-matter reference is indexed');
      const mention = mentions[0]!;
      equal(mention.entityId, 'krishna', 'the referenced id');
      equal(mention.evidence.evidenceKind, 'whole-file', 'evidence kind');
      equal(mention.evidence.range, undefined, 'no range — the YAML parser discarded the offsets');
      equal(mention.labelRange, undefined, 'and therefore no label range either');
    }
  },
  {
    name: 'B12 — citations and excerpts produce NOT ONE relation row, and no broken-relation noise',
    async run(makeStore) {
      const { store } = await build(makeStore);
      const relations = store.getRelations();
      for (const relation of relations) {
        check(
          relation.ownerPath !== 'sources/citations.yaml' && relation.ownerPath !== 'sources/excerpts.jsonl',
          `a relation was owned by ${relation.ownerPath}, which is outside the boundary of this issue`
        );
        for (const evidence of relation.evidence) {
          check(
            !evidence.path.startsWith('sources/'),
            `a relation was evidenced by ${evidence.path}, which is outside the boundary of this issue`
          );
        }
      }
      // The one genuine broken end is the ownership target and nothing else:
      // an implementation that pushed citations into `relation` would light up
      // `relation_broken` on CORRECT data and drown it.
      const broken = store.getRelations({ brokenOnly: true });
      equal(broken.length, 1, 'exactly one broken relation, and it is the ownership one');
      equal(broken[0]!.targetId, 'nobody-at-all', 'the one broken end');
    }
  },

  // -- source 6, the derived fold ------------------------------------------
  {
    name: 'co-occurrence edges are materialized as derived relations with per-chapter evidence',
    async run(makeStore) {
      const { store } = await build(makeStore);
      const derived = store.getRelations({ origin: 'derived' });
      check(derived.length > 0, 'a rebuild materializes co-occurrence edges');
      const pair = derived.find(
        relation => relation.sourceId === 'arjuna' && relation.targetId === 'krishna'
      );
      check(pair !== undefined, 'arjuna and krishna share a chapter, so they co-occur');
      equal(pair.relType, 'co-occurrence', 'relation type');
      equal(pair.ownerPath, undefined, 'a derived edge belongs to no card');
      equal(pair.sourceResolved, true, 'derived ends are resolved by construction');
      equal(pair.targetResolved, true, 'derived ends are resolved by construction');
      // The weight IS the evidence: one whole-file ref per shared chapter, in
      // path order, and the SAME order out of both adapters.
      deepEqual(
        pair.evidence.map(item => item.path),
        [CH(1), CH(3)],
        'shared chapters, in path order'
      );
      for (const evidence of pair.evidence) {
        equal(evidence.evidenceKind, 'whole-file', 'co-occurrence evidence kind');
      }
      // A broken reference names no entity, so it can never become an edge.
      check(
        !derived.some(relation => relation.sourceId === 'nobody' || relation.targetId === 'nobody'),
        'an unresolved reference must not become a co-occurrence end'
      );
    }
  },

  {
    name: "a relation's evidence reads back in PATH order, whatever order it was WRITTEN in",
    async run(makeStore) {
      const store = await makeStore();
      check(store !== undefined, 'writable store');
      const session = new NarrativeIndexSession({ store, schemaVersion: CONTRACT_SCHEMA_VERSION });
      // BUILT FROM A REVERSED FILE LIST, AND THAT IS THE WHOLE TOOTH. Document
      // ids are handed out in the order documents are written, and SQLite reads
      // this table through the covering index `relation_evidence_identity`,
      // whose second column is `doc_id` — so WITHOUT an explicit path ordering
      // the rows arrive in doc_id order. Build the manuscript forwards and
      // doc_id order happens to equal path order, and an unordered read looks
      // correct; this earlier version of the case was green against BOTH a
      // sorted and an unsorted SQLite adapter, which is to say it tested
      // nothing. Reversing makes the two orders disagree on purpose.
      session.rebuild([...manuscript()].reverse());

      // Written LAST-chapter-first, on purpose. Nothing about a co-occurrence
      // edge says which chapter was read first, and WP-4b's incremental update
      // will append one evidence row to an existing edge — so if the read order
      // is the WRITE order, the same query over an unchanged manuscript starts
      // returning the same edge differently depending on what happened to be
      // re-indexed.
      store.transaction(writer => {
        writer.putRelation({
          sourceId: 'arjuna',
          targetId: 'krishna',
          relType: 'written-backwards',
          origin: 'derived',
          sourceResolved: true,
          targetResolved: true,
          evidence: [
            { path: CH(5), evidenceKind: 'whole-file' },
            { path: CH(2), evidenceKind: 'whole-file' },
            { path: CH(1), evidenceKind: 'whole-file' }
          ]
        });
      });

      const stored = store.getRelations({ relType: 'written-backwards' })[0]!;
      deepEqual(
        stored.evidence.map(item => item.path),
        [CH(1), CH(2), CH(5)],
        'an adapter that returns evidence in insertion order fails here'
      );
      // The same must hold through the traversal query, which is a DIFFERENT
      // read path in both adapters.
      const walked = store
        .neighbourhood({ entityId: 'arjuna', depth: 1 })
        .find(relation => relation.relType === 'written-backwards')!;
      deepEqual(
        walked.evidence.map(item => item.path),
        [CH(1), CH(2), CH(5)],
        'and it must hold through neighbourhood too'
      );
    }
  },

  // -- one case per reading method -----------------------------------------
  {
    name: 'getEntity returns the card and the state, and undefined for an id nobody defines',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const found = session.getEntity('krishna');
      equal(found.data?.id, 'krishna', 'the entity');
      equal(found.data?.name, 'Кришна', 'its name, verbatim');
      equal(stateName(found.state), 'ready', 'the envelope carries a state');
      const missing = session.getEntity('nobody-at-all');
      equal(missing.data, undefined, 'an id nobody defines');
      equal(stateName(missing.state), 'ready', 'and still an envelope');
    }
  },
  {
    name: 'findEntities filters, and orders by id in CODE POINT order (ISS-349)',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const characters = session.findEntities({ type: 'character' }).data.map(entity => entity.id);
      check(characters.includes('krishna'), 'krishna is a character');
      check(characters.includes(CYRILLIC_UPPER_ID), 'the Cyrillic cards are characters too');

      const all = session.findEntities().data.map(entity => entity.id);
      const upper = all.indexOf(CYRILLIC_UPPER_ID);
      const lower = all.indexOf(CYRILLIC_LOWER_ID);
      check(upper >= 0 && lower >= 0, 'both Cyrillic entities are indexed');
      check(
        upper < lower,
        `'${CYRILLIC_UPPER_ID}' must precede '${CYRILLIC_LOWER_ID}' — that is SQLite's BINARY order, ` +
          'and it is the REVERSE of what localeCompare produces under any Russian locale. ' +
          'An adapter sorting by locale returns these two the other way round'
      );
    }
  },
  {
    name: 'listDocuments orders by relPath in CODE POINT order (ISS-349)',
    async run(makeStore) {
      const { store } = await build(makeStore);
      const paths = store.listDocuments().map(document => document.relPath);
      const upper = paths.indexOf(CYRILLIC_UPPER_CARD);
      const lower = paths.indexOf(CYRILLIC_LOWER_CARD);
      check(upper >= 0 && lower >= 0, 'both Cyrillic cards are indexed');
      check(
        upper < lower,
        `'${CYRILLIC_UPPER_CARD}' must precede '${CYRILLIC_LOWER_CARD}' — BINARY order, the reverse ` +
          'of localeCompare. This is the pair no earlier fixture disagreed about'
      );
    }
  },
  {
    name: 'getMentions returns every reference in a document, broken ones included',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const mentions = session.getMentions({ relPath: SUBJECT }).data;
      const ids = mentions.map(mention => mention.entityId);
      check(ids.includes('krishna'), 'a prose reference');
      check(ids.includes('arjuna'), 'a front-matter reference');
      check(ids.includes('nobody'), 'a BROKEN reference is kept, not dropped');
      equal(session.getMentions({ relPath: SUBJECT, brokenOnly: true }).data.length, 1, 'broken only');
      equal(stateName(session.getMentions().state), 'ready', 'the envelope carries a state');
    }
  },
  {
    name: 'getRelations filters by origin, type and brokenness',
    async run(makeStore) {
      const { session } = await build(makeStore);
      equal(session.getRelations({ relType: 'ownership' }).data.length, 1, 'by type');
      check(session.getRelations({ origin: 'derived' }).data.length > 0, 'by origin');
      equal(session.getRelations({ brokenOnly: true }).data.length, 1, 'broken only');
      equal(
        session.getRelations({ entityId: 'gandiva', direction: 'outgoing' }).data[0]?.targetId,
        'nobody-at-all',
        'by entity and direction'
      );
      equal(stateName(session.getRelations().state), 'ready', 'the envelope carries a state');
    }
  },
  {
    name: 'getIndexStatus reports absent/not-built before anything is written',
    async run(makeStore) {
      const store = await makeStore();
      check(store !== undefined, 'writable store');
      const session = new NarrativeIndexSession({ store, schemaVersion: CONTRACT_SCHEMA_VERSION });
      const state = session.state();
      equal(state.state, 'absent', 'a store with generation 0 has never been built');
      equal(state.generation, 0, 'and says so with the number itself');
      check(state.state === 'absent' && state.cause === 'not-built', 'the cause is not-built');
    }
  },
  {
    name: 'getContextForDocument answers for an indexed chapter, and NOT for an unindexed file',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const answer = contextOf(session);
      check(answer.data !== undefined, 'the subject chapter has a context');
      equal(answer.data.documentUri, `file:///workspace/${SUBJECT}`, 'the uri is echoed back');
      equal(answer.data.document.relPath, SUBJECT, 'the document is named by its index key');
      equal(answer.data.document.chapterOrder, 2, 'its position comes from the manifest');
      equal(answer.data.indexVersion, `${CONTRACT_SCHEMA_VERSION}.${answer.state.generation}`, 'indexVersion');

      const missing = session.getContextForDocument({
        documentUri: 'file:///workspace/sources/citations.yaml',
        relPath: 'sources/citations.yaml'
      });
      // NOT an empty context: an empty one would assert that a file the index
      // never read contains no narrative facts.
      equal(missing.data, undefined, 'a file the index does not hold has NO context');
      equal(stateName(missing.state), 'ready', 'and the state is still reported');
    }
  },

  // -- one NOT-ready case per reading method --------------------------------
  {
    name: 'every reading method reports a STALE index as stale, with its data',
    async run(makeStore) {
      const { session } = await build(makeStore);
      session.recordStale('watcher-lost');
      const states = [
        session.getEntity('krishna'),
        session.findEntities(),
        session.getMentions(),
        session.getRelations(),
        contextOf(session)
      ].map(result => result.state);
      for (const state of states) {
        equal(state.state, 'stale', 'a reading method under a stale index');
        check(state.state === 'stale' && state.staleReason === 'watcher-lost', 'the reason travels');
        check(state.state === 'stale' && state.staleSince > 0, 'and so does the moment');
      }
      // ОВ-6: the tools ANSWER, they do not refuse. Data still comes back.
      check(session.findEntities().data.length > 0, 'a stale index still answers with data');
      check(contextOf(session).data !== undefined, 'and still assembles a context');
    }
  },
  {
    name: 'every reading method reports a FAILED index as failed, and does not claim ready',
    async run(makeStore) {
      const { session } = await build(makeStore);
      session.recordFailure({ code: 'storage-corrupted', incidentId: 'incident-1', occurrences: 1 });
      const results = [
        session.getEntity('krishna'),
        session.findEntities(),
        session.getMentions(),
        session.getRelations(),
        contextOf(session)
      ];
      for (const result of results) {
        equal(result.state.state, 'failed', 'a reading method under a failed index');
        check(
          result.state.state === 'failed' && result.state.reason.code === 'storage-corrupted',
          'the whole reason travels, not just the word'
        );
      }
      session.clearFailure();
      equal(stateName(session.findEntities().state), 'ready', 'and clearing it restores ready');
    }
  },
  {
    name: 'a rebuilding index says so — an empty answer mid-rebuild is not an authoritative one',
    async run(makeStore) {
      const store = await makeStore();
      check(store !== undefined, 'writable store');
      let seen: IndexState | undefined;
      // The flag is only ever set INSIDE `rebuild`, so it has to be observed
      // from inside too. A proxy over the store gives the one hook a consumer
      // would really race with: the moment the write transaction opens. A
      // second `state()` call from outside would always be too late or too
      // early, and a test that asserted from there would be asserting nothing.
      const observed = new Proxy(store, {
        get(target, property, receiver) {
          if (property === 'transaction') {
            return <T,>(body: (writer: never) => T): T => {
              seen = session.state();
              return target.transaction(body as never);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      const session = new NarrativeIndexSession({
        store: observed,
        schemaVersion: CONTRACT_SCHEMA_VERSION
      });
      session.rebuild(manuscript());
      check(seen !== undefined, 'a state was observed while the transaction was open');
      equal(seen.state, 'rebuilding', 'and it said rebuilding');
      equal(stateName(session.state()), 'ready', 'while the finished pass says ready');
    }
  },

  // -- ОВ-2 teeth -----------------------------------------------------------
  {
    name: 'ОВ-2 tooth 1 — spoilerSafe hides later chapters, and turning it off returns them',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const safe = contextOf(session).data!;
      const laterPaths = [CH(4), CH(5)];
      for (const mention of safe.priorAppearances) {
        check(
          !laterPaths.includes(mention.evidence.path),
          `spoilerSafe returned evidence from ${mention.evidence.path}, which comes AFTER chapter 3`
        );
      }
      check(
        safe.priorAppearances.some(mention => mention.evidence.path === CH(1)),
        'earlier chapters are still returned'
      );
      const unsafe = contextOf(session, { spoilerSafe: false }).data!;
      check(
        unsafe.priorAppearances.some(mention => laterPaths.includes(mention.evidence.path)),
        'spoilerSafe: false MUST return the later chapters — otherwise the filter is unconditional'
      );
    }
  },
  {
    name: 'ОВ-2 tooth 2 — a section cap of 2 over 5 items returns 2 and reports 3 omitted',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const uncapped = contextOf(session, { spoilerSafe: false }).data!;
      const total = uncapped.priorAppearances.length;
      check(total >= 3, `the fixture needs at least 3 prior appearances, saw ${total}`);
      const capped = contextOf(session, { spoilerSafe: false, maxEvidencePerSection: 2 }).data!;
      equal(capped.priorAppearances.length, 2, 'the cap is applied');
      const omission = capped.omitted.find(
        item => item.section === 'priorAppearances' && item.reason === 'limit'
      );
      check(omission !== undefined, 'and what it cut is REPORTED, not silently dropped');
      equal(omission.count, total - 2, 'with the real number');
    }
  },
  {
    name: 'ОВ-2 tooth 3 — every unavailable section carries a non-empty requires, and none is empty',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const context = contextOf(session).data!;
      const unavailable: NarrativeContextSection[] = [
        'characterProfiles',
        'timeline',
        'plotThreads',
        'openQuestions',
        'scenePlan'
      ];
      for (const section of unavailable) {
        const availability = context.sections[section];
        equal(availability.status, 'unavailable', `${section} is a capability that does not exist yet`);
        check(
          availability.status === 'unavailable' && availability.requires.length > 0,
          `${section} must name the issue that will build it`
        );
      }
      for (const section of NARRATIVE_CONTEXT_SECTIONS) {
        check(context.sections[section] !== undefined, `${section} has an availability at all`);
      }
    }
  },
  {
    name: 'ОВ-2 tooth 4 — no element of any section arrives without an EvidenceRef',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const context = contextOf(session, { spoilerSafe: false }).data!;
      check(context.entities.length > 0, 'the fixture produces entities');
      check(context.mentions.length > 0, 'the fixture produces mentions');
      check(context.relations.length > 0, 'the fixture produces relations');
      check(context.priorAppearances.length > 0, 'the fixture produces prior appearances');
      check(context.findings.length > 0, 'the fixture produces findings');
      for (const item of context.entities) {
        check(item.evidence.path.length > 0, `entity ${item.entity.id} has no evidence path`);
      }
      for (const mention of [...context.mentions, ...context.priorAppearances]) {
        check(mention.evidence.path.length > 0, `mention of ${mention.entityId} has no evidence path`);
      }
      for (const relation of context.relations) {
        check(relation.evidence.length > 0, `relation ${relation.sourceId} has NO evidence at all`);
        for (const evidence of relation.evidence) {
          check(evidence.path.length > 0, 'a relation evidence ref has no path');
        }
      }
      for (const finding of context.findings) {
        check(finding.evidence.path.length > 0, `finding ${finding.kind} has no evidence path`);
      }
    }
  },
  {
    name: 'ОВ-2 tooth 5 — a not-ready index yields the ACTUAL state, never an empty context claiming ready',
    async run(makeStore) {
      const { session } = await build(makeStore);
      session.recordStale('partial-update-failed');
      const answer = contextOf(session);
      equal(answer.state.state, 'stale', 'the envelope reports what is true');
      check(
        answer.state.state === 'stale' && answer.state.staleReason === 'partial-update-failed',
        'including which kind of not-ready it is'
      );
      check(answer.data !== undefined, 'and the context is still assembled, not withheld');
    }
  },
  {
    name: 'ОВ-2 tooth 6 — scenePlan is unavailable/gh#51 even though a scene plan EXISTS on disk',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const context = contextOf(session).data!;
      const availability = context.sections.scenePlan;
      // The fixture carries `knowledge/plans/ch-03.yaml` with non-empty
      // `beats`. Reporting `empty` would assert "there are no scenes here"
      // about a manuscript that has a scene plan for THIS chapter.
      equal(availability.status, 'unavailable', 'scenePlan is a capability, not an empty list');
      check(
        availability.status === 'unavailable' && availability.requires === 'gh#51',
        'and it names the issue that resolves a scene into a range'
      );
    }
  },
  {
    name: 'ОВ-2 tooth 8 — a broken ownership end reaches the CONSUMER, not just storage',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const context = contextOf(session).data!;
      const finding = context.findings.find(item => item.kind === 'broken-relation');
      check(finding !== undefined, 'a findings assembly built from two sources fails here');
      equal(finding.entityId, 'nobody-at-all', 'the id that names nothing');
      equal(finding.relType, 'ownership', 'from the typed author relation');
      equal(finding.unresolvedEnd, 'target', 'and which end it was');
      equal(finding.evidence.path, 'entities/artifacts/gandiva.yaml', 'navigable to the card');
    }
  },
  {
    name: 'findings carry all THREE sources — broken mention, duplicate id, broken relation',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const context = contextOf(session).data!;
      const kinds = new Set(context.findings.map(finding => finding.kind));
      check(kinds.has('broken-mention'), 'source 1: a broken reference in prose');
      check(kinds.has('duplicate-entity'), 'source 2: two cards claiming one id');
      check(kinds.has('broken-relation'), 'source 3: a relation end naming nothing');
      const duplicate = context.findings.find(finding => finding.kind === 'duplicate-entity')!;
      equal(duplicate.entityId, 'gandiva', 'the contested id');
      check(duplicate.keptRelPath !== undefined, 'and the finding names the card in effect');
      check(
        duplicate.evidence.path !== duplicate.keptRelPath,
        'while pointing at the card being IGNORED — the one the author has to open'
      );
    }
  },

  // -- range and include ----------------------------------------------------
  {
    name: 'a range narrows the mentions, and an unplaceable one is COUNTED rather than dropped',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const whole = contextOf(session).data!;
      const wholeFileMentions = whole.mentions.filter(mention => !isRangeEvidence(mention.evidence));
      check(wholeFileMentions.length > 0, 'the subject chapter has a front-matter reference');

      // The prose of ch-03 begins after the front matter; this range covers the
      // first prose line only.
      const narrowed = contextOf(session, {
        range: { start: { line: 4, character: 0 }, end: { line: 4, character: 200 } }
      }).data!;
      check(narrowed.mentions.length < whole.mentions.length, 'the range narrows the answer');
      for (const mention of narrowed.mentions) {
        check(isRangeEvidence(mention.evidence), 'only placeable mentions survive a range query');
      }
      const omission = narrowed.omitted.find(
        item => item.section === 'mentions' && item.reason === 'unknown-position'
      );
      check(
        omission !== undefined && omission.count === wholeFileMentions.length,
        'a whole-file mention cannot be PLACED in a range, so it is counted, not silently lost'
      );
      deepEqual(
        narrowed.resolvedRange,
        { start: { line: 4, character: 0 }, end: { line: 4, character: 200 } },
        'the service reports the range it actually used'
      );
    }
  },
  {
    name: 'include narrows which sections are built, without changing their availability shape',
    async run(makeStore) {
      const { session } = await build(makeStore);
      const only = contextOf(session, { include: ['mentions'] }).data!;
      check(only.mentions.length > 0, 'the requested section is built');
      equal(only.relations.length, 0, 'an unrequested section is not');
      equal(only.findings.length, 0, 'nor is another');
      // Availability still describes EVERY section, including the ones this
      // call did not ask for — a consumer must not read "not requested" as
      // "does not exist".
      equal(only.sections.scenePlan.status, 'unavailable', 'unbuilt capabilities are still named');
    }
  }
];
