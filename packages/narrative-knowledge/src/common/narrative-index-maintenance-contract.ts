/**
 * The contract core of INCREMENTALITY, the guard and `configure` — runner
 * agnostic (TASK-022 WP-4b).
 *
 * THIRD CORE, SAME SCHEME, AND THE REASON IS SHARPER HERE THAN ANYWHERE ELSE.
 * `narrative-index-store-contract.ts` is about the port, `narrative-index-read-contract.ts`
 * about the answers a reader gets. This one is about WRITES THAT ARE NOT A
 * REBUILD — and those are exactly the writes SQLite can fail at in ways an
 * in-memory double cannot: a `moveDocument` that has to keep `doc_id` while
 * every other table joins to it, an evidence row appended to an existing
 * co-occurrence edge (which is what made WP-4a discover that a covering index
 * was imposing a read order), and a transaction that must serialize against a
 * second writer. Running these cases ONLY under `bun` would prove them about a
 * `Map`.
 *
 * WHAT THE HARNESS SUPPLIES, AND WHY IT IS TWO THINGS. A store — the in-memory
 * adapter in the fast lane, SQLite in the node lane — and a rung-1 config store:
 * a plain record in the fast lane, the REAL five-rung
 * `NarrativeMemoryConfigResolver` in the node lane. The second is not padding:
 * tech_spec ОВ-9б's teeth are about `configure` sitting ON the ladder, and a
 * `configure` proved only against a double would be proved against the half of
 * the system nobody ships.
 *
 * THE FIXTURE HASHES ITS OWN TEXT, and it has to. The teeth C1/C2/C4 turn on a
 * file whose BYTES CHANGED while its `mtime` and `size` were RESTORED, so the
 * fixture needs two different texts of the SAME LENGTH with DIFFERENT hashes.
 * A hash derived from the length — which is what the WP-4a fixture uses, and
 * correctly, because nothing there depended on it — would make those three teeth
 * unwritable. This one is a small FNV-1a over the characters: not SHA-256
 * (`src/common` has no crypto, by prohibition (a)), and it does not need to be —
 * nothing in the session HASHES anything, it only COMPARES hashes.
 */

import { check, deepEqual, equal } from './contract-assertions';
import type { NarrativeIndexStore } from './graph';
import { NarrativeIndexSession, type IndexableFile } from './narrative-index-session';
import {
  NarrativeIndexMaintainer,
  WATCHER_WARMUP_DURATION_MS,
  WATCHER_WARMUP_SWEEP_INTERVAL_MS
} from './narrative-index-maintainer';
import { TestNarrativeFileWatcher } from './narrative-file-watcher';
import { ManualTimerScheduler } from './narrative-timer';
import { InMemoryWorkspaceSource } from './narrative-workspace-source';
import {
  NarrativeMemoryConfigurator,
  type NarrativeMemoryConfigStore
} from './narrative-memory-configure';

/** What one harness hands over for one case. */
export interface MaintenanceHarness {
  store: NarrativeIndexStore;
  /** Rung-1 storage. The real resolver in the node lane, a double in the fast one. */
  configStore: NarrativeMemoryConfigStore;
  /** Whether this harness can put `databasePath` under a CLI lock. */
  lockDatabasePathByCli?(locked: boolean): void;
}

export type MakeMaintenanceHarness = () => Promise<MaintenanceHarness> | MaintenanceHarness;

export interface NarrativeMaintenanceContractCase {
  name: string;
  run(makeHarness: MakeMaintenanceHarness): Promise<void>;
}

const SCHEMA_VERSION = 1;
/** The scope every case configures against. Not a real path in either lane. */
export const CONTRACT_ROOT = '/contract-workspace';

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

const CH = (n: number) => `content/ch-0${n}.md`;
const KRISHNA_CARD = 'entities/characters/krishna.yaml';
const ARJUNA_CARD = 'entities/characters/arjuna.yaml';

/** FNV-1a over the code units. Deterministic, and — unlike a length-derived
 *  value — DIFFERENT for two different texts of the same length. */
function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function file(path: string, text: string, overrides: Partial<IndexableFile> = {}): IndexableFile {
  return {
    path,
    uri: `file:///workspace/${path}`,
    text,
    sizeBytes: text.length,
    mtimeMs: 1_700_000_000_000,
    contentHash: textHash(text),
    ...overrides
  };
}

/**
 * A manuscript small enough to reason about and complete enough to break.
 *
 * Two cards, four ordered chapters, one file the index must REFUSE to read
 * (`sources/citations.yaml`) so that "an edit there costs nothing" is an
 * assertion about the pipeline and not about a walk that never delivered it.
 */
function manuscript(): IndexableFile[] {
  return [
    file(
      'manifest.yaml',
      ['content:', ...[1, 2, 3, 4].map(n => `  - path: content/ch-0${n}.md\n    title: Chapter ${n}`)].join('\n')
    ),
    file(KRISHNA_CARD, ['id: krishna', 'name: Кришна'].join('\n')),
    file(ARJUNA_CARD, ['id: arjuna', 'name: Арджуна'].join('\n')),
    file(CH(1), 'Together: [[char:krishna|Кришна]] and [[char:arjuna|Арджуна]].'),
    file(CH(2), 'Alone: [[char:krishna|Кришна]].'),
    file(CH(3), 'Also alone: [[char:krishna|Кришна]].'),
    file(CH(4), 'Both again: [[char:krishna|Кришна]] and [[char:arjuna|Арджуна]].'),
    file('sources/citations.yaml', ['citations:', '  - id: gita-1-1', '    target: content/ch-01.md'].join('\n'))
  ];
}

interface Built {
  store: NarrativeIndexStore;
  session: NarrativeIndexSession;
  source: InMemoryWorkspaceSource;
  watcher: TestNarrativeFileWatcher;
  scheduler: ManualTimerScheduler;
  configurator: NarrativeMemoryConfigurator;
  configStore: NarrativeMemoryConfigStore;
  maintainer: NarrativeIndexMaintainer;
  harness: MaintenanceHarness;
}

/**
 * Stand a whole maintenance stack up and build the index once.
 *
 * The initial build goes through `rebuildNow`, i.e. through the guard, so every
 * case starts from a state the production path produced.
 */
async function build(makeHarness: MakeMaintenanceHarness, files = manuscript()): Promise<Built> {
  const harness = await makeHarness();
  const source = new InMemoryWorkspaceSource(files);
  const watcher = new TestNarrativeFileWatcher();
  const scheduler = new ManualTimerScheduler();
  const configurator = new NarrativeMemoryConfigurator(harness.configStore);
  const session = new NarrativeIndexSession({
    store: harness.store,
    schemaVersion: SCHEMA_VERSION,
    now: () => 1_700_000_500_000
  });
  const maintainer = new NarrativeIndexMaintainer({
    session,
    source,
    config: () => harness.configStore.resolve(CONTRACT_ROOT),
    scheduler,
    watcher,
    configurator,
    rootPath: CONTRACT_ROOT,
    now: () => 1_700_000_500_000
  });
  maintainer.start();
  await maintainer.rebuildNow();
  source.resetReads();
  return { store: harness.store, session, source, watcher, scheduler, configurator, configStore: harness.configStore, maintainer, harness };
}

/**
 * Everything about an index that is a FACT rather than a row id.
 *
 * `docId` is deliberately absent: it is stable while a row lives and explicitly
 * NOT across rebuilds, so comparing it would make "equal to a full rebuild"
 * false for reasons that have nothing to do with correctness. What IS compared
 * is every path, every id, every resolution flag and every piece of evidence —
 * which is the whole of what a consumer can see.
 */
function fingerprint(store: NarrativeIndexStore): unknown {
  return {
    documents: store.listDocuments().map(document => ({
      relPath: document.relPath,
      kind: document.kind,
      contentHash: document.contentHash,
      chapterOrder: document.chapterOrder ?? null,
      manifestIncluded: document.manifestIncluded
    })),
    entities: store.findEntities().map(entity => ({
      id: entity.id,
      type: entity.type,
      sourcePath: entity.sourcePath
    })),
    mentions: store
      .getMentions()
      .map(mention => ({
        entityId: mention.entityId,
        path: mention.evidence.path,
        kind: mention.evidence.evidenceKind,
        resolved: mention.resolved,
        raw: mention.raw
      }))
      .sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : 1),
    relations: store
      .getRelations()
      .map(relation => ({
        sourceId: relation.sourceId,
        targetId: relation.targetId,
        relType: relation.relType,
        origin: relation.origin,
        ownerPath: relation.ownerPath ?? null,
        evidence: relation.evidence.map(item => item.path)
      }))
      .sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : 1)
  };
}

/** Build the same files from scratch in a SECOND store, for the equivalence
 *  assertions. Nothing incremental touches it. */
async function fullRebuildOf(
  makeHarness: MakeMaintenanceHarness,
  files: readonly IndexableFile[]
): Promise<NarrativeIndexStore> {
  const harness = await makeHarness();
  const session = new NarrativeIndexSession({ store: harness.store, schemaVersion: SCHEMA_VERSION });
  session.rebuild(files, { indexedAt: 1_700_000_400_000 });
  return harness.store;
}

/** Push a batch and let the debounce window close. */
async function pushAndSettle(built: Built, ...changes: { path: string; type: 'added' | 'updated' | 'deleted' }[]) {
  built.watcher.push(...changes);
  built.scheduler.advance(built.configStore.resolve(CONTRACT_ROOT).debounceMs);
  await built.maintainer.flush();
}

/**
 * Wait for the guard to drain, INCLUDING a fire-and-forget continuation chained
 * onto the pass that just finished (ISS-360's `armWarmupSweep` re-arm, `armSweep`'s
 * own TTL re-arm, and the watcher path's failure recorder all share this shape:
 * `void this.enqueue(...).catch(...).finally(callback)`).
 *
 * `flush()` ALONE IS NOT ENOUGH FOR THESE. It awaits `this.draining` — the
 * `drain()` promise — which settles as soon as the queue empties, and that
 * happens ONE MICROTASK TICK BEFORE a `.catch()/.finally()` chained onto the
 * INDIVIDUAL pass's own promise gets to run (the pass promise resolves inside
 * `drain()`'s loop; `drain()`'s own promise resolves after it, in the same
 * synchronous stretch, so whoever awaits `flush()` is woken first). A
 * fire-and-forget callback such as `armWarmupSweep()`'s re-arm therefore has not
 * necessarily run yet the instant `flush()` returns — repeating flush across a
 * few empty microtask turns gives it the ticks it needs, and, if it enqueues a
 * NEW pass (as a re-arm-and-fire would), a later `flush()` call in the same loop
 * picks that up too.
 */
async function drainSettled(maintainer: NarrativeIndexMaintainer): Promise<void> {
  for (let round = 0; round < 8; round++) {
    await maintainer.flush();
    await Promise.resolve();
  }
}

/** The two texts C1/C2/C4 need: same length, different bytes. */
const SAME_LENGTH_ORIGINAL = 'Alone: [[char:krishna|Кришна]].';
const SAME_LENGTH_EDITED = 'Alone: [[char:krishna|Кришнa]].';

/** The chapter that sits INSIDE the part whose `include:` the gh#47 pair flips. */
const CUT_CHAPTER = 'content/cut/ch-00.md';

/**
 * A manuscript whose FIRST manifest entry is a part, so the chapter inside it
 * takes `chapterOrder` 0 and would lead any ascending query.
 *
 * A PART CARRIES ITS OWN `path` — a directory — and that is not incidental
 * bookkeeping: `walk` skips an entry with no `path` before it ever reaches
 * `children`, so a part written without one contributes nothing at all. The
 * directory path fails the `.mdx?` test, so the part itself is not a chapter,
 * while its children are walked with the inherited `include` flag. Writing the
 * fixture the other way is how one learns this; it is recorded here so the next
 * reader does not have to.
 */
function excludedPartManuscript(partIncluded: boolean): IndexableFile[] {
  return [
    file(
      'manifest.yaml',
      [
        'content:',
        '  - path: content/cut',
        '    title: Вырезанное',
        `    include: ${partIncluded}`,
        '    children:',
        `      - path: ${CUT_CHAPTER}`,
        '        title: Пролог',
        `  - path: ${CH(1)}`,
        '    title: Глава первая'
      ].join('\n')
    ),
    file(KRISHNA_CARD, ['id: krishna', 'name: Кришна'].join('\n')),
    file(CUT_CHAPTER, 'Вырезано: [[char:krishna|Кришна]].'),
    file(CH(1), 'Оставлено: [[char:krishna|Кришна]].')
  ];
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

export const NARRATIVE_MAINTENANCE_CONTRACT: NarrativeMaintenanceContractCase[] = [
  // -- manuscript order means order in the BUILT book (gh#47) ---------------
  {
    /**
     * THIS CASE EXISTS BECAUSE THE STORE-LEVEL ONE WAS NOT ENOUGH, and the way
     * it was not enough is the whole lesson.
     *
     * Manuscript ordering ships a rule: a chapter outside the built book can be
     * shown, but must never be reported as an entity's FIRST APPEARANCE. The
     * store contract asserts that rule by writing a document with the excluding
     * flag set — and passed, in both adapters, while the rule was DEAD in the
     * product. The state it wrote is one the indexer never produces: an
     * `include: false` entry is still LISTED, so `manifestIncluded` is `true`
     * for it, and `manifest-extraction` gives it a real `order` besides. The
     * first edition read the exclusion off `manifestIncluded`, so it never fired.
     *
     * So this case drives the REAL manifest through the REAL session. The
     * excluded part is placed FIRST on purpose: it takes `chapterOrder` 0, which
     * means a broken implementation does not merely fail to exclude it — it
     * actively reports the cut prologue as where the character first appears.
     */
    name: 'gh#47: an `include: false` chapter is listed and ordered, yet never the first appearance',
    async run(makeHarness) {
      const built = await build(makeHarness, excludedPartManuscript(false));

      // (1) The row the indexer actually writes. Pinned field by field, because
      // every one of them is a premise the ordering rule depends on, and the
      // defect lived in believing a different combination.
      const cut = built.store.getDocument(CUT_CHAPTER);
      check(cut !== undefined, 'the excluded chapter must still be INDEXED — its mentions are real');
      equal(cut.manifestIncluded, true, 'an `include: false` entry is still LISTED');
      equal(cut.buildIncluded, false, 'and it is still out of the built book');
      equal(cut.chapterOrder, 0, 'and it still holds a position in the walk');

      // (2) The rule itself, through the query the card issues.
      const first = built.store.getMentions({
        entityId: 'krishna',
        orderBy: 'chapter',
        direction: 'asc',
        limit: 1
      });
      deepEqual(
        first.map(mention => mention.evidence.path),
        [CH(1)],
        'the first appearance is the first chapter of the BUILT book, not the cut one'
      );

      // (3) Shown, not dropped. The rule is about ranking, not about hiding.
      equal(
        built.store.getMentions({ entityId: 'krishna' }).length,
        2,
        'the excluded chapter\'s mention is still returned'
      );
    }
  },
  {
    /**
     * THE PAIRED POSITIVE, and without it the case above is worthless: an
     * implementation that excludes EVERY chapter from ordering passes it, and so
     * does one that simply reports the second chapter always. Same tree, same
     * shape, `include:` flipped — the cut prologue becomes the first appearance.
     */
    name: 'gh#47, paired positive: with the part included, the same first chapter IS the first appearance',
    async run(makeHarness) {
      const built = await build(makeHarness, excludedPartManuscript(true));

      equal(built.store.getDocument(CUT_CHAPTER)?.buildIncluded, true, 'the part is in the build now');
      deepEqual(
        built.store
          .getMentions({ entityId: 'krishna', orderBy: 'chapter', direction: 'asc', limit: 1 })
          .map(mention => mention.evidence.path),
        [CUT_CHAPTER],
        'nothing excludes it any more, so it leads'
      );
    }
  },
  // -- incrementality is real ----------------------------------------------
  {
    name: 'an edited chapter is re-indexed INCREMENTALLY — one transaction, one document, no rebuild',
    async run(makeHarness) {
      const built = await build(makeHarness);
      const before = built.store.lifecycle().generation;
      built.source.put(file(CH(2), 'Alone: [[char:arjuna|Арджуна]] now.'));

      const answer = await built.maintainer.updateDocument(CH(2));
      equal(answer.data.mode, 'incremental', 'an ordinary chapter edit must NOT escalate to a rebuild');
      deepEqual(answer.data.documentsReindexed, [CH(2)], 'exactly the edited chapter');
      equal(built.store.lifecycle().generation, before + 1, 'ONE committed transaction');

      const mentions = built.store.getMentions({ relPath: CH(2) }).map(mention => mention.entityId);
      deepEqual(mentions, ['arjuna'], 'the new text decides the mentions');
      // Untouched chapters keep their rows verbatim — the machine form of
      // "re-indexing one file leaves its neighbours alone".
      deepEqual(
        built.store.getMentions({ relPath: CH(1) }).map(mention => mention.entityId).sort(),
        ['arjuna', 'krishna'],
        'a neighbour chapter was not re-extracted'
      );
    }
  },
  {
    name: 'an incremental pass leaves the index EQUAL to a full rebuild of the same tree',
    async run(makeHarness) {
      const built = await build(makeHarness);
      const edited = file(CH(3), 'Now with both: [[char:krishna|Кришна]] and [[char:arjuna|Арджуна]].');
      built.source.put(edited);
      await pushAndSettle(built, { path: CH(3), type: 'updated' });

      const expected = manuscript().map(item => (item.path === CH(3) ? edited : item));
      deepEqual(
        fingerprint(built.store),
        fingerprint(await fullRebuildOf(makeHarness, expected)),
        'an incremental update must reach the same index a rebuild would'
      );
    }
  },
  {
    name: 'a deleted chapter takes its mentions AND its co-occurrence edges with it',
    async run(makeHarness) {
      const built = await build(makeHarness);
      built.source.remove(CH(4));
      const answer = await pushAndSettle(built, { path: CH(4), type: 'deleted' }).then(
        () => built.session.documentOf(CH(4))
      );
      equal(answer, undefined, 'the document row is gone');
      equal(built.store.getMentions({ relPath: CH(4) }).length, 0, 'and so are its mentions');

      const remaining = manuscript().filter(item => item.path !== CH(4));
      deepEqual(
        fingerprint(built.store),
        fingerprint(await fullRebuildOf(makeHarness, remaining)),
        'a deletion must reach the same index a rebuild would'
      );
    }
  },
  {
    name: 'a co-occurrence edge DISAPPEARS when the last chapter sharing it stops sharing it',
    async run(makeHarness) {
      const built = await build(makeHarness);
      // krishna and arjuna co-occur in ch-01 and ch-04. Strip both.
      built.source.put(file(CH(1), 'Only: [[char:krishna|Кришна]].'));
      built.source.put(file(CH(4), 'Only: [[char:krishna|Кришна]].'));
      await pushAndSettle(built, { path: CH(1), type: 'updated' }, { path: CH(4), type: 'updated' });

      const pair = built.store
        .getRelations({ origin: 'derived' })
        .find(relation => relation.sourceId === 'arjuna' && relation.targetId === 'krishna');
      check(
        pair === undefined,
        'an implementation that only UPSERTS derived relations leaves this edge behind — an upsert ' +
          'cannot express a deletion, which is why the derived layer is recomputed wholesale'
      );
    }
  },

  // -- ОВ-1 group C: the sweeps and the watcher path -----------------------
  {
    name: 'ОВ-1 C1 — the hash-authoritative sweep re-indexes a file whose mtime and size were RESTORED',
    async run(makeHarness) {
      const built = await build(makeHarness, manuscript().map(item =>
        item.path === CH(2) ? file(CH(2), SAME_LENGTH_ORIGINAL) : item
      ));
      const original = built.session.documentOf(CH(2))!;

      // The perturbation this tooth is FOR: the bytes change, and `mtime` and
      // `size` are put back exactly as they were. A `git stash pop` does this,
      // and so does any editor that preserves timestamps.
      const edited = file(CH(2), SAME_LENGTH_EDITED, {
        mtimeMs: original.mtimeMs,
        sizeBytes: original.sizeBytes
      });
      equal(edited.sizeBytes, original.sizeBytes, 'the fixture must keep the SIZE identical');
      equal(edited.mtimeMs, original.mtimeMs, 'and the mtime identical');
      check(edited.contentHash !== original.contentHash, 'while the bytes really did change');
      built.source.put(edited);

      const answer = await built.maintainer.sweep('hash-authoritative');
      deepEqual(
        answer.data.documentsReindexed,
        [CH(2)],
        'an implementation whose freshness key is the (size, mtime) prefilter cannot see this change ' +
          'at all, and an index with no content_hash cannot either'
      );
      equal(built.session.documentOf(CH(2))!.contentHash, edited.contentHash, 'the new hash is stored');
    }
  },
  {
    name: 'ОВ-1 C2 — the ROUTINE TTL sweep does NOT re-index that same file, and never even reads it',
    async run(makeHarness) {
      const built = await build(makeHarness, manuscript().map(item =>
        item.path === CH(2) ? file(CH(2), SAME_LENGTH_ORIGINAL) : item
      ));
      const original = built.session.documentOf(CH(2))!;
      built.source.put(
        file(CH(2), SAME_LENGTH_EDITED, { mtimeMs: original.mtimeMs, sizeBytes: original.sizeBytes })
      );
      built.source.resetReads();

      const answer = await built.maintainer.sweep('prefiltered');
      deepEqual(
        answer.data.documentsReindexed,
        [],
        'the residual false-negative window of the prefilter is FIXED BEHAVIOUR, not an accident — ' +
          'without this case C1 would read as "always hash", and the cold-pass budget cannot afford that'
      );
      check(
        !built.source.reads.includes(CH(2)),
        'the prefiltered sweep must not even READ a file whose (size, mtime) match — that read is the ' +
          'entire cost it exists to avoid'
      );
      equal(built.session.documentOf(CH(2))!.contentHash, original.contentHash, 'the old hash stands');
    }
  },
  {
    name: 'ОВ-1 C4 — on the WATCHER path a restored mtime and size do not hide a change (regression)',
    async run(makeHarness) {
      const built = await build(makeHarness, manuscript().map(item =>
        item.path === CH(2) ? file(CH(2), SAME_LENGTH_ORIGINAL) : item
      ));
      const original = built.session.documentOf(CH(2))!;
      built.source.put(
        file(CH(2), SAME_LENGTH_EDITED, { mtimeMs: original.mtimeMs, sizeBytes: original.sizeBytes })
      );

      await pushAndSettle(built, { path: CH(2), type: 'updated' });
      const row = built.session.documentOf(CH(2))!;
      check(
        row.contentHash !== original.contentHash,
        'the watcher SAID this file changed and the file was read on the strength of that; applying the ' +
          'prefilter here would discard the read and the change with it (ОВ-1: "Где префильтр НЕ нужен: ' +
          'на пути вотчера")'
      );
    }
  },

  // -- ОВ-3: the move ------------------------------------------------------
  {
    name: 'ОВ-3 tooth 1 — a delete/create pair in ONE window is a MOVE: same doc_id, no trace of the old path',
    async run(makeHarness) {
      const built = await build(makeHarness);
      const before = built.session.documentOf(CH(2))!;
      const entitiesBefore = built.store.findEntities().map(entity => entity.id);

      built.source.move(CH(2), 'content/ch-02-renamed.md');
      await pushAndSettle(
        built,
        { path: CH(2), type: 'deleted' },
        { path: 'content/ch-02-renamed.md', type: 'added' }
      );

      const after = built.session.documentOf('content/ch-02-renamed.md');
      check(after !== undefined, 'the new path is indexed');
      equal(
        after.docId,
        before.docId,
        'the doc_id must SURVIVE — that is the only thing pairing buys, and an implementation that ' +
          'applied the pair as delete-then-insert gets a new one here'
      );
      equal(built.session.documentOf(CH(2)), undefined, 'the old path is gone');
      equal(built.store.getMentions({ relPath: CH(2) }).length, 0, 'no mention still cites the old path');
      for (const relation of built.store.getRelations()) {
        for (const evidence of relation.evidence) {
          check(evidence.path !== CH(2), `a relation is still evidenced by the old path ${CH(2)}`);
        }
      }
      deepEqual(built.store.findEntities().map(entity => entity.id), entitiesBefore, 'entity ids are untouched');
      check(
        built.store.getMentions({ relPath: 'content/ch-02-renamed.md' }).length > 0,
        'the mentions moved with the row rather than being dropped'
      );
    }
  },
  {
    name: 'ОВ-3 tooth 2 (REJECTING) — a move WITH an edit must NOT pair: it is a delete plus an add',
    async run(makeHarness) {
      const built = await build(makeHarness);
      const before = built.session.documentOf(CH(2))!;

      built.source.remove(CH(2));
      built.source.put(file('content/ch-02-renamed.md', 'Moved and edited: [[char:arjuna|Арджуна]].'));
      const answer = await built.maintainer.applyChanges([
        { path: CH(2), type: 'deleted' },
        { path: 'content/ch-02-renamed.md', type: 'added' }
      ]);

      deepEqual(
        answer.data.documentsMoved,
        [],
        'the hashes DIFFER, so nothing may pair — an implementation pairing by BASENAME pairs here, ' +
          'skips extraction, and keeps the OLD text\'s mentions under the new path'
      );
      deepEqual(answer.data.documentsRemoved, [CH(2)], 'the old path was removed');
      deepEqual(answer.data.documentsReindexed, ['content/ch-02-renamed.md'], 'and the new one extracted');
      deepEqual(
        built.store.getMentions({ relPath: 'content/ch-02-renamed.md' }).map(mention => mention.entityId),
        ['arjuna'],
        'the mentions come from the NEW text, which is the fact a name-keyed pairing would destroy'
      );
      const after = built.session.documentOf('content/ch-02-renamed.md')!;
      check(after.contentHash !== before.contentHash, 'and the stored hash is the new one');
    }
  },
  {
    name: 'ОВ-3 tooth 3 — two chapters with IDENTICAL content moved at once still equal a full rebuild',
    async run(makeHarness) {
      // ch-02 and ch-03 are given the SAME text, so both hashes collide and the
      // pairing has a genuine choice to make. Whichever way it falls, the index
      // must be the one a rebuild produces — which is why the hash was chosen as
      // the key in the first place.
      const twins = manuscript().map(item =>
        item.path === CH(2) || item.path === CH(3) ? file(item.path, 'Twin: [[char:krishna|Кришна]].') : item
      );
      const built = await build(makeHarness, twins);
      built.source.move(CH(2), 'content/ch-02-moved.md');
      built.source.move(CH(3), 'content/ch-03-moved.md');

      await pushAndSettle(
        built,
        { path: CH(2), type: 'deleted' },
        { path: CH(3), type: 'deleted' },
        { path: 'content/ch-02-moved.md', type: 'added' },
        { path: 'content/ch-03-moved.md', type: 'added' }
      );

      const expected = twins
        .filter(item => item.path !== CH(2) && item.path !== CH(3))
        .concat([
          file('content/ch-02-moved.md', 'Twin: [[char:krishna|Кришна]].'),
          file('content/ch-03-moved.md', 'Twin: [[char:krishna|Кришна]].')
        ]);
      deepEqual(
        fingerprint(built.store),
        fingerprint(await fullRebuildOf(makeHarness, expected)),
        'an ambiguous pairing must still land on the rebuild-equivalent index'
      );
    }
  },
  {
    name: "a moved ENTITY CARD keeps its id, and its sourcePath follows it",
    async run(makeHarness) {
      const built = await build(makeHarness);
      built.source.move(KRISHNA_CARD, 'entities/characters/krishna-renamed.yaml');
      await pushAndSettle(
        built,
        { path: KRISHNA_CARD, type: 'deleted' },
        { path: 'entities/characters/krishna-renamed.yaml', type: 'added' }
      );

      const entity = built.store.getEntity('krishna');
      check(entity !== undefined, 'the id from the YAML survives a rename — it never came from the path');
      equal(
        entity.sourcePath,
        'entities/characters/krishna-renamed.yaml',
        'and `sourcePath` follows the file. It is DENORMALIZED (a JSON payload column in SQLite, a field ' +
          'on the object here), so a move that only re-keyed the document row would leave this pointing ' +
          'at a file that no longer exists — a dead navigation target no test of `document` would catch'
      );
      check(
        built.store.getMentions({ entityId: 'krishna' }).some(mention => mention.resolved),
        'and references to it still resolve'
      );
    }
  },

  // -- the single guard ----------------------------------------------------
  {
    name: 'R-6 — an explicit rebuild DURING a watcher batch serializes, and no consumer sees `ready` between them',
    async run(makeHarness) {
      const built = await build(makeHarness);
      built.source.put(file(CH(2), 'Changed by the watcher: [[char:arjuna|Арджуна]].'));

      let release = (): void => undefined;
      built.source.gate = new Promise<void>(resolve => {
        release = resolve;
      });

      // The watcher's window closes and its pass starts — and immediately
      // suspends on the gated read.
      built.watcher.push({ path: CH(2), type: 'updated' });
      built.scheduler.advance(built.configStore.resolve(CONTRACT_ROOT).debounceMs);

      const observed: string[] = [];
      observed.push(built.session.state().state);

      // The third writer arrives mid-flight. `NoteIndexService`'s pattern
      // protects watcher-against-watcher only; this is the case it does not
      // cover, and the plan names it R-6.
      const rebuild = built.maintainer.rebuildNow();
      observed.push(built.session.state().state);
      await Promise.resolve();
      observed.push(built.session.state().state);

      built.source.gate = undefined;
      release();
      await rebuild;
      await built.maintainer.flush();

      for (const state of observed) {
        equal(state, 'rebuilding', 'a consumer polling across the two passes must never be told `ready`');
      }
      equal(
        built.maintainer.maxConcurrentPasses,
        1,
        'two passes must never be open at once — an implementation with no guard reaches 2 here'
      );
      equal(built.session.state().state, 'ready', 'and the drained queue reports ready');
      deepEqual(
        fingerprint(built.store),
        fingerprint(
          await fullRebuildOf(
            makeHarness,
            manuscript().map(item =>
              item.path === CH(2) ? file(CH(2), 'Changed by the watcher: [[char:arjuna|Арджуна]].') : item
            )
          )
        ),
        'and the serialized result is ONE index, not two interleaved ones'
      );
    }
  },
  {
    name: 'fifty changes inside ONE debounce window are ONE pass and ONE transaction',
    async run(makeHarness) {
      const files = manuscript();
      for (let index = 5; index <= 54; index++) {
        files.push(file(`content/ch-${String(index).padStart(2, '0')}.md`, `Bulk: [[char:krishna|Кришна]] ${index}.`));
      }
      const built = await build(makeHarness, files);
      const before = built.store.lifecycle().generation;

      const changes: { path: string; type: 'updated' }[] = [];
      for (let index = 5; index <= 54; index++) {
        const path = `content/ch-${String(index).padStart(2, '0')}.md`;
        built.source.put(file(path, `Bulk edited: [[char:arjuna|Арджуна]] ${index}.`));
        changes.push({ path, type: 'updated' });
      }
      // Delivered as fifty SEPARATE notifications, which is what a real watcher
      // does — the coalescing has to happen in the accumulator, not by trusting
      // one batch to be complete.
      for (const change of changes) {
        built.watcher.push(change);
      }
      built.scheduler.advance(built.configStore.resolve(CONTRACT_ROOT).debounceMs);
      await built.maintainer.flush();

      equal(
        built.store.lifecycle().generation,
        before + 1,
        'an implementation that re-armed nothing and ran one pass per event commits fifty times here'
      );
      equal(built.store.getMentions({ relPath: 'content/ch-30.md' })[0]?.entityId, 'arjuna', 'and it applied them');
    }
  },

  // -- escalation and its boundary -----------------------------------------
  {
    name: 'an edited ENTITY CARD escalates to a full rebuild — and a broken reference becomes resolved',
    async run(makeHarness) {
      const withBroken = manuscript().map(item =>
        item.path === CH(3) ? file(CH(3), 'Waiting for [[char:balarama|Баларама]].') : item
      );
      const built = await build(makeHarness, withBroken);
      equal(
        built.store.getMentions({ relPath: CH(3), brokenOnly: true }).length,
        1,
        'the reference starts out broken'
      );

      built.source.put(file('entities/characters/balarama.yaml', ['id: balarama', 'name: Баларама'].join('\n')));
      const answer = await pushAndSettle(built, {
        path: 'entities/characters/balarama.yaml',
        type: 'added'
      }).then(() => built.store.getMentions({ relPath: CH(3), brokenOnly: true }));

      deepEqual(
        answer,
        [],
        'a NEW CARD flips resolvedness in a chapter NOBODY TOUCHED. The index stores no text, so that ' +
          'chapter cannot be re-resolved without re-reading it — which is why a card change escalates ' +
          'to a full rebuild instead of pretending to be an increment'
      );
    }
  },
  {
    name: 'the escalation is REPORTED, not hidden — `mode` says `rebuild`',
    async run(makeHarness) {
      const built = await build(makeHarness);
      built.source.put(file(KRISHNA_CARD, ['id: krishna', 'name: Кришна', 'aliases:', '  - Говинда'].join('\n')));
      const answer = await built.maintainer.updateDocument(KRISHNA_CARD);
      equal(answer.data.mode, 'rebuild', 'a caller must be able to tell an increment from a rebuild');
      check(answer.data.rebuild !== undefined, 'and the rebuild report travels with it');
    }
  },
  {
    name: 'an edit to `sources/**` costs NOTHING — no pass, no transaction (the B12 boundary, on the write path)',
    async run(makeHarness) {
      const built = await build(makeHarness);
      const before = built.store.lifecycle().generation;
      built.source.put(
        file('sources/citations.yaml', ['citations:', '  - id: gita-2-2', '    target: content/ch-02.md'].join('\n'))
      );
      await pushAndSettle(built, { path: 'sources/citations.yaml', type: 'updated' });
      equal(
        built.store.lifecycle().generation,
        before,
        'a file the index refuses to READ must also cost nothing to WRITE. An implementation that ' +
          'escalated every unclassifiable change would rebuild the manuscript on every citation save'
      );
    }
  },

  // -- ОВ-6: staleness -----------------------------------------------------
  {
    name: 'ОВ-6 — a lost watcher is `stale/watcher-lost` AT ONCE, and only a sweep earns `ready` back',
    async run(makeHarness) {
      const built = await build(makeHarness);
      built.watcher.fail('inotify limit reached');
      const stale = built.session.state();
      equal(stale.state, 'stale', 'the index cannot promise freshness from this instant');
      check(stale.state === 'stale' && stale.staleReason === 'watcher-lost', 'and says which kind');

      // A watcher that comes back does NOT restore `ready` by itself: the events
      // missed while it was down are never re-delivered, so freshness is a claim
      // nobody has checked until a sweep checks it.
      built.watcher.push({ path: CH(1), type: 'updated' });
      built.scheduler.advance(built.configStore.resolve(CONTRACT_ROOT).debounceMs);
      await built.maintainer.flush();
      equal(
        built.session.state().state,
        'stale',
        'events flowing again do not clear it — an implementation that cleared the staleness on the ' +
          'first event after a failure would announce a freshness nobody verified'
      );

      await built.maintainer.recoverWatcher();
      equal(built.session.state().state, 'ready', 'one hash-authoritative sweep does');
    }
  },
  {
    name: 'ОВ-6 — an unreadable document is `partial-update-failed`, and it clears when the file goes away',
    async run(makeHarness) {
      const built = await build(makeHarness);
      built.source.remove(CH(2));
      // Reported as UPDATED while absent: the watcher saw a change and the file
      // was gone by the time the window closed. Unreadable, not deleted.
      await built.maintainer.updateDocument(CH(2));
      const stale = built.session.state();
      equal(stale.state, 'stale', 'one document failing does not take the index down');
      check(
        stale.state === 'stale' && stale.staleReason === 'partial-update-failed',
        'and the rest of the index is intact, which is what this reason MEANS'
      );

      // ОВ-6's exit condition, second half: the document DISAPPEARED.
      await pushAndSettle(built, { path: CH(2), type: 'deleted' });
      equal(
        built.session.state().state,
        'ready',
        'a file nobody can read and nobody deletes would otherwise pin the index to stale forever'
      );
    }
  },

  // -- configure(patch): ОВ-9б ---------------------------------------------
  {
    name: 'the watcher takes its INITIAL debounce window from the configuration',
    async run(makeHarness) {
      const harness = await makeHarness();
      harness.configStore.setRuntimeOverrides({ debounceMs: 1234, fallbackTtlMs: 60_000 }, CONTRACT_ROOT);
      const scheduler = new ManualTimerScheduler();
      const watcher = new TestNarrativeFileWatcher();
      const session = new NarrativeIndexSession({ store: harness.store, schemaVersion: SCHEMA_VERSION });
      const maintainer = new NarrativeIndexMaintainer({
        session,
        source: new InMemoryWorkspaceSource(manuscript()),
        config: () => harness.configStore.resolve(CONTRACT_ROOT),
        scheduler,
        watcher,
        rootPath: CONTRACT_ROOT
      });
      maintainer.start();
      // The fallback sweep is armed at start; the debounce window only on an event.
      deepEqual(scheduler.armedDelays, [60_000], 'the fallback sweep takes its window from the config too');
      watcher.push({ path: CH(1), type: 'updated' });
      deepEqual(
        scheduler.armedDelays,
        [60_000, 1234],
        'a hard-coded default would show up here as 400, and nothing else would ever notice'
      );
      maintainer.stop();
    }
  },
  {
    name: 'stop() disposes the watcher itself, not only its listeners (ISS-359)',
    async run(makeHarness) {
      // Regression fixture for ISS-359: `stop()` used to splice
      // `this.subscriptions`, which holds only the disposables
      // `onDidChangeFiles`/`onDidFail` return — "stop calling me back", never
      // "stop watching". `NodeNarrativeKnowledgeService.dispose()`'s own doc
      // comment promises the watcher itself is released; before this fix that
      // promise was false the moment a maintainer's `start()` was ever really
      // called by a running application (which, before ISS-359's main fix,
      // never happened — so nothing observed the gap).
      const harness = await makeHarness();
      const scheduler = new ManualTimerScheduler();
      const watcher = new TestNarrativeFileWatcher();
      const session = new NarrativeIndexSession({ store: harness.store, schemaVersion: SCHEMA_VERSION });
      const maintainer = new NarrativeIndexMaintainer({
        session,
        source: new InMemoryWorkspaceSource(manuscript()),
        config: () => harness.configStore.resolve(CONTRACT_ROOT),
        scheduler,
        watcher,
        rootPath: CONTRACT_ROOT
      });
      maintainer.start();
      equal(watcher.isDisposed, false, 'not disposed while the maintainer is running');
      maintainer.stop();
      equal(watcher.isDisposed, true, 'stop() must dispose the watcher, releasing its dispatcher registration');
      // Idempotent: a second stop() (e.g. from a caller that also disposes the
      // whole service on shutdown) must not throw.
      maintainer.stop();
      equal(watcher.isDisposed, true, 'still disposed after a second, idempotent stop()');
    }
  },
  {
    name: 'ОВ-9б tooth 3 — an IDEMPOTENT configure does not bump configVersion and does not recreate a timer',
    async run(makeHarness) {
      const built = await build(makeHarness);
      const armedBefore = built.scheduler.creations;

      const first = built.configurator.configure({ fallbackTtlMs: 120_000 }, CONTRACT_ROOT);
      const armedAfterFirst = built.scheduler.creations;
      const second = built.configurator.configure({ fallbackTtlMs: 120_000 }, CONTRACT_ROOT);

      deepEqual(second.effective, first.effective, 'the same patch gives the same effective config');
      deepEqual(second.applied, first.applied, 'and the same applied list');
      equal(
        second.configVersion,
        first.configVersion,
        'NOTHING CHANGED, so the version must not move — PreferenceService re-sends a value on every ' +
          'keystroke in a settings field, and a version that advanced per call would make "the config ' +
          'changed" indistinguishable from "somebody is typing"'
      );
      equal(
        built.scheduler.creations,
        armedAfterFirst,
        'and the fallback timer must not be RECREATED. Counted, not inferred from when it fires: an ' +
          'implementation that cancelled and re-armed an identical window is invisible to any ' +
          'observation of timing and obvious to this counter'
      );
      // The rejecting half. Without it, "never notify at all" would pass the
      // assertion above.
      check(
        armedAfterFirst > armedBefore,
        'a patch that REALLY changes the fallback TTL must re-arm the sweep — otherwise a shortened ' +
          'TTL would not take effect until the old, possibly hour-long, window expired'
      );
    }
  },
  {
    name: 'ОВ-9б tooth 4 — `{}` changes nothing; `{debounceMs: undefined}` RESETS to the next rung',
    async run(makeHarness) {
      const built = await build(makeHarness);
      const patched = built.configurator.configure({ debounceMs: 900 }, CONTRACT_ROOT);
      equal(patched.effective.debounceMs, 900, 'the override is in force');

      const empty = built.configurator.configure({}, CONTRACT_ROOT);
      equal(empty.effective.debounceMs, 900, 'an ABSENT key means "leave it alone"');
      deepEqual(empty.applied, [], 'and applies nothing');

      const reset = built.configurator.configure({ debounceMs: undefined }, CONTRACT_ROOT);
      check(
        reset.effective.debounceMs !== 900,
        'an EXPLICIT undefined means "drop my override". Tested with `\'key\' in patch` and never with ' +
          '`patch.key !== undefined` — under the second test these two calls are the same call, and ' +
          'resetting a setting to its default becomes inexpressible'
      );
      deepEqual(reset.applied, ['debounceMs'], 'a reset is an application, not a no-op');
    }
  },
  {
    name: 'ОВ-9б tooth 5 (REJECTING) — an out-of-range value is REFUSED, never clamped',
    async run(makeHarness) {
      const built = await build(makeHarness);
      const before = built.configStore.resolve(CONTRACT_ROOT).debounceMs;

      const answer = built.configurator.configure({ debounceMs: 90_000 }, CONTRACT_ROOT);
      deepEqual(answer.rejected, [{ key: 'debounceMs', reason: 'out-of-range' }], 'refused with a reason');
      deepEqual(answer.applied, [], 'and applied nothing');
      equal(
        answer.effective.debounceMs,
        before,
        'the previous value stands. A CLAMPED value would diverge silently from the number the settings ' +
          'UI shows, and nothing anywhere would say so'
      );
      check(
        answer.effective.debounceMs !== 60_000,
        'specifically, it must NOT have been clamped to the range maximum'
      );

      // Both ends, and the boundaries themselves, so "reject everything" fails.
      deepEqual(built.configurator.configure({ fallbackTtlMs: 999 }, CONTRACT_ROOT).rejected,
        [{ key: 'fallbackTtlMs', reason: 'out-of-range' }], 'below the floor');
      deepEqual(built.configurator.configure({ maxOpenWorkspaces: 33 }, CONTRACT_ROOT).rejected,
        [{ key: 'maxOpenWorkspaces', reason: 'out-of-range' }], 'above the ceiling');
      deepEqual(built.configurator.configure({ debounceMs: 0 }, CONTRACT_ROOT).rejected, [],
        'the inclusive floor is INSIDE the range — "reject everything" fails here');
      deepEqual(built.configurator.configure({ maxOpenWorkspaces: 32 }, CONTRACT_ROOT).rejected, [],
        'and so is the inclusive ceiling');
    }
  },
  {
    name: 'ОВ-9б — an unknown key is rejected while the REST of the patch is applied',
    async run(makeHarness) {
      const built = await build(makeHarness);
      const answer = built.configurator.configure(
        { debounceMs: 750, somethingFromANewerFrontend: true } as never,
        CONTRACT_ROOT
      );
      deepEqual(answer.rejected, [{ key: 'somethingFromANewerFrontend', reason: 'unknown-key' }], 'named');
      deepEqual(answer.applied, ['debounceMs'], 'and the rest went in');
      equal(answer.effective.debounceMs, 750, 'refusing the WHOLE patch would break every older frontend');
    }
  },
  {
    name: 'ОВ-9б — order does not matter: {a} then {b} equals {a, b}',
    async run(makeHarness) {
      const built = await build(makeHarness);
      built.configurator.configure({ debounceMs: 800 }, CONTRACT_ROOT);
      const stepwise = built.configurator.configure({ fallbackTtlMs: 90_000 }, CONTRACT_ROOT).effective;

      const other = await build(makeHarness);
      const together = other.configurator.configure(
        { fallbackTtlMs: 90_000, debounceMs: 800 },
        CONTRACT_ROOT
      ).effective;
      deepEqual(stepwise, together, 'configure is a TOTAL function of (current config, patch)');
    }
  },
  {
    name: 'ОВ-9б — `databasePath` is accepted and DEFERRED, and a path escaping the workspace is refused',
    async run(makeHarness) {
      const built = await build(makeHarness);
      const answer = built.configurator.configure({ databasePath: '.theia/other-index.db' }, CONTRACT_ROOT);
      deepEqual(
        answer.deferred,
        [{ key: 'databasePath', until: 'next-backend-start' }],
        'the file is already open and re-aiming it would drop the writer lock — so the frontend is told ' +
          'the change is real and not yet in force, instead of guessing that from a key description'
      );
      deepEqual(answer.applied, [], 'a deferred key is not an applied one');
      equal(answer.effective.databasePath, '.theia/other-index.db', 'while the value IS recorded');

      deepEqual(
        built.configurator.configure({ databasePath: '../outside.db' }, CONTRACT_ROOT).rejected,
        [{ key: 'databasePath', reason: 'out-of-range' }],
        'a path that climbs out of the workspace is refused: the database is a derivative cache OF THIS ' +
          'workspace, and one outside it is an orphan the moment the folder is deleted'
      );
      deepEqual(
        built.configurator.configure({ databasePath: '   ' }, CONTRACT_ROOT).rejected,
        [{ key: 'databasePath', reason: 'out-of-range' }],
        'and so is an empty one'
      );
    }
  },
  {
    name: 'ОВ-9б consequence 4 — a window IN FLIGHT finishes on the old value; the NEXT one uses the new',
    async run(makeHarness) {
      const built = await build(makeHarness);
      built.configurator.configure({ debounceMs: 1000 }, CONTRACT_ROOT);
      built.source.put(file(CH(2), 'First edit: [[char:arjuna|Арджуна]].'));
      built.watcher.push({ path: CH(2), type: 'updated' });
      const armedForFirst = built.scheduler.armedDelays[built.scheduler.armedDelays.length - 1];
      equal(armedForFirst, 1000, 'the window opened on the value in force');

      // Change it MID-WINDOW. The open window must not move.
      built.configurator.configure({ debounceMs: 50 }, CONTRACT_ROOT);
      built.scheduler.advance(60);
      equal(
        built.store.getMentions({ relPath: CH(2) })[0]?.entityId,
        'krishna',
        'the in-flight window must not have been shortened to 50ms and fired'
      );
      built.scheduler.advance(1000);
      await built.maintainer.flush();
      equal(built.store.getMentions({ relPath: CH(2) })[0]?.entityId, 'arjuna', 'it fired on its own schedule');

      built.source.put(file(CH(3), 'Second edit: [[char:arjuna|Арджуна]].'));
      built.watcher.push({ path: CH(3), type: 'updated' });
      equal(
        built.scheduler.armedDelays[built.scheduler.armedDelays.length - 1],
        50,
        'and the NEXT window picks the new value up, with nobody having had to notify anybody'
      );
    }
  },

  // -- ISS-360: the warm-up phase for a watcher that arms asynchronously --

  {
    name: 'ISS-360 — a watcher that arms asynchronously gets an immediate warm-up sweep, catching an edit ' +
      'that landed before it was provably armed',
    async run(makeHarness) {
      const harness = await makeHarness();
      const source = new InMemoryWorkspaceSource(manuscript());
      const scheduler = new ManualTimerScheduler();
      const watcher = new TestNarrativeFileWatcher();
      // The SAME promise both this case and the maintainer observe — a fresh
      // promise per call (a naive `whenReady = () => new Promise(...)`) would
      // let the two sides race on two different objects.
      let resolveArmed!: () => void;
      const armedSignal = new Promise<void>(resolve => { resolveArmed = resolve; });
      watcher.whenReady = () => armedSignal;
      const session = new NarrativeIndexSession({
        store: harness.store,
        schemaVersion: SCHEMA_VERSION,
        now: () => 1_700_000_500_000
      });
      const maintainer = new NarrativeIndexMaintainer({
        session,
        source,
        config: () => harness.configStore.resolve(CONTRACT_ROOT),
        scheduler,
        watcher,
        rootPath: CONTRACT_ROOT,
        now: () => scheduler.now
      });
      maintainer.start();
      await maintainer.rebuildNow();

      // The edit ISS-360 measured as lost outright: it happens BEFORE the
      // watcher can attest to being armed, and no event will ever be delivered
      // for it — only a reconcile pass can find it.
      const before = session.documentOf(CH(2))!.contentHash;
      source.put(file(CH(2), 'Edited before the watcher armed: [[char:arjuna|Арджуна]].'));

      const armedDelaysBeforeReady = [...scheduler.armedDelays];
      resolveArmed();
      // Both this reaction and the maintainer's own are attached to the SAME
      // promise, the maintainer's FIRST (during `start()`, above); promise
      // reactions run in attachment order, so awaiting it here guarantees the
      // maintainer's warm-up reaction — which enqueues the sweep synchronously
      // — has already run by the time control returns.
      await armedSignal;
      await maintainer.flush();

      check(
        session.documentOf(CH(2))!.contentHash !== before,
        'the immediate warm-up pass must catch the edit — no event was ever pushed to this watcher in ' +
          'this case, so only a reconcile pass could have seen it'
      );
      check(
        scheduler.armedDelays.length > armedDelaysBeforeReady.length,
        'and a short-interval warm-up timer must be armed too, distinct from the long fallback sweep ' +
          'armed at start()'
      );
      equal(
        scheduler.armedDelays[scheduler.armedDelays.length - 1],
        WATCHER_WARMUP_SWEEP_INTERVAL_MS,
        'armed with the warm-up interval, not the (usually much longer) fallbackTtlMs'
      );
      maintainer.stop();
    }
  },
  {
    name: 'ISS-360 — a real event during the warm-up phase does NOT stop it: the phase runs its own course, ' +
      'serialized against the debounced watcher pass through the single guard',
    async run(makeHarness) {
      const harness = await makeHarness();
      const source = new InMemoryWorkspaceSource(manuscript());
      const scheduler = new ManualTimerScheduler();
      const watcher = new TestNarrativeFileWatcher();
      let resolveArmed!: () => void;
      const armedSignal = new Promise<void>(resolve => { resolveArmed = resolve; });
      watcher.whenReady = () => armedSignal;
      const session = new NarrativeIndexSession({
        store: harness.store,
        schemaVersion: SCHEMA_VERSION,
        now: () => 1_700_000_500_000
      });
      const maintainer = new NarrativeIndexMaintainer({
        session,
        source,
        config: () => harness.configStore.resolve(CONTRACT_ROOT),
        scheduler,
        watcher,
        rootPath: CONTRACT_ROOT,
        now: () => scheduler.now
      });
      maintainer.start();
      await maintainer.rebuildNow();

      resolveArmed();
      await armedSignal;
      await maintainer.flush();
      const warmupArmsAfterImmediatePass = scheduler.armedDelays.filter(
        delay => delay === WATCHER_WARMUP_SWEEP_INTERVAL_MS
      ).length;
      equal(warmupArmsAfterImmediatePass, 1, 'exactly one warm-up interval timer is armed after the immediate pass');

      // A REAL event arrives DURING the warm-up phase. A Theia watcher covers a
      // whole subtree, and there is no guarantee every directory in it armed at
      // the same instant — this event proves coverage for the path it names,
      // not for the rest of the manuscript, so it must NOT read as "the
      // subscription is fully armed, stop reconciling" (see the maintainer's
      // own comment on `onFileChanges`).
      const before = session.documentOf(CH(3))!.contentHash;
      source.put(file(CH(3), 'Real event: [[char:arjuna|Арджуна]].'));
      watcher.push({ path: CH(3), type: 'updated' });
      scheduler.advance(harness.configStore.resolve(CONTRACT_ROOT).debounceMs);
      await drainSettled(maintainer);
      check(
        session.documentOf(CH(3))!.contentHash !== before,
        'the debounced watcher pass applies the real event normally, warm-up phase or not'
      );

      // Advance past several more warm-up intervals: the phase must KEEP
      // re-arming itself, unaffected by the event that just went through the
      // very same guard.
      scheduler.advance(WATCHER_WARMUP_SWEEP_INTERVAL_MS * 3);
      await drainSettled(maintainer);
      const warmupArmsAfterEvent = scheduler.armedDelays.filter(
        delay => delay === WATCHER_WARMUP_SWEEP_INTERVAL_MS
      ).length;
      check(
        warmupArmsAfterEvent > warmupArmsAfterImmediatePass,
        'the warm-up phase must keep re-arming across a real event — one event is not proof the whole ' +
          'subscription is armed'
      );
      check(
        maintainer.maxConcurrentPasses === 1,
        'the debounced watcher pass and the warm-up sweeps never run concurrently — the single guard ' +
          'serializes them exactly as it does an explicit rebuild against either'
      );
      maintainer.stop();
    }
  },
  {
    name: 'ISS-360 — the warm-up phase gives up after WATCHER_WARMUP_DURATION_MS and stops re-arming itself',
    async run(makeHarness) {
      const harness = await makeHarness();
      const source = new InMemoryWorkspaceSource(manuscript());
      const scheduler = new ManualTimerScheduler();
      const watcher = new TestNarrativeFileWatcher();
      let resolveArmed!: () => void;
      const armedSignal = new Promise<void>(resolve => { resolveArmed = resolve; });
      watcher.whenReady = () => armedSignal;
      const session = new NarrativeIndexSession({
        store: harness.store,
        schemaVersion: SCHEMA_VERSION,
        now: () => 1_700_000_500_000
      });
      const maintainer = new NarrativeIndexMaintainer({
        session,
        source,
        config: () => harness.configStore.resolve(CONTRACT_ROOT),
        scheduler,
        watcher,
        rootPath: CONTRACT_ROOT,
        now: () => scheduler.now
      });
      maintainer.start();
      await maintainer.rebuildNow();
      resolveArmed();
      await armedSignal;
      await maintainer.flush();

      // Drive the virtual clock past the warm-up deadline, one warm-up
      // interval at a time, WITHOUT ever pushing a real event — the exact "the
      // watcher never proves itself, and never fails either" case the
      // duration bound exists for. Each re-arm happens ASYNCHRONOUSLY (inside
      // a sweep's `.finally()`), so a single big `advance()` would not chain
      // through them the way it does for synchronous callbacks — hence the
      // step-and-flush loop. `pending` is not the termination signal: the long
      // `fallbackTtlMs` timer armed at `start()` stays pending throughout and
      // would make that count forever nonzero on its own.
      const countWarmupArms = () =>
        scheduler.armedDelays.filter(delay => delay === WATCHER_WARMUP_SWEEP_INTERVAL_MS).length;
      let armCount = countWarmupArms();
      equal(armCount, 1, 'exactly one warm-up interval timer armed after the immediate pass');
      let stabilizedAfter = -1;
      for (let iteration = 1; iteration <= 50; iteration++) {
        scheduler.advance(WATCHER_WARMUP_SWEEP_INTERVAL_MS);
        await drainSettled(maintainer);
        const next = countWarmupArms();
        if (next === armCount) {
          stabilizedAfter = iteration;
          break;
        }
        armCount = next;
      }
      check(
        stabilizedAfter > 0,
        'the warm-up phase must stop re-arming itself within a bounded number of intervals, not run forever'
      );
      equal(
        armCount,
        WATCHER_WARMUP_DURATION_MS / WATCHER_WARMUP_SWEEP_INTERVAL_MS,
        'exactly enough intervals to cover the warm-up duration, no more'
      );

      // Confirm it STAYS stopped: advancing further must not resume it.
      scheduler.advance(WATCHER_WARMUP_DURATION_MS);
      await drainSettled(maintainer);
      equal(
        countWarmupArms(),
        armCount,
        'once the warm-up phase has ended, no further short-interval timers are armed — only the long ' +
          'fallbackTtlMs sweep (already running since start()) still stands as insurance'
      );
      maintainer.stop();
    }
  }
];
