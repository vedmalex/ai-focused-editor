/**
 * `NarrativeIndexSession` — reading and full rebuild over a
 * {@link NarrativeIndexStore} (TASK-022 WP-4a).
 *
 * WHY THIS CLASS IS IN `src/common` AND NOT IN `src/node`. Everything WP-4a
 * delivers is a function of the store and of already-read text: which state to
 * report, what a query returns, what a passage's context is, and what a rebuild
 * writes. None of it needs a filesystem. Putting it here means the SAME body of
 * code runs under `bun` against the in-memory adapter and under real `node`
 * against SQLite, so every readiness case for this work package — a contract
 * case per reading method, a not-ready case per reading method, ОВ-2's eight
 * teeth and ОВ-1's five group-B teeth — is executed against BOTH adapters
 * instead of against whichever one the test file happened to reach. The node
 * layer keeps exactly what genuinely needs a disk: walking the workspace,
 * hashing files, converting URIs, and RPC.
 *
 * WHAT IT ADDS OVER THE STORE, AND WHY THE STORE COULD NOT HAVE IT. Three
 * session facts have no home in the port: whether a rebuild is in flight,
 * whether the last operation failed hard, and WHEN this instance first became
 * read-only. All three are inputs to `IndexState`, and the port may not name
 * `IndexState` at all (prohibition (e) half 2). So they live here, next to the
 * assembly that consumes them.
 *
 * WHAT A REBUILD IS IN THIS WORK PACKAGE, STATED PLAINLY. It is FULL: every
 * indexable file is re-extracted and the entity/mention/relation tables are
 * rewritten in one transaction. It has to be — extraction is a WORKSPACE-level
 * function (resolvedness needs every card, duplicate detection needs every
 * card) and the index deliberately stores no text, so there is nothing to reuse
 * a skipped file's mentions FROM. The two-step freshness key is still computed
 * and reported per document, because it is the thing WP-4b's sweeps and
 * incremental path consume, and because it is what makes "a touched `mtime`
 * over unchanged bytes is not a change" an assertion rather than an intention.
 */

import {
  extractNarrativeIndex,
  type ExtractedNarrativeIndex,
  type WorkspaceFile
} from './extraction';
import { classifyDocument } from './extraction/document-classification';
import { extractChapterMentions } from './extraction/chapter-extraction';
import { buildEntityCatalog } from './extraction/entity-catalog';
import { normalizeWorkspacePath } from './extraction/yaml-values';
import type { IndexUpdatePlan, NarrativeUpdateReport } from './narrative-index-update';
import {
  foldCoOccurrenceRelations,
  isRangeEvidence,
  isRelationBroken,
  wholeFileEvidence,
  type DuplicateEntityRecord,
  type EntityQuery,
  type EvidenceRange,
  type EvidenceRef,
  type IndexedDocument,
  type IndexedDocumentInput,
  type MentionQuery,
  type NarrativeDocumentKind,
  type NarrativeEntity,
  type NarrativeIndexStore,
  type NarrativeIndexWriter,
  type NarrativeMention,
  type NarrativeRelation,
  type RelationQuery
} from './graph';
import { assembleIndexState } from './index-state-assembly';
import type { IndexFailureReason } from './index-failure';
import type { IndexAbsentCause, IndexStaleReason, IndexState } from './index-state';
import { envelope, type Envelope } from './narrative-envelope';
import {
  DEFAULT_MAX_EVIDENCE_PER_SECTION,
  NARRATIVE_CONTEXT_SECTIONS,
  UNAVAILABLE_CONTEXT_SECTIONS,
  type NarrativeContextEntity,
  type NarrativeContextOptions,
  type NarrativeContextRelation,
  type NarrativeContextSection,
  type NarrativeDocumentContext,
  type NarrativeFinding,
  type OmittedInfo,
  type SectionAvailability
} from './narrative-context';

/** Code-point order — see {@link NarrativeIndexSession} and ISS-349. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Rebuild input and output
// ---------------------------------------------------------------------------

/**
 * One file, already read and measured by whoever owns the filesystem.
 *
 * THE TEXT IS PASSED IN RATHER THAN READ HERE, and that is what keeps this
 * whole class runnable under `bun`. It also means the caller decides what a
 * "file" is, which is how a test can build a 200-chapter manuscript without
 * touching a disk.
 */
export interface IndexableFile {
  /** Workspace-relative POSIX path. */
  path: string;
  /** URI of the same file. Only entity cards carry one into the index. */
  uri?: string;
  text: string;
  sizeBytes: number;
  mtimeMs: number;
  /** SHA-256 of the bytes, lowercase hex. */
  contentHash: string;
}

export interface RebuildOptions {
  /**
   * Epoch ms stamped onto every document as `indexedAt`.
   *
   * Injected rather than read from a clock: `src/common` has no clock by rule,
   * and a rebuild whose output depends on `Date.now()` cannot be compared
   * across two runs, which is exactly what WP-9a's rebuildability assertion
   * does.
   */
  indexedAt?: number;
  /**
   * Wipe the database down to a fresh schema before rebuilding.
   *
   * REFUSED while another process holds a LIVE writer lock — the store checks
   * at call time, and the check is why `resetForRebuild` is a port method
   * rather than a `DELETE` this class could issue.
   */
  fresh?: boolean;
}

/** What one rebuild did. Every number here is a fact a log or a test can use. */
export interface NarrativeRebuildReport {
  /** Documents written this pass, i.e. every file that classified as one. */
  documentsIndexed: number;
  /** Documents that were in the index and are no longer on disk. */
  documentsRemoved: number;
  /**
   * Documents whose bytes the freshness key proved IDENTICAL to the row already
   * indexed.
   *
   * A touched `mtime` over unchanged content lands here: the prefilter
   * `(sizeBytes, mtimeMs)` misses, the file is read and hashed, and
   * `contentHash` — the authority — matches. An implementation whose freshness
   * key is the prefilter alone reports such a file as changed, which is what
   * ОВ-1's tooth B3 refuses.
   *
   * These documents are still RE-EXTRACTED by this full rebuild; see the class
   * note. The list says what the key CONCLUDED, which is what WP-4b's
   * incremental path will act on.
   */
  unchangedDocuments: string[];
  entities: number;
  duplicateEntities: number;
  mentions: number;
  /** Relations read from cards — sources 2 and 3. */
  extractedRelations: number;
  /** Co-occurrence edges folded from the mentions — source 6. */
  derivedRelations: number;
  /** `manifest.yaml` was present, i.e. this workspace is a manuscript at all. */
  manifestPresent: boolean;
  /** Malformed `types.yaml`, cards and manifest, forwarded verbatim. */
  problems: {
    types: ExtractedNarrativeIndex['typeProblems'];
    cards: ExtractedNarrativeIndex['cardProblems'];
    manifest: ExtractedNarrativeIndex['manifestProblems'];
  };
}

/**
 * The document freshness key of tech_spec ОВ-1, as a decision.
 *
 * TWO STEPS, AND THE SECOND IS THE AUTHORITY:
 *
 *   1. `(sizeBytes, mtimeMs)` equal to the indexed row — the file is NOT read.
 *      One `stat`, and it is what keeps a cold pass inside its budget.
 *   2. Otherwise the file is read and hashed, and `contentHash` decides.
 *
 * WHAT THE HASH ACTUALLY BUYS is COST, not correctness, and ISS-310 corrected
 * the record on that: in the false-negative case (two writes in one second at
 * the same size) the PREFILTER HITS, so the hash is never consulted and the
 * change is missed either way. What the hash prevents is re-extracting a whole
 * manuscript after `git checkout`/`clone`/`stash pop` rewrites every `mtime` —
 * and it is the pairing key for delete/create detection in WP-4b.
 *
 * `hashAuthoritative` SKIPS STEP 1. That is the mode ОВ-6 requires for the
 * sweep that leaves `watcher-lost`: changes arrived unseen precisely because
 * the watcher was down, so declaring freshness on a prefilter would be
 * declaring freshness nobody checked. It is WP-4b's caller, named here so the
 * two modes live in one function rather than in two that drift.
 */
export function documentNeedsReindex(
  indexed: Pick<IndexedDocument, 'sizeBytes' | 'mtimeMs' | 'contentHash'> | undefined,
  candidate: Pick<IndexableFile, 'sizeBytes' | 'mtimeMs' | 'contentHash'>,
  options: { hashAuthoritative?: boolean } = {}
): boolean {
  if (indexed === undefined) {
    return true;
  }
  if (
    options.hashAuthoritative !== true &&
    indexed.sizeBytes === candidate.sizeBytes &&
    indexed.mtimeMs === candidate.mtimeMs
  ) {
    return false;
  }
  return indexed.contentHash !== candidate.contentHash;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface NarrativeIndexSessionOptions {
  store: NarrativeIndexStore;
  /**
   * Schema version of the store behind this session, for `indexVersion`.
   *
   * PASSED IN rather than imported: the constant lives beside the DDL in
   * `src/node`, and prohibition (b) forbids `src/common` from reaching it.
   * Declaring a second copy here would be two editions of one number, which is
   * the failure this task has paid for repeatedly. The in-memory adapter has no
   * schema at all, so there is nothing to read it from either.
   */
  schemaVersion: number;
  /** Injected clock. `src/common` has none of its own. */
  now?: () => number;
  /**
   * Set when the workspace is known NOT to be a manuscript.
   *
   * Decided before a store is ever opened, so it cannot come from the store.
   */
  absentCause?: IndexAbsentCause;
}

export interface ContextRequest {
  /** The URI the caller asked about, echoed back into the result. */
  documentUri: string;
  /** The same document as the index keys it. */
  relPath: string;
  options?: NarrativeContextOptions;
}

export class NarrativeIndexSession {
  private readonly store: NarrativeIndexStore;
  private readonly schemaVersion: number;
  private readonly now: () => number;
  private readonly absentCause: IndexAbsentCause | undefined;

  /**
   * How many maintenance passes are open, NOT a boolean (TASK-022 WP-4b).
   *
   * A COUNTER BECAUSE PASSES NEST. `rebuild()` opens one around its own
   * transaction; the maintainer opens one around a whole QUEUE of them, so that
   * a consumer polling between an incremental batch and the explicit rebuild
   * queued behind it never sees `ready` over a half-applied manuscript. With a
   * boolean the inner pass would clear the outer one's flag on the way out, and
   * that momentary `ready` is exactly what plan WP-4b's first readiness case
   * forbids.
   */
  private passDepth = 0;
  private failure: IndexFailureReason | undefined;
  private serviceStale: { reason: Exclude<IndexStaleReason, 'foreign-writer'>; since: number } | undefined;
  private readOnlySince: number | undefined;
  /**
   * Documents whose read failed and has not since succeeded or gone away.
   *
   * A SET AND NOT A FLAG, because ОВ-6's exit condition is per document: the
   * index leaves `partial-update-failed` when THAT document updates successfully
   * or disappears from disk. With a flag, one unreadable file and one repaired
   * file would be indistinguishable, and the index would either be stuck stale
   * or clear the staleness while a real failure was outstanding.
   */
  private readonly unreadable = new Set<string>();

  constructor(options: NarrativeIndexSessionOptions) {
    this.store = options.store;
    this.schemaVersion = options.schemaVersion;
    this.now = options.now ?? (() => Date.now());
    this.absentCause = options.absentCause;
  }

  // ---- state ------------------------------------------------------------

  /**
   * The envelope, assembled fresh on every call.
   *
   * NOT CACHED, and that is deliberate: the store's `readOnly` can flip
   * mid-session when a compare-and-set loses, and a consumer holding a cached
   * `ready` would keep asserting freshness it no longer has.
   */
  state(): IndexState {
    const lifecycle = this.store.lifecycle();
    // Remember the FIRST moment this instance was seen read-only, so that
    // `staleSince` is a timestamp rather than a value that moves with polling.
    if (lifecycle.readOnly && this.readOnlySince === undefined) {
      this.readOnlySince = this.now();
    }
    if (!lifecycle.readOnly) {
      this.readOnlySince = undefined;
    }
    return assembleIndexState({
      lifecycle,
      rebuilding: this.passDepth > 0,
      ...(this.failure !== undefined ? { failure: this.failure } : {}),
      ...(this.absentCause !== undefined ? { absent: this.absentCause } : {}),
      ...(this.serviceStale !== undefined ? { stale: this.serviceStale } : {}),
      ...(this.readOnlySince !== undefined ? { readOnlySince: this.readOnlySince } : {})
    });
  }

  /**
   * Record a hard failure, so the next state is `failed`.
   *
   * The reason is already sanitized when it gets here — building one needs
   * `node:path` and lives in `src/node`.
   */
  recordFailure(reason: IndexFailureReason): void {
    this.failure = reason;
  }

  /** Clear a recorded failure, e.g. after a successful rebuild. */
  clearFailure(): void {
    this.failure = undefined;
  }

  /** Record a service-side staleness (`watcher-lost`, `partial-update-failed`).
   *  The third reason is derived from the store and cannot be set from here. */
  recordStale(reason: Exclude<IndexStaleReason, 'foreign-writer'>): void {
    this.serviceStale = { reason, since: this.now() };
  }

  /** Clear a service-side staleness — WP-4b's sweep is what earns this. */
  clearStale(): void {
    this.serviceStale = undefined;
  }

  /** The stale reason this session is currently reporting, if any. */
  staleReason(): IndexStaleReason | undefined {
    return this.serviceStale?.reason;
  }

  /**
   * Open a maintenance pass: the index reports `rebuilding` until it closes.
   *
   * PUBLIC BECAUSE THE GUARD IS NOT IN THIS CLASS. WP-4b's serializer holds one
   * pass open across a whole queue drain, which is what keeps the intermediate
   * `ready` from ever being observable. Balanced by {@link endPass}, always in a
   * `finally`.
   */
  beginPass(): void {
    this.passDepth++;
  }

  /** Close a pass opened by {@link beginPass}. */
  endPass(): void {
    if (this.passDepth > 0) {
      this.passDepth--;
    }
  }

  // ---- reads ------------------------------------------------------------

  /**
   * One document row, or `undefined`.
   *
   * NO ENVELOPE, unlike every other read on this class, and the difference is a
   * boundary rather than an oversight: `IndexedDocument` is INTERNAL — it
   * carries `docId` and the per-document `generation`, neither of which appears
   * in any RPC result or in `NarrativeDocumentContext`. These two accessors
   * exist for the maintenance path in this package (the freshness key, and the
   * hash a deleted file is paired by), which is why they hand back the row and
   * not a consumer-facing envelope.
   */
  documentOf(relPath: string): IndexedDocument | undefined {
    return this.store.getDocument(normalizeWorkspacePath(relPath));
  }

  /** Every document row, by `relPath`, code point ascending. */
  documents(): IndexedDocument[] {
    return this.store.listDocuments();
  }

  getEntity(entityId: string): Envelope<NarrativeEntity | undefined> {
    return envelope(this.state(), this.store.getEntity(entityId));
  }

  findEntities(query: EntityQuery = {}): Envelope<NarrativeEntity[]> {
    return envelope(this.state(), this.store.findEntities(query));
  }

  getMentions(query: MentionQuery = {}): Envelope<NarrativeMention[]> {
    return envelope(this.state(), this.store.getMentions(query));
  }

  getRelations(query: RelationQuery = {}): Envelope<NarrativeRelation[]> {
    return envelope(this.state(), this.store.getRelations(query));
  }

  /** Entity ids defined by more than one card. Feeds the `findings` section and
   *  Book Doctor alike. */
  getDuplicateEntities(): Envelope<DuplicateEntityRecord[]> {
    return envelope(this.state(), this.store.getDuplicateEntities());
  }

  /**
   * Everything the index can say about one passage (tech_spec ОВ-2).
   *
   * `data: undefined` MEANS "THIS DOCUMENT IS NOT IN THE INDEX", which is a
   * different statement from every section being empty. A `ready` envelope with
   * no data says: the index is current, and this file is not part of it — it is
   * not a chapter, or it lies outside the manuscript. Returning a context full
   * of `empty` sections instead would assert that a file the index never read
   * contains no narrative facts.
   */
  getContextForDocument(request: ContextRequest): Envelope<NarrativeDocumentContext | undefined> {
    const state = this.state();
    const relPath = normalizeWorkspacePath(request.relPath);
    const document = this.store.getDocument(relPath);
    if (document === undefined) {
      return envelope(state, undefined);
    }
    return envelope(state, this.buildContext(request.documentUri, document, request.options ?? {}, state));
  }

  // ---- full rebuild -----------------------------------------------------

  /**
   * Rebuild the whole index from `files`, in ONE transaction.
   *
   * ONE TRANSACTION IS THE POINT, not an optimization: the store advances its
   * generation under a compare-and-set at commit, so a rebuild split into
   * several transactions would expose half-written intermediate states to every
   * reader, each of them reporting `ready`. It is also why `rebuilding` is set
   * around the call — a consumer polling during the pass sees `rebuilding` and
   * not an authoritative empty index.
   *
   * A REFUSED REBUILD THROWS, and is never a quietly empty report. The store
   * raises `read-only` when this instance may not write and `rebuild-refused`
   * when a live foreign lock exists; both are the explicit-failure invariant of
   * ОВ-4 ("запись ОТКЛОНЯЕТСЯ явной ошибкой, никогда не ставится в очередь и
   * никогда не теряется молча"), and swallowing either here would put it back.
   */
  rebuild(files: readonly IndexableFile[], options: RebuildOptions = {}): Envelope<NarrativeRebuildReport> {
    const indexedAt = options.indexedAt ?? this.now();
    this.beginPass();
    let report: NarrativeRebuildReport;
    try {
      if (options.fresh === true) {
        this.store.resetForRebuild();
      }
      const normalized = files.map(file => ({ ...file, path: normalizeWorkspacePath(file.path) }));
      const extracted = extractNarrativeIndex(
        normalized.map((file): WorkspaceFile => ({
          path: file.path,
          ...(file.uri !== undefined ? { uri: file.uri } : {}),
          text: file.text
        }))
      );
      report = this.store.transaction(writer =>
        this.writeRebuild(writer, normalized, extracted, indexedAt)
      );
      this.failure = undefined;
      this.serviceStale = undefined;
      this.unreadable.clear();
    } finally {
      // Closed BEFORE the state is assembled below: a finished pass that still
      // reported itself as `rebuilding` would tell the caller its own result is
      // provisional. The `finally` is what closes it when the transaction THREW.
      this.endPass();
    }
    return envelope(this.state(), report);
  }

  /**
   * Apply ONE incremental pass, in ONE transaction (TASK-022 WP-4b).
   *
   * IT TAKES FILES, NOT PATHS, for the same reason `rebuild` does: reading and
   * hashing needs a disk, and this class deliberately has none, so the entire
   * incremental path is executable under `bun` against the in-memory adapter and
   * under `node` against real SQLite from one body of code.
   *
   * WHY THE FRESHNESS CHECK HERE IS HASH-AUTHORITATIVE. Every file that reaches
   * this method has ALREADY been read — the watcher said it changed, or a sweep
   * decided to read it. The `(size, mtime)` prefilter exists to avoid reads, and
   * there is no read left to avoid; applying it anyway is what tech_spec ОВ-1's
   * tooth C4 refuses, because a file whose `mtime` and size were RESTORED (a
   * `git checkout` back and forth) would then be declared unchanged while its
   * bytes differ. The prefilter lives one layer up, in the routine sweep, where
   * it can actually save something — and ОВ-1 says so in as many words: "Где
   * префильтр НЕ нужен: на пути вотчера".
   *
   * THE ORDER OF WRITES IS LOAD-BEARING. Moves go first, because a rename can
   * free a path an addition is about to take. Removals go before upserts for the
   * mirror-image reason. Derived relations are recomputed LAST and WHOLESALE:
   * co-occurrence is a fold over every mention, so one chapter losing a
   * reference can DELETE an edge, and an upsert cannot express a deletion.
   */
  applyUpdate(plan: IndexUpdatePlan, options: RebuildOptions = {}): Envelope<NarrativeUpdateReport> {
    const indexedAt = options.indexedAt ?? this.now();
    this.beginPass();
    let report: NarrativeUpdateReport;
    try {
      // WHAT WOULD ACTUALLY BE WRITTEN, DECIDED BEFORE A TRANSACTION IS OPENED.
      // Both filters are pure reads, and doing them here rather than inside the
      // writer is what makes a no-op pass cost NOTHING — no transaction, so no
      // committed generation. That matters twice over: `generation` is a cache
      // key for gh#51 (`indexVersion` is `${schemaVersion}.${generation}`), so
      // advancing it over a save that changed no byte would invalidate every
      // consumer's cache for nothing; and a watcher event on a file the index
      // refuses to read — `sources/**`, `knowledge/**` — must be free, or every
      // citation save would churn the index.
      const toWrite = plan.upsert.filter(file =>
        documentNeedsReindex(this.store.getDocument(normalizeWorkspacePath(file.path)), file, {
          hashAuthoritative: true
        })
      );
      const unchanged = plan.upsert
        .map(file => normalizeWorkspacePath(file.path))
        .filter(path => !toWrite.some(file => normalizeWorkspacePath(file.path) === path));
      const toRemove = plan.remove.filter(path => this.store.getDocument(path) !== undefined);

      if (plan.moves.length === 0 && toWrite.length === 0 && toRemove.length === 0) {
        report = {
          mode: 'incremental',
          documentsReindexed: [],
          documentsRemoved: [],
          documentsMoved: [],
          unchangedDocuments: unchanged.sort(byCodePoint),
          mentionsWritten: 0,
          derivedRelations: this.store.getRelations({ origin: 'derived' }).length,
          unreadableDocuments: [...plan.unreadable].sort(byCodePoint)
        };
      } else {
        report = this.store.transaction(writer =>
          this.writeUpdate(writer, { ...plan, upsert: toWrite, remove: toRemove }, indexedAt, unchanged)
        );
      }
      for (const path of plan.upsert) {
        this.unreadable.delete(path.path);
      }
      for (const path of plan.remove) {
        // ОВ-6: `partial-update-failed` clears when the same document updates
        // successfully OR DISAPPEARS FROM DISK. The second half is why this loop
        // exists — a file nobody can read and nobody deletes would otherwise
        // pin the index to `stale` for the rest of the session.
        this.unreadable.delete(path);
      }
      for (const path of plan.unreadable) {
        this.unreadable.add(path);
      }
      if (this.unreadable.size > 0) {
        // A LOST WATCHER OUTRANKS A FAILED DOCUMENT, and is not overwritten by
        // one. `watcher-lost` says the index does not know what changed at all;
        // `partial-update-failed` says it knows exactly which one file it could
        // not read. Downgrading the first to the second would understate the
        // problem, and only a sweep can clear it.
        if (this.serviceStale?.reason !== 'watcher-lost') {
          this.recordStale('partial-update-failed');
        }
      } else if (this.serviceStale?.reason === 'partial-update-failed') {
        this.serviceStale = undefined;
      }
    } finally {
      this.endPass();
    }
    return envelope(this.state(), report);
  }

  private writeUpdate(
    writer: NarrativeIndexWriter,
    plan: IndexUpdatePlan,
    indexedAt: number,
    unchangedDocuments: readonly string[]
  ): NarrativeUpdateReport {
    const orderByPath = new Map(plan.chapters.map(chapter => [chapter.path, chapter.order]));
    const documentsMoved: { from: string; to: string }[] = [];
    for (const move of plan.moves) {
      const order = orderByPath.get(move.to.path);
      writer.moveDocument(move.from, move.to.path, {
        sizeBytes: move.to.sizeBytes,
        mtimeMs: move.to.mtimeMs,
        contentHash: move.to.contentHash,
        indexedAt,
        ...(order !== undefined ? { chapterOrder: order } : {}),
        manifestIncluded: order !== undefined
      });
      documentsMoved.push({ from: move.from, to: move.to.path });
    }

    const documentsRemoved: string[] = [];
    for (const relPath of plan.remove) {
      writer.deleteDocument(relPath);
      documentsRemoved.push(relPath);
    }

    // The catalog is rebuilt from the ENTITIES THE INDEX ALREADY HOLDS, not from
    // the cards on disk — which is what makes this an increment. It is sound
    // only because a change to a card never reaches this method: the maintainer
    // escalates such a batch to a full rebuild, precisely because resolvedness
    // is workspace-level.
    const { catalog } = buildEntityCatalog(this.store.findEntities(), plan.types);

    const documentsReindexed: string[] = [];
    let mentionsWritten = 0;
    for (const file of plan.upsert) {
      const path = normalizeWorkspacePath(file.path);
      const classification = classifyDocument(path, plan.types);
      if (classification === undefined) {
        continue;
      }
      const order = orderByPath.get(path);
      writer.putDocument({
        relPath: path,
        kind: classification.kind,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        contentHash: file.contentHash,
        indexedAt,
        ...(order !== undefined ? { chapterOrder: order } : {}),
        ...(classification.kind === 'chapter' ? { manifestIncluded: order !== undefined } : {})
      });
      writer.clearDocumentContent(path);
      for (const mention of extractChapterMentions({ path, text: file.text }, catalog)) {
        writer.putMention(mention);
        mentionsWritten++;
      }
      documentsReindexed.push(path);
    }

    writer.clearDerivedRelations();
    const derived = foldCoOccurrenceRelations(this.store.getMentions());
    for (const relation of derived) {
      writer.putRelation(relation);
    }

    return {
      mode: 'incremental',
      documentsReindexed: documentsReindexed.sort(byCodePoint),
      documentsRemoved: documentsRemoved.sort(byCodePoint),
      documentsMoved,
      unchangedDocuments: [...unchangedDocuments].sort(byCodePoint),
      mentionsWritten,
      derivedRelations: derived.length,
      unreadableDocuments: [...plan.unreadable].sort(byCodePoint)
    };
  }

  private writeRebuild(
    writer: NarrativeIndexWriter,
    files: readonly IndexableFile[],
    extracted: ExtractedNarrativeIndex,
    indexedAt: number
  ): NarrativeRebuildReport {
    // Which files the index actually holds. A file that classifies as NOTHING
    // — `sources/citations.yaml`, `sources/excerpts.jsonl`, `knowledge/**` —
    // never becomes a document, which is what makes ОВ-1's tooth B12 an
    // assertion about the pipeline rather than about a filter somewhere.
    const chapterByPath = new Map(extracted.chapters.map(chapter => [chapter.path, chapter]));
    const indexable: { file: IndexableFile; kind: NarrativeDocumentKind }[] = [];
    for (const file of files) {
      const classification = classifyDocument(file.path, extracted.effectiveTypes);
      if (classification === undefined) {
        continue;
      }
      indexable.push({ file, kind: classification.kind });
    }

    const previous = new Map(this.store.listDocuments().map(document => [document.relPath, document]));
    const unchangedDocuments: string[] = [];
    const present = new Set<string>();

    // Entities, mentions and relations go first — `clearAll` keeps documents,
    // so the document rows below are updated in place and their `doc_id`s (and
    // therefore every foreign key) stay stable across a rebuild.
    writer.clearAll();

    for (const { file, kind } of indexable) {
      present.add(file.path);
      if (!documentNeedsReindex(previous.get(file.path), file)) {
        unchangedDocuments.push(file.path);
      }
      const chapter = chapterByPath.get(file.path);
      const input: IndexedDocumentInput = {
        relPath: file.path,
        kind,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        contentHash: file.contentHash,
        indexedAt,
        // `chapterOrder` is ABSENT for a `content/` chapter the manifest does
        // not list, and that absence is the value: the file is still indexed
        // (its mentions are real) but it has no provable position, which is
        // what the spoiler-safe rule keys on.
        ...(chapter !== undefined ? { chapterOrder: chapter.order } : {}),
        ...(kind === 'chapter' ? { manifestIncluded: chapter !== undefined } : {})
      };
      writer.putDocument(input);
    }

    let documentsRemoved = 0;
    for (const relPath of previous.keys()) {
      if (!present.has(relPath)) {
        writer.deleteDocument(relPath);
        documentsRemoved++;
      }
    }

    for (const entity of extracted.entities) {
      writer.putEntity(entity);
    }
    for (const duplicate of extracted.duplicates) {
      writer.putDuplicateEntity(duplicate.entityId, duplicate.sourcePath);
    }
    for (const mention of extracted.mentions) {
      writer.putMention(mention);
    }
    for (const relation of extracted.relations) {
      writer.putRelation(relation);
    }

    // Source 6, last, because it is a fold OVER the mentions just written.
    const derived = foldCoOccurrenceRelations(extracted.mentions);
    for (const relation of derived) {
      writer.putRelation(relation);
    }

    return {
      documentsIndexed: indexable.length,
      documentsRemoved,
      unchangedDocuments: unchangedDocuments.sort(byCodePoint),
      entities: extracted.entities.length,
      duplicateEntities: extracted.duplicates.length,
      mentions: extracted.mentions.length,
      extractedRelations: extracted.relations.length,
      derivedRelations: derived.length,
      manifestPresent: extracted.manifestPresent,
      problems: {
        types: extracted.typeProblems,
        cards: extracted.cardProblems,
        manifest: extracted.manifestProblems
      }
    };
  }

  // ---- context assembly -------------------------------------------------

  private buildContext(
    documentUri: string,
    document: IndexedDocument,
    options: NarrativeContextOptions,
    state: IndexState
  ): NarrativeDocumentContext {
    const limit = options.maxEvidencePerSection ?? DEFAULT_MAX_EVIDENCE_PER_SECTION;
    const spoilerSafe = options.spoilerSafe !== false;
    const wanted = options.include === undefined ? undefined : new Set(options.include);
    const omitted: OmittedInfo[] = [];
    const want = (section: NarrativeContextSection): boolean =>
      wanted === undefined || wanted.has(section);

    // --- mentions inside the range ---------------------------------------
    const all = this.store.getMentions({ relPath: document.relPath });
    let inRange = all;
    if (options.range !== undefined) {
      const range = options.range;
      // A `whole-file` mention carries no coordinates, so it cannot be SHOWN to
      // fall inside a requested range. Dropping it silently would make a
      // front-matter reference disappear whenever a caller narrows the query;
      // it is counted instead, under the same reason a document of unknown
      // position gets, because it is the same fact about the same absence.
      const placeable = all.filter(mention => isRangeEvidence(mention.evidence));
      const unplaceable = all.length - placeable.length;
      inRange = placeable.filter(
        mention => isRangeEvidence(mention.evidence) && within(mention.evidence.range, range)
      );
      if (unplaceable > 0) {
        omitted.push({ section: 'mentions', count: unplaceable, reason: 'unknown-position' });
      }
    }

    const mentions = this.cap(inRange, limit, 'mentions', omitted, want('mentions'));

    // --- entities referenced there ---------------------------------------
    // Ordered by id, code point — the SAME order `findEntities` promises, so a
    // consumer merging the two lists needs one comparator and not two, and the
    // order does not depend on row ids the port never promised anything about.
    const firstEvidence = new Map<string, EvidenceRef>();
    for (const mention of inRange) {
      if (mention.resolved && !firstEvidence.has(mention.entityId)) {
        firstEvidence.set(mention.entityId, mention.evidence);
      }
    }
    const contextEntities: NarrativeContextEntity[] = [];
    for (const entityId of [...firstEvidence.keys()].sort(byCodePoint)) {
      const entity = this.store.getEntity(entityId);
      if (entity !== undefined) {
        contextEntities.push({ entity, evidence: firstEvidence.get(entityId)! });
      }
    }
    const entities = this.cap(contextEntities, limit, 'entities', omitted, want('entities'));
    const entityIds = new Set(contextEntities.map(item => item.entity.id));

    // --- relations incident to them --------------------------------------
    // Through `neighbourhood`, which is the port's NAMED traversal query and
    // the only read surface here that carries a real limit. ОВ-2 requires the
    // per-section cap to be a `LIMIT` at the source rather than a slice over a
    // materialized set, and depth 1 is precisely "direct neighbours".
    const relationsByKey = new Map<string, NarrativeContextRelation>();
    if (want('relations')) {
      for (const entityId of entityIds) {
        for (const relation of this.store.neighbourhood({ entityId, depth: 1, limit })) {
          relationsByKey.set(relationKey(relation), relation);
        }
      }
    }
    const allRelations = [...relationsByKey.values()].sort(
      (left, right) =>
        byCodePoint(left.sourceId, right.sourceId) ||
        byCodePoint(left.targetId, right.targetId) ||
        byCodePoint(left.relType, right.relType) ||
        byCodePoint(left.origin, right.origin)
    );
    const relations = this.cap(allRelations, limit, 'relations', omitted, want('relations'));

    // --- the same entities, earlier ---------------------------------------
    const priorAppearances = this.collectPriorAppearances(
      document,
      entityIds,
      spoilerSafe,
      limit,
      omitted,
      want('priorAppearances')
    );

    // --- findings ---------------------------------------------------------
    const allFindings = want('findings') ? this.collectFindings(document, entityIds) : [];
    const findings = this.cap(allFindings, limit, 'findings', omitted, want('findings'));

    const sections = {} as Record<NarrativeContextSection, SectionAvailability>;
    const counts: Partial<Record<NarrativeContextSection, number>> = {
      entities: entities.length,
      mentions: mentions.length,
      relations: relations.length,
      priorAppearances: priorAppearances.length,
      findings: findings.length
    };
    for (const section of NARRATIVE_CONTEXT_SECTIONS) {
      const requires = UNAVAILABLE_CONTEXT_SECTIONS[section];
      if (requires !== undefined) {
        // NEVER `empty`. The capability does not exist, and an empty list would
        // assert that the passage has none of whatever it produces.
        sections[section] = { status: 'unavailable', requires };
        continue;
      }
      const count = counts[section] ?? 0;
      sections[section] = count > 0 ? { status: 'present', count } : { status: 'empty' };
    }

    return {
      documentUri,
      ...(options.range !== undefined ? { resolvedRange: options.range } : {}),
      document: {
        relPath: document.relPath,
        ...(document.chapterOrder !== undefined ? { chapterOrder: document.chapterOrder } : {}),
        manifestIncluded: document.manifestIncluded
      },
      entities,
      mentions,
      relations,
      priorAppearances,
      findings,
      sections,
      omitted,
      indexVersion: `${this.schemaVersion}.${state.generation}`
    };
  }

  /**
   * The same entities, in chapters positioned BEFORE this one.
   *
   * SPOILER-SAFE IS THE DEFAULT AND IT EXCLUDES THE UNPLACEABLE. A document the
   * manifest does not list has `chapterOrder` absent, so it cannot be PROVEN to
   * precede the current chapter — and neither can anything at all when the
   * CURRENT document is itself unlisted. Excluded documents are counted into
   * `omitted` with reason `unknown-position`, because a draft outside the
   * manifest disappearing without trace is the failure this whole envelope
   * discipline exists to prevent.
   *
   * THE RESIDUAL COST IS NAMED RATHER THAN HIDDEN: the port has no
   * chapter-order predicate, so this reads every mention of each context entity
   * before filtering. Bounding it at the query would take the FIRST N mentions,
   * which may all be in LATER chapters — a cheap answer that is wrong. Adding
   * such a predicate is a change to WP-3's port surface that WP-4a's readiness
   * block does not ask for; it is recorded as a finding instead of being
   * silently either done or forgotten.
   */
  private collectPriorAppearances(
    document: IndexedDocument,
    entityIds: ReadonlySet<string>,
    spoilerSafe: boolean,
    limit: number,
    omitted: OmittedInfo[],
    wanted: boolean
  ): NarrativeMention[] {
    if (!wanted || entityIds.size === 0) {
      return [];
    }
    const orderByPath = new Map(
      this.store.listDocuments().map(indexed => [indexed.relPath, indexed.chapterOrder])
    );
    const here = document.chapterOrder;
    const collected: NarrativeMention[] = [];
    let unplaceable = 0;
    for (const entityId of [...entityIds].sort(byCodePoint)) {
      for (const mention of this.store.getMentions({ entityId })) {
        const path = mention.evidence.path;
        if (path === document.relPath) {
          // The current chapter is the `mentions` section, not a prior one.
          continue;
        }
        const order = orderByPath.get(path);
        if (!spoilerSafe) {
          collected.push(mention);
          continue;
        }
        if (order === undefined || here === undefined) {
          unplaceable++;
          continue;
        }
        if (order < here) {
          collected.push(mention);
        }
      }
    }
    if (unplaceable > 0) {
      omitted.push({ section: 'priorAppearances', count: unplaceable, reason: 'unknown-position' });
    }
    return this.cap(collected, limit, 'priorAppearances', omitted, true);
  }

  /**
   * Findings from THREE sources, not two (F-TS3-1).
   *
   * The third — a relation end naming an id no card defines — is not a
   * duplicate of the first. A broken `ownership.owner` is a structural YAML
   * field with no prose and no range, so no `mention` row exists for it, and
   * today's `readOwnership` silently turns the unknown id into its own label.
   * Without this source the acceptance criterion "broken links are visible as
   * diagnostics" held for prose only.
   */
  private collectFindings(document: IndexedDocument, entityIds: ReadonlySet<string>): NarrativeFinding[] {
    const findings: NarrativeFinding[] = [];

    for (const mention of this.store.getMentions({ relPath: document.relPath, brokenOnly: true })) {
      findings.push({ kind: 'broken-mention', entityId: mention.entityId, evidence: mention.evidence });
    }

    for (const duplicate of this.store.getDuplicateEntities()) {
      if (!entityIds.has(duplicate.entityId)) {
        continue;
      }
      // ONE FINDING PER EXCLUDED CARD, pointing at the card being IGNORED.
      // That is the file the author has to open; pointing at the winner would
      // send them to the one that is already in effect.
      for (const excluded of duplicate.excludedRelPaths) {
        findings.push({
          kind: 'duplicate-entity',
          entityId: duplicate.entityId,
          evidence: wholeFileEvidence(excluded),
          keptRelPath: duplicate.keptRelPath
        });
      }
    }

    for (const relation of this.store.getRelations({ brokenOnly: true })) {
      if (!isRelationBroken(relation)) {
        continue;
      }
      // A broken end names an id no entity has, so it can never be in
      // `entityIds`. The relation belongs to this passage when its RESOLVED end
      // is an entity of the passage, or when the card that owns it is this very
      // document.
      const touchesPassage =
        (relation.sourceResolved && entityIds.has(relation.sourceId)) ||
        (relation.targetResolved && entityIds.has(relation.targetId)) ||
        relation.ownerPath === document.relPath;
      if (!touchesPassage) {
        continue;
      }
      const unresolvedEnd = !relation.sourceResolved && !relation.targetResolved
        ? 'both'
        : relation.sourceResolved
          ? 'target'
          : 'source';
      findings.push({
        kind: 'broken-relation',
        entityId: unresolvedEnd === 'source' ? relation.sourceId : relation.targetId,
        evidence: relation.evidence[0]!,
        relType: relation.relType,
        unresolvedEnd
      });
    }

    return findings;
  }

  /** Apply the per-section cap and record what it cut. */
  private cap<T>(
    items: readonly T[],
    limit: number,
    section: NarrativeContextSection,
    omitted: OmittedInfo[],
    wanted: boolean
  ): T[] {
    if (!wanted) {
      return [];
    }
    if (items.length <= limit) {
      return [...items];
    }
    omitted.push({ section, count: items.length - limit, reason: 'limit' });
    return items.slice(0, limit);
  }
}

/** Identity of a relation for de-duplication across several entity walks. */
function relationKey(relation: NarrativeRelation): string {
  return JSON.stringify([
    relation.sourceId,
    relation.targetId,
    relation.relType,
    relation.origin,
    relation.ownerPath ?? null
  ]);
}

/** Whether `inner` lies inside `outer`, both zero-based line/character. */
function within(inner: EvidenceRange, outer: EvidenceRange): boolean {
  return !before(inner.start, outer.start) && !before(outer.end, inner.end);
}

function before(left: { line: number; character: number }, right: { line: number; character: number }): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}
