/**
 * `NarrativeIndexStore` — the port every reader and writer of the index goes
 * through (TASK-022 WP-3, plan AD-2 / AD-6, tech_spec ОВ-1 / ОВ-4).
 *
 * WHY A PORT AT ALL, AND WHY IT DECIDES THE SHAPE OF THIS WORK PACKAGE. The
 * engine is Node's built-in `node:sqlite`, chosen empirically: it works in the
 * browser-backend and the Electron target with ZERO build changes, where
 * `better-sqlite3` needs four files edited and crashes `bun` outright. The price
 * is that `bun test` cannot resolve `node:sqlite` AT ALL — so the production
 * store can never be reached by the repository's main test run. A port with two
 * adapters is what makes that survivable: a runner-agnostic contract core runs
 * against an in-memory adapter under `bun`, and the SQLite adapter is exercised
 * by a real `node` run. Neither half is sufficient alone, and both are named as
 * such where they are defined.
 *
 * THE PORT LIVES INSIDE `src/common/graph/`, and that placement has a
 * consequence this file must respect: prohibition (e) half 2 forbids the graph
 * core from importing its neighbours in `src/common`. `IndexState`,
 * `IndexFailureReason` and `NarrativeMemoryConfig` are neighbours. So this port
 * NEVER speaks in those types:
 *
 *   - lifecycle is returned as PRIMITIVES ({@link NarrativeIndexStoreLifecycle});
 *     the service assembles `IndexState` from them OUTSIDE this folder (WP-4a);
 *   - failure is raised as {@link NarrativeIndexStoreError} with a small closed
 *     `kind`, which the service maps to `IndexFailureCode`. The store's
 *     vocabulary is deliberately its own and deliberately smaller — a store
 *     knows nothing about manifests or extraction, so it must not be able to
 *     name their failures.
 *
 * THE TRAVERSAL QUERIES ARE NAMED HERE, NOT COMPOSED BY THE CALLER. AD-6 costs
 * exactly this: the core may not formulate SQL, so any query that must be fast
 * has to appear in this interface by name. {@link NarrativeIndexStore.neighbourhood}
 * is the first of them; adding a second is a visible edit to this file rather
 * than an ad-hoc string somewhere.
 */

import type { NarrativeEntity } from './narrative-entity';
import type { NarrativeMention } from './narrative-mention';
import type { NarrativeOrigin } from './narrative-origin';
import type { NarrativeRelation } from './narrative-relation';

/**
 * What kind of file a document is.
 *
 * CLOSED, AND IT GAINED NO MEMBER FOR FRONT-MATTER MENTIONS. A reference that
 * appears only in a chapter's front matter has the same ends as one in its
 * prose and lives in the SAME FILE; a new kind would describe a new PLACE
 * inside an old document, not a new document.
 */
export type NarrativeDocumentKind = 'chapter' | 'entity-card' | 'manifest' | 'entity-types';

/** Every member of {@link NarrativeDocumentKind}, as data. */
export const NARRATIVE_DOCUMENT_KINDS = [
  'chapter',
  'entity-card',
  'manifest',
  'entity-types'
] as const satisfies readonly NarrativeDocumentKind[];

/**
 * A file as the index knows it.
 *
 * IDENTITY IS `relPath`. FRESHNESS IS TWO-STEP: `(sizeBytes, mtimeMs)` is a
 * prefilter costing one `stat`, and `contentHash` is the authority consulted
 * when the prefilter misses. The hash is not here for correctness — the
 * prefilter HITS in the false-negative case, so the hash is never consulted
 * there — it is here for COST (a mass `mtime` rewrite by `git checkout` must
 * not re-extract the manuscript) and because it is the pairing key for
 * delete/create detection.
 */
export interface IndexedDocumentInput {
  /** Workspace-relative POSIX path. The document's identity. */
  relPath: string;
  kind: NarrativeDocumentKind;
  sizeBytes: number;
  mtimeMs: number;
  /** SHA-256 of the file bytes, lowercase hex. */
  contentHash: string;
  /** Position in `manifest.yaml`; ABSENT for a file the manifest does not list. */
  chapterOrder?: number;
  /** Whether `manifest.yaml` lists this file. Defaults to `true`. */
  manifestIncluded?: boolean;
  /** Epoch ms at which this document was last read. */
  indexedAt: number;
}

/** A stored document, with the two fields the store assigns. */
export interface IndexedDocument extends IndexedDocumentInput {
  /** Store-assigned row id. Stable while the row lives, NOT across rebuilds. */
  docId: number;
  manifestIncluded: boolean;
  /**
   * The store generation at which THIS document was last written.
   *
   * PER-DOCUMENT, not global: re-indexing one file must leave its neighbours'
   * value untouched. That is the machine form of "a rebuild is an increment",
   * and it is the only reason this column exists separately from the global
   * counter in {@link NarrativeIndexStoreLifecycle.generation}.
   */
  generation: number;
}

/**
 * An entity id seen in more than one card — kept as a finding, not a crash.
 *
 * THE WINNER IS A NAMED FIELD, NOT A POSITION IN AN ARRAY. The first question
 * an author asks on seeing this diagnostic is "which of these two definitions
 * is the one in effect", and the answer is known at extraction time
 * ({@link EntityDuplicate.keptSourcePath}). The previous shape here was a flat
 * `relPaths: string[]`, which could say "these files collide" and nothing more;
 * the fold from extraction into storage was therefore LOSSY IN THE DIRECTION
 * THAT MATTERS — the extraction shape folds into this one, but this one could
 * not be unfolded back. Encoding the winner positionally ("element 0 won")
 * would have been the same loss wearing a convention.
 *
 * `keptRelPath` IS NOT A SECOND COPY OF A FACT THE INDEX ALREADY HOLDS. It is
 * read back OUT of the entity row — the card that owns `entity.entityId` IS the
 * winner, by definition, because `entity_id` is a primary key. So there is one
 * source of truth and no way for the two to disagree; what the store adds is
 * that the collision cannot outlive its winner (see
 * {@link NarrativeIndexWriter.putDuplicateEntity}).
 */
export interface DuplicateEntityRecord {
  /** The contested id. */
  entityId: string;
  /**
   * Workspace-relative path of the card whose definition the index HOLDS.
   *
   * Never absent: a duplicate row cannot exist without the entity row it lost
   * to, so "a collision with no winner" is unrepresentable rather than merely
   * unexpected.
   */
  keptRelPath: string;
  /**
   * Workspace-relative paths of the cards EXCLUDED by the collision.
   *
   * Never empty — a record with nothing excluded is not a collision — and never
   * containing {@link keptRelPath}. Sorted by code point, so the two adapters
   * return the same order: SQLite's default `BINARY` collation over UTF-8 and a
   * plain code-unit comparison in TypeScript agree for every character below
   * the astral planes, whereas `localeCompare` agrees with neither.
   */
  excludedRelPaths: string[];
}

/** Filter for {@link NarrativeIndexStore.findEntities}. */
export interface EntityQuery {
  type?: string;
  /** Case-insensitive prefix over name AND aliases. */
  namePrefix?: string;
  origin?: NarrativeOrigin;
  limit?: number;
}

/** Filter for {@link NarrativeIndexStore.getMentions}. At least one field is
 *  expected; an empty filter returns every mention, which is a real need during
 *  a rebuild and a mistake anywhere else. */
export interface MentionQuery {
  entityId?: string;
  /** Restrict to mentions inside one document. */
  relPath?: string;
  /** Only mentions whose id no card defines. */
  brokenOnly?: boolean;
}

/** Which end of a relation an entity id is being matched against. */
export type RelationDirection = 'outgoing' | 'incoming' | 'either';

/** Filter for {@link NarrativeIndexStore.getRelations}. */
export interface RelationQuery {
  entityId?: string;
  direction?: RelationDirection;
  relType?: string;
  origin?: NarrativeOrigin;
  /** Restrict to relations owned by one document. */
  relPath?: string;
  /** Only relations with an unresolved end. */
  brokenOnly?: boolean;
}

/** Filter for {@link NarrativeIndexStore.neighbourhood}. */
export interface NeighbourhoodQuery {
  /** The entity the walk starts from. */
  entityId: string;
  /** How many hops to follow. `1` returns the directly incident relations. */
  depth: number;
  /** Restrict to these relation types. Absent = every type. */
  relTypes?: readonly string[];
  /** Restrict to these origins. Absent = every origin. */
  origins?: readonly NarrativeOrigin[];
  /** Hard cap on returned relations, so a hub cannot return the whole graph. */
  limit?: number;
}

/**
 * The three lifecycle facts a store knows about itself — and the only three.
 *
 * PRIMITIVES, NOT `IndexState`. See the module note: assembling the envelope is
 * the service's job outside this folder. Keeping this type to bare booleans and
 * a number is what stops the natural-but-wrong `getState(): IndexState` from
 * appearing here and turning prohibition (e)'s own rejecting case into product
 * code.
 */
export interface NarrativeIndexStoreLifecycle {
  /**
   * Monotonic write counter. Every COMMITTED write transaction advances it by
   * one, under a compare-and-set that fails if anyone else moved it — which is
   * how a second writer that ignored the lock is DETECTED rather than assumed
   * absent.
   */
  generation: number;
  /** True when this instance may not write: another process holds a live lock,
   *  or a foreign writer was caught mid-flight and this instance stepped down. */
  readOnly: boolean;
  /** True when the underlying file was found corrupt at least once in this
   *  process. Recovery is a rebuild, so this stays observable afterwards. */
  corrupted: boolean;
  /** True when {@link readOnly} is caused by ANOTHER process owning the writer
   *  lock. The service needs the distinction to produce the right stale reason;
   *  `readOnly` alone cannot carry it once a second read-only cause exists. */
  foreignWriter: boolean;
}

/**
 * What went wrong at the STORAGE layer.
 *
 * A SMALL CLOSED UNION, DELIBERATELY NOT `IndexFailureCode`. The store may not
 * import that type (prohibition (e) half 2), and it also must not be able to
 * NAME failures it cannot have: `manifest-unreadable` and `extraction-failed`
 * are pipeline failures, and a vocabulary that offers them to a storage layer
 * invites a storage layer to guess.
 */
export type NarrativeIndexStoreErrorKind =
  /** The database file could not be opened, created, or read at all. */
  | 'storage-unavailable'
  /** Corruption seen twice in a row in this process — recovery gave up. */
  | 'storage-corrupted'
  /** A write was attempted on a read-only instance. Never queued, never lost. */
  | 'read-only'
  /** A rebuild was refused because another process holds a LIVE writer lock. */
  | 'rebuild-refused'
  /** A concurrent writer was detected by the generation compare-and-set. */
  | 'foreign-writer-detected'
  /** A structural invariant was rejected. In SQLite this comes from a `CHECK`;
   *  the in-memory adapter, having no schema, raises it from its own guard. */
  | 'constraint-violation';

/** Every member of {@link NarrativeIndexStoreErrorKind}, as data. */
export const NARRATIVE_INDEX_STORE_ERROR_KINDS = [
  'storage-unavailable',
  'storage-corrupted',
  'read-only',
  'rebuild-refused',
  'foreign-writer-detected',
  'constraint-violation'
] as const satisfies readonly NarrativeIndexStoreErrorKind[];

/**
 * The only error type this port raises.
 *
 * It carries a `kind` and nothing free-form beyond the message, because the
 * message never crosses RPC: sanitizing a thrown error into an
 * `IndexFailureReason` happens one layer up, in `src/node`, where relativizing
 * a path is possible at all.
 */
export class NarrativeIndexStoreError extends Error {
  constructor(
    readonly kind: NarrativeIndexStoreErrorKind,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'NarrativeIndexStoreError';
  }
}

/** Narrow an unknown throw to this port's error type. */
export function isNarrativeIndexStoreError(error: unknown): error is NarrativeIndexStoreError {
  return error instanceof NarrativeIndexStoreError;
}

/**
 * The write surface, handed to the body of {@link NarrativeIndexStore.transaction}.
 *
 * WRITES EXIST ONLY INSIDE A TRANSACTION, and that is the single-writer policy
 * in type form rather than in prose: there is no `putEntity` on the store, so
 * there is no way to write outside the one guard that takes the lock, performs
 * the generation compare-and-set, and rolls back when it loses.
 */
export interface NarrativeIndexWriter {
  /** Insert or replace a document by `relPath`. Returns its row id. */
  putDocument(document: IndexedDocumentInput): number;
  /** Remove a document and everything that cascades from it. */
  deleteDocument(relPath: string): void;
  /**
   * Store an entity card. The owning document is `entity.sourcePath`, which
   * must already exist — a second parameter naming the document could disagree
   * with the field, and there would be no way to tell which one was right.
   *
   * REJECTED when that card is already recorded as an EXCLUDED definition of
   * the same id: it would make the card both the winner and a loser of one
   * collision, and {@link DuplicateEntityRecord} has no way to say that.
   */
  putEntity(entity: NarrativeEntity): void;
  /**
   * Record that `excludedRelPath` also defines `entityId`, and LOST.
   *
   * THE WINNER IS NOT A PARAMETER HERE, AND THAT IS THE POINT. It is the card
   * that owns the entity row, so it is stated once — by the {@link putEntity}
   * call that must already have happened — instead of twice with a chance to
   * disagree. Two refusals make that an enforced ordering rather than an
   * unwritten one:
   *
   *   - REJECTED when no entity row defines `entityId`. In SQLite this is a
   *     FOREIGN KEY, so it also holds against a repair script; the in-memory
   *     adapter mirrors it by hand. It is what makes `keptRelPath` a required
   *     field rather than an optional one nobody would remember to check.
   *   - REJECTED when `excludedRelPath` IS the card that owns the entity.
   *
   * The same foreign key makes the collision die with its winner: deleting the
   * card that owns the entity cascades the entity away and the duplicate rows
   * with it. A losing card that is now the only definition of its id is not a
   * duplicate — it is simply the definition, which is what the next index pass
   * will record.
   */
  putDuplicateEntity(entityId: string, excludedRelPath: string): void;
  /**
   * Store one mention. The owning document is `mention.evidence.path`.
   *
   * NO NORMALIZATION HAPPENS HERE. If a caller hands over a value whose
   * `evidenceKind` disagrees with its coordinates, the write is REJECTED rather
   * than quietly repaired: repairing it would send the reader to the top of a
   * file and look exactly like working software.
   */
  putMention(mention: NarrativeMention): void;
  /** Store one relation and its evidence rows. Returns its row id. */
  putRelation(relation: NarrativeRelation): number;
  /** Drop every entity, mention and relation, keeping the schema. */
  clearAll(): void;
}

/** Read surface — available whether or not this instance may write. */
export interface NarrativeIndexReader {
  getDocument(relPath: string): IndexedDocument | undefined;
  listDocuments(): IndexedDocument[];
  getEntity(entityId: string): NarrativeEntity | undefined;
  findEntities(query?: EntityQuery): NarrativeEntity[];
  getMentions(query?: MentionQuery): NarrativeMention[];
  getRelations(query?: RelationQuery): NarrativeRelation[];
  /**
   * Relations reachable from an entity within `depth` hops.
   *
   * NAMED IN THE PORT ON PURPOSE (AD-6): the core cannot write SQL, so a walk
   * that must not drag the whole graph through memory has to be expressible
   * here or not at all. This is the acknowledged price of separability.
   */
  neighbourhood(query: NeighbourhoodQuery): NarrativeRelation[];
  /** Entity ids defined by more than one card, each naming the definition that
   *  is in effect. Ordered by `entityId`, code point ascending. */
  getDuplicateEntities(): DuplicateEntityRecord[];
}

/**
 * A per-workspace index database.
 *
 * One instance owns one file. The mapping from workspace root to instance, its
 * LRU bound and the canonicalization that stops one directory being opened
 * twice, live in the registry beside the adapter — not here, because they are
 * properties of the HOST, and a port that knew about them could not be
 * implemented by an in-memory double.
 */
export interface NarrativeIndexStore extends NarrativeIndexReader {
  /** Current lifecycle primitives. Cheap; safe to call per request. */
  lifecycle(): NarrativeIndexStoreLifecycle;
  /**
   * Run `body` as ONE write transaction — the single writer guard.
   *
   * Commits and advances the generation only if the compare-and-set holds. On
   * a lost compare-and-set the transaction is rolled back, the instance steps
   * down to read-only, and a `foreign-writer-detected` error is raised: a write
   * is never silently dropped and never queued.
   *
   * @throws NarrativeIndexStoreError `read-only` when this instance may not write.
   */
  transaction<T>(body: (writer: NarrativeIndexWriter) => T): T;
  /**
   * Empty the database down to a fresh schema, for a full rebuild.
   *
   * REFUSED WHILE ANOTHER PROCESS HOLDS A LIVE WRITER LOCK, and refused by
   * checking the lock AT CALL TIME rather than by consulting a cached state —
   * the lock may have expired while a human was reading the status bar. A stale
   * lock (older than the liveness window) does NOT block: "refuse always" would
   * pass a test written only against the live case.
   *
   * @throws NarrativeIndexStoreError `rebuild-refused` when a live foreign lock exists.
   */
  resetForRebuild(): void;
  /** Release the file, the lock row and any timer. Idempotent. */
  close(): void;
}
