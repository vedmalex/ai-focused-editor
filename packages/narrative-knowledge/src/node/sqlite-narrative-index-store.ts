/**
 * The SQLite adapter of {@link NarrativeIndexStore} (TASK-022 WP-3, tech_spec
 * ОВ-1 / ОВ-4 / ОВ-7).
 *
 * THIS IS THE ONLY FILE IN THE PACKAGE THAT MENTIONS `node:sqlite`, and that is
 * a layer rule, not a habit: `src/common` may not reach a Node builtin because
 * `bun` cannot resolve one, and the import-graph test proves the absence
 * transitively.
 *
 * THE API SURFACE IS PINNED (ОВ-7). Only the constructor options `open`,
 * `readOnly` and `enableForeignKeyConstraints`, only `exec`/`prepare`/`close` on
 * the database, and only `run`/`get`/`all`/`iterate` on a statement. Everything
 * else is forbidden BY DEFAULT — including names a future Node may add, and
 * including the constructor's `timeout`, which is replaced by
 * `PRAGMA busy_timeout`. A test scans this source against the LIVE prototypes
 * and fails on any member outside the allowed list; stating the rule by
 * complement is what makes it survive a Node upgrade, where an allow-list of
 * forbidden names would silently pass whatever nobody had heard of yet.
 *
 * NO NORMALIZATION ON THE WRITE PATH. When a caller hands over a value whose
 * `evidenceKind` disagrees with its coordinates, this adapter writes exactly
 * what it was given and lets the `CHECK` refuse it. Repairing it here would
 * move the enforcement into a layer a migration or a repair script can bypass,
 * and — worse — the schema teeth would then be testing this file rather than
 * the schema.
 *
 * THE SINGLE WRITER IS COOPERATIVE, AND THE COOPERATION IS VERIFIED. A lock row
 * in `meta` claims the writer role; a heartbeat keeps it alive; a lock older
 * than the liveness window is taken over, which is the recovery a lock file
 * cannot offer after `kill -9`. But the invariant is NOT ASSUMED: every write
 * transaction advances `generation` under a compare-and-set against the value
 * this instance believes in, so a second writer that ignored the lock is
 * DETECTED on the next write and this instance steps down to read-only rather
 * than quietly overwriting someone's work.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import {
  NarrativeIndexStoreError,
  assertQueryLimit,
  documentOrderExclusion,
  mentionOrderSql,
  orderDocumentsByChapter,
  type DocumentMoveFreshness,
  type DuplicateEntityRecord,
  type EntityQuery,
  type EvidenceRef,
  type IndexedDocument,
  type IndexedDocumentInput,
  type MentionDocumentCount,
  type MentionQuery,
  type NarrativeDocumentKind,
  type NarrativeEntity,
  type NarrativeIndexStore,
  type NarrativeIndexStoreLifecycle,
  type NarrativeIndexWriter,
  type NarrativeMention,
  type NarrativeRelation,
  type NarrativeOrigin,
  type NeighbourhoodQuery,
  type RelationQuery
} from '../common';
import {
  META_KEYS,
  NARRATIVE_INDEX_DDL,
  NARRATIVE_INDEX_PRAGMAS,
  NARRATIVE_INDEX_SCHEMA_VERSION,
  WRITER_HEARTBEAT_INTERVAL_MS,
  WRITER_LOCK_STALE_AFTER_MS
} from './narrative-index-schema';

// --------------------------------------------------------------------------
// Observability
// --------------------------------------------------------------------------

/** Why the index was built from nothing. Three causes, kept DISTINGUISHABLE in
 *  the log: a rebuild is silent to the user but must never be silent to whoever
 *  reads the backend log, or "the index rebuilt itself again" becomes
 *  undiagnosable. */
export type NarrativeIndexRebuildCause = 'absent' | 'schema-version-mismatch' | 'corrupted';

/** Every member of {@link NarrativeIndexRebuildCause}, as data. */
export const NARRATIVE_INDEX_REBUILD_CAUSES = [
  'absent',
  'schema-version-mismatch',
  'corrupted'
] as const satisfies readonly NarrativeIndexRebuildCause[];

export type NarrativeIndexStoreLogRecord =
  /** The schema was created from nothing. `durationMs` is the schema build, not
   *  the extraction that follows — the extraction belongs to the service. */
  | { event: 'schema-rebuilt'; cause: NarrativeIndexRebuildCause; databaseFile: string; durationMs: number }
  /** One structural line next to Node's own `ExperimentalWarning`, so a reader
   *  of the log can see the warning is expected AND which SQLite is actually
   *  underneath. The warning itself is NOT suppressed in the product: silencing
   *  the whole `warning` channel to hide one known line is precisely the class
   *  of behaviour this epic exists to remove. */
  | { event: 'engine'; node: string; sqlite: string }
  /** This instance could not take the writer lock, or lost it. */
  | { event: 'read-only'; reason: 'foreign-writer'; databaseFile: string }
  /** The compare-and-set lost: someone else advanced the generation. */
  | { event: 'foreign-writer-detected'; databaseFile: string; expected: number; found: number }
  /** A rebuild was refused because a live foreign lock owns the file. */
  | { event: 'rebuild-refused'; reason: 'foreign-writer'; databaseFile: string }
  /** A step-down from a foreign writer's lock was REVERSED: the neighbour's
   *  row was gone or stale, so this instance took the writer role back on its
   *  own — the recovery `narrative-memory-contribution.ts`'s tooltip promises
   *  ("the lock expires, no action needed") and that the store previously did
   *  not perform (ISS-357). */
  | { event: 'writer-reclaimed'; databaseFile: string };

export type NarrativeIndexStoreLogger = (record: NarrativeIndexStoreLogRecord) => void;

export interface SqliteNarrativeIndexStoreOptions {
  /** Absolute path of the database file. The caller resolves it from the
   *  workspace root and the configured relative path — this adapter reads no
   *  configuration source of its own. */
  databaseFile: string;
  /** Absolute path of the workspace root, recorded in `meta` for diagnostics. */
  workspaceRoot: string;
  /** Where the structural records go. Absent = nowhere, which is what tests
   *  that do not care about the log want. */
  log?: NarrativeIndexStoreLogger;
  /** Injected clock, so lock expiry is testable without waiting 30 seconds. */
  now?: () => number;
  /** This process's identity for the lock. A pid alone is not enough: the OS
   *  reuses pids, so a dead writer's pid can be alive again as something else. */
  bootId?: string;
  /** `0` disables the background heartbeat timer entirely, for tests that drive
   *  it by hand. */
  heartbeatIntervalMs?: number;
  /** How old a heartbeat may be before the lock is considered abandoned. */
  lockStaleAfterMs?: number;
}

// --------------------------------------------------------------------------
// Corruption memory
// --------------------------------------------------------------------------

/**
 * How many times each file has been found corrupt IN THIS PROCESS.
 *
 * The rule is "a second corruption in a row gives up rather than rebuilding
 * again", and it is counted in process memory on purpose: the only place that
 * could persist it is the very file that keeps being corrupt.
 *
 * It does NOT reset on the successful rebuild that follows a corruption — that
 * rebuild is part of the same recovery, and resetting there would make the
 * counter unable to ever reach two.
 */
const corruptionCounts = new Map<string, number>();

/** Test seam: forget what this process has seen about `databaseFile`. */
export function resetCorruptionMemory(databaseFile?: string): void {
  if (databaseFile === undefined) {
    corruptionCounts.clear();
  } else {
    corruptionCounts.delete(resolvePath(databaseFile));
  }
}

// --------------------------------------------------------------------------
// Error classification
// --------------------------------------------------------------------------

function errorCodeOf(error: unknown): string {
  const raw = (error as { code?: unknown } | null | undefined)?.code;
  return typeof raw === 'string' ? raw : '';
}

function looksCorrupt(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (code.includes('SQLITE_CORRUPT') || code.includes('SQLITE_NOTADB')) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /file is not a database|database disk image is malformed/i.test(message);
}

// --------------------------------------------------------------------------
// Row shapes
// --------------------------------------------------------------------------

interface DocumentRow {
  doc_id: number;
  rel_path: string;
  kind: string;
  size_bytes: number;
  mtime_ms: number;
  content_hash: string;
  chapter_order: number | null;
  title: string | null;
  manifest_included: number;
  build_included: number;
  indexed_at: number;
  generation: number;
}

interface EntityRow {
  payload: string;
}

interface MentionRow {
  entity_id: string;
  tag_kind: string | null;
  raw: string;
  label: string | null;
  resolved: number;
  start_line: number | null;
  start_char: number | null;
  end_line: number | null;
  end_char: number | null;
  label_start_line: number | null;
  label_start_char: number | null;
  label_end_line: number | null;
  label_end_char: number | null;
  evidence_kind: string;
  doc_rel_path: string;
}

interface RelationRow {
  relation_id: number;
  source_id: string;
  target_id: string;
  rel_type: string;
  origin: string;
  confidence: number | null;
  source_resolved: number;
  target_resolved: number;
  list_position: number | null;
  story_time_from: string | null;
  story_time_to: string | null;
  note: string | null;
  doc_rel_path: string | null;
}

interface EvidenceRow {
  relation_id: number;
  start_line: number | null;
  start_char: number | null;
  end_line: number | null;
  end_char: number | null;
  evidence_kind: string;
  doc_rel_path: string;
}

function toDocument(row: DocumentRow): IndexedDocument {
  const document: IndexedDocument = {
    docId: row.doc_id,
    relPath: row.rel_path,
    kind: row.kind as NarrativeDocumentKind,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    contentHash: row.content_hash,
    manifestIncluded: row.manifest_included !== 0,
    buildIncluded: row.build_included !== 0,
    indexedAt: row.indexed_at,
    generation: row.generation
  };
  if (row.chapter_order !== null) {
    document.chapterOrder = row.chapter_order;
  }
  // `!== null` and NOT `?? undefined`: a title the manifest states as the empty
  // string is a real value the reader is entitled to see, and `??` would keep it
  // while a truthiness test would silently turn it into "the manifest does not
  // name this file". The two are different claims (tech_spec ОВ-1, tooth A14).
  if (row.title !== null) {
    document.title = row.title;
  }
  return document;
}

/**
 * Rebuild an evidence value from its columns.
 *
 * A row that reaches here has already passed the `CHECK`, so the pairing holds
 * and this function does not re-decide it — it reads `evidence_kind` and trusts
 * the schema, which is what having the constraint in the schema BUYS.
 */
function toEvidence(path: string, row: {
  start_line: number | null;
  start_char: number | null;
  end_line: number | null;
  end_char: number | null;
  evidence_kind: string;
}): EvidenceRef {
  if (row.evidence_kind === 'range') {
    return {
      path,
      evidenceKind: 'range',
      range: {
        start: { line: row.start_line ?? 0, character: row.start_char ?? 0 },
        end: { line: row.end_line ?? 0, character: row.end_char ?? 0 }
      }
    };
  }
  return { path, evidenceKind: 'whole-file' };
}

function toMention(row: MentionRow): NarrativeMention {
  const mention: NarrativeMention = {
    entityId: row.entity_id,
    raw: row.raw,
    resolved: row.resolved !== 0,
    evidence: toEvidence(row.doc_rel_path, row)
  };
  // Absent fields are ABSENT, not `undefined`-valued: the bare wiki form has no
  // kind and no label anywhere in any file, and a key materialising out of the
  // storage layer would make "unmarked" and "marked with nothing" the same.
  if (row.tag_kind !== null) {
    mention.kind = row.tag_kind;
  }
  if (row.label !== null) {
    mention.label = row.label;
  }
  if (row.label_start_line !== null) {
    mention.labelRange = {
      start: { line: row.label_start_line, character: row.label_start_char ?? 0 },
      end: { line: row.label_end_line ?? 0, character: row.label_end_char ?? 0 }
    };
  }
  return mention;
}

// --------------------------------------------------------------------------
// The adapter
// --------------------------------------------------------------------------

let engineLineLogged = false;

/** Test seam for the once-per-process engine log line. */
export function resetEngineLogOnce(): void {
  engineLineLogged = false;
}

export class SqliteNarrativeIndexStore implements NarrativeIndexStore {
  private db: DatabaseSync;
  private readonly databaseFile: string;
  private readonly workspaceRoot: string;
  private readonly log: NarrativeIndexStoreLogger;
  private readonly now: () => number;
  private readonly bootId: string;
  private readonly lockStaleAfterMs: number;
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  private generation = 0;
  private readOnly = false;
  private corrupted = false;
  private foreignWriter = false;
  private closed = false;
  /**
   * When {@link tryReclaimWriterRole} last attempted the EXPENSIVE half of a
   * reclaim (opening a second connection for write). `undefined` means never
   * — so the very first attempt after stepping down is never throttled.
   */
  private lastReclaimAttemptAt: number | undefined;

  constructor(options: SqliteNarrativeIndexStoreOptions) {
    this.databaseFile = resolvePath(options.databaseFile);
    this.workspaceRoot = options.workspaceRoot;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.bootId = options.bootId ?? randomUUID();
    this.lockStaleAfterMs = options.lockStaleAfterMs ?? WRITER_LOCK_STALE_AFTER_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? WRITER_HEARTBEAT_INTERVAL_MS;

    this.db = this.openOrRebuild();
    this.claimWriterLock();

    if (this.heartbeatIntervalMs > 0 && !this.readOnly) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
      // Never keep the backend alive for a heartbeat.
      this.heartbeatTimer.unref?.();
    }
  }

  // ---- opening ----------------------------------------------------------

  private openOrRebuild(): DatabaseSync {
    const existed = existsSync(this.databaseFile);
    if (!existed) {
      mkdirSync(dirname(this.databaseFile), { recursive: true });
      return this.buildFresh('absent');
    }
    let db: DatabaseSync;
    try {
      db = this.openFile({ readOnly: false });
    } catch (error) {
      if (looksCorrupt(error)) {
        return this.recoverFromCorruption(error);
      }
      throw new NarrativeIndexStoreError(
        'storage-unavailable',
        `could not open the narrative index database (${errorCodeOf(error) || 'unknown error'})`,
        error
      );
    }
    let version: number;
    try {
      version = this.readUserVersion(db);
    } catch (error) {
      db.close();
      if (looksCorrupt(error)) {
        return this.recoverFromCorruption(error);
      }
      throw new NarrativeIndexStoreError(
        'storage-unavailable',
        `could not read the narrative index schema version (${errorCodeOf(error) || 'unknown error'})`,
        error
      );
    }
    if (version !== NARRATIVE_INDEX_SCHEMA_VERSION) {
      db.close();
      return this.buildFresh('schema-version-mismatch');
    }
    try {
      this.generation = Number(this.readMeta(db, META_KEYS.generation) ?? '0');
    } catch (error) {
      db.close();
      if (looksCorrupt(error)) {
        return this.recoverFromCorruption(error);
      }
      throw new NarrativeIndexStoreError('storage-unavailable', 'could not read index metadata', error);
    }
    this.logEngineOnce();
    return db;
  }

  /**
   * Corruption recovery, and the exact place the "second one gives up" rule
   * lives.
   *
   * Recovery DELETES the file with its `-wal` and `-shm` siblings and builds a
   * fresh schema. That is safe only because the database is a cache: every fact
   * in it is re-derivable from Markdown and YAML. Deleting it while ANOTHER
   * process owns the writer lock would delete that process's work, which is why
   * the caller checks the lock before ever asking for a rebuild.
   */
  private recoverFromCorruption(error: unknown): DatabaseSync {
    this.corrupted = true;
    const seen = (corruptionCounts.get(this.databaseFile) ?? 0) + 1;
    corruptionCounts.set(this.databaseFile, seen);
    if (seen >= 2) {
      throw new NarrativeIndexStoreError(
        'storage-corrupted',
        `the narrative index database was corrupt ${seen} times in this session; not rebuilding again`,
        error
      );
    }
    return this.buildFresh('corrupted');
  }

  private buildFresh(cause: NarrativeIndexRebuildCause): DatabaseSync {
    const startedAt = this.now();
    this.removeDatabaseFiles();
    let db: DatabaseSync;
    try {
      db = this.openFile({ readOnly: false });
      db.exec(NARRATIVE_INDEX_DDL);
      db.exec(`PRAGMA user_version = ${NARRATIVE_INDEX_SCHEMA_VERSION}`);
    } catch (error) {
      throw new NarrativeIndexStoreError(
        'storage-unavailable',
        `could not create the narrative index database (${errorCodeOf(error) || 'unknown error'})`,
        error
      );
    }
    this.generation = 0;
    const insert = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    insert.run(META_KEYS.schemaVersion, String(NARRATIVE_INDEX_SCHEMA_VERSION));
    insert.run(META_KEYS.generation, '0');
    insert.run(META_KEYS.workspaceRoot, this.workspaceRoot);
    insert.run(META_KEYS.engineSqlite, process.versions.sqlite ?? 'unknown');
    insert.run(META_KEYS.createdAt, String(this.now()));
    this.logEngineOnce();
    this.log({
      event: 'schema-rebuilt',
      cause,
      databaseFile: this.databaseFile,
      durationMs: Math.max(0, this.now() - startedAt)
    });
    return db;
  }

  private openFile(options: { readOnly: boolean }): DatabaseSync {
    const db = new DatabaseSync(this.databaseFile, {
      open: true,
      readOnly: options.readOnly,
      enableForeignKeyConstraints: true
    });
    for (const pragma of NARRATIVE_INDEX_PRAGMAS) {
      // A read-only connection cannot set every pragma; the ones it refuses are
      // the ones it does not need.
      if (options.readOnly && !pragma.startsWith('PRAGMA busy_timeout')) {
        continue;
      }
      db.exec(pragma);
    }
    return db;
  }

  private removeDatabaseFiles(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${this.databaseFile}${suffix}`, { force: true });
    }
  }

  private logEngineOnce(): void {
    if (engineLineLogged) {
      return;
    }
    engineLineLogged = true;
    this.log({ event: 'engine', node: process.version, sqlite: process.versions.sqlite ?? 'unknown' });
  }

  // ---- the writer lock --------------------------------------------------

  private readUserVersion(db: DatabaseSync): number {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  private readMeta(db: DatabaseSync, key: string): string | undefined {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
  }

  /**
   * Claim the writer role, or step down to read-only.
   *
   * The claim is one `BEGIN IMMEDIATE` transaction so the read of the existing
   * lock and the write of ours cannot interleave with another claimant.
   */
  private claimWriterLock(): void {
    const foreign = readForeignWriterLock(this.db, this.bootId, this.now(), this.lockStaleAfterMs);
    if (foreign === undefined) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const insert = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
        insert.run(META_KEYS.writerPid, String(process.pid));
        insert.run(META_KEYS.writerBootId, this.bootId);
        insert.run(META_KEYS.writerStartedAt, String(this.now()));
        insert.run(META_KEYS.writerHeartbeatAt, String(this.now()));
        this.db.exec('COMMIT');
        return;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new NarrativeIndexStoreError('storage-unavailable', 'could not claim the writer lock', error);
      }
    }
    // Someone alive owns the file. Reading is still fully available — that is
    // exactly what WAL was chosen for — but writing is refused explicitly, never
    // queued and never silently dropped.
    this.db.close();
    try {
      this.db = this.openFile({ readOnly: true });
    } catch (error) {
      // ISS-314: the losing path had no fallback of its own, so the degradation
      // was incomplete. There is no retry and no rebuild here, and the absence
      // is the decision: a rebuild is a WRITE, and we have just established that
      // another process owns the file — rebuilding would delete its work. The
      // causes of a failed read-only open (permissions, a network mount, a
      // damaged `-wal`) do not clear up on their own either.
      throw new NarrativeIndexStoreError(
        'storage-unavailable',
        `the narrative index is owned by another process and could not even be opened read-only ` +
          `(${errorCodeOf(error) || 'unknown error'})`,
        error
      );
    }
    this.readOnly = true;
    this.foreignWriter = true;
    this.generation = Number(this.readMeta(this.db, META_KEYS.generation) ?? '0');
    this.log({ event: 'read-only', reason: 'foreign-writer', databaseFile: this.databaseFile });
  }

  /** Refresh this instance's claim. Public so a test can drive it without a timer. */
  heartbeat(): void {
    if (this.readOnly || this.closed) {
      return;
    }
    try {
      this.db
        .prepare('UPDATE meta SET value = ? WHERE key = ?')
        .run(String(this.now()), META_KEYS.writerHeartbeatAt);
    } catch {
      // A failed heartbeat is not worth killing the backend over; the next
      // write's compare-and-set is the real detector.
    }
  }

  // ---- lifecycle --------------------------------------------------------

  /**
   * ISS-357: the read-only step-down caused by a foreign writer is
   * REVERSIBLE, because its cause — another live process — is temporary by
   * nature. `lifecycle()` is the path that feeds the status bar's 5s poll
   * ({@link NARRATIVE_MEMORY_POLL_INTERVAL_MS} in
   * `narrative-memory-contribution.ts`) and every read RPC's envelope
   * (`narrative-index-session.ts`'s `state()`), so trying the reclaim here —
   * rather than only from an explicit user action — is what makes the yellow
   * status bar clear itself with "nothing to do", exactly as the tooltip
   * promises.
   */
  lifecycle(): NarrativeIndexStoreLifecycle {
    this.tryReclaimWriterRole();
    return {
      generation: this.generation,
      readOnly: this.readOnly,
      corrupted: this.corrupted,
      foreignWriter: this.foreignWriter
    };
  }

  transaction<T>(body: (writer: NarrativeIndexWriter) => T): T {
    this.assertOpen();
    if (this.readOnly) {
      throw new NarrativeIndexStoreError(
        'read-only',
        'this narrative index instance may not write: another process owns the writer lock'
      );
    }
    const expected = this.generation;
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = body(this.makeWriter(expected + 1));
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // The compare-and-set. `changes !== 1` means somebody else moved the
    // generation while this instance believed it owned the file — the lock was
    // ignored, or a takeover raced. Losing here is not a retry: two writers
    // taking turns overwriting each other while both report `ready` is the
    // failure this detects, and continuing would be exactly that.
    const updated = this.db
      .prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?')
      .run(String(expected + 1), META_KEYS.generation, String(expected));
    if (Number(updated.changes) !== 1) {
      this.db.exec('ROLLBACK');
      const found = Number(this.readMeta(this.db, META_KEYS.generation) ?? '-1');
      this.readOnly = true;
      this.foreignWriter = true;
      this.log({ event: 'foreign-writer-detected', databaseFile: this.databaseFile, expected, found });
      this.log({ event: 'read-only', reason: 'foreign-writer', databaseFile: this.databaseFile });
      throw new NarrativeIndexStoreError(
        'foreign-writer-detected',
        `another writer advanced the index generation (expected ${expected}, found ${found}); ` +
          'this instance is now read-only'
      );
    }
    this.db.exec('COMMIT');
    this.generation = expected + 1;
    return result;
  }

  resetForRebuild(): void {
    this.assertOpen();
    // Checked AT CALL TIME, never from a cached state: the lock may have
    // expired while a human was looking at the status bar. `staleAfterMs` is
    // passed through explicitly so this live check uses the SAME liveness
    // window this instance was configured with, rather than silently falling
    // back to the module default when a test (or a future caller) injects a
    // shorter one.
    if (
      isRebuildBlockedByForeignWriter(this.databaseFile, {
        now: this.now(),
        bootId: this.bootId,
        staleAfterMs: this.lockStaleAfterMs
      })
    ) {
      this.log({ event: 'rebuild-refused', reason: 'foreign-writer', databaseFile: this.databaseFile });
      throw new NarrativeIndexStoreError(
        'rebuild-refused',
        'the narrative index is owned by another live process; rebuilding would delete its work'
      );
    }
    // ISS-357: the check above just proved the lock is free or stale — do not
    // throw the very next line over a `readOnly` flag that same fact makes
    // stale. Try to reclaim the writer role before consulting it.
    this.tryReclaimWriterRole();
    if (this.readOnly) {
      throw new NarrativeIndexStoreError('read-only', 'this narrative index instance may not write');
    }
    this.db.close();
    this.db = this.buildFresh('absent');
    this.claimWriterLock();
  }

  /**
   * Try to take the writer role back after having stepped down to read-only
   * because a foreign lock was live at the time (ISS-357).
   *
   * WHY THIS IS SAFE TO CALL FROM A STATUS POLL. The neighbour's lock is
   * DISTINGUISHED BY IDENTITY, not merely absence-of-conflict:
   *   - a row that does not exist, or a row that is foreign AND older than
   *     {@link lockStaleAfterMs} → reclaimable, exactly the two cases the
   *     bug report requires (a polite close deletes the row; a crash leaves
   *     it there with a heartbeat that stops moving);
   *   - a row that is foreign and fresh → left alone, full stop — this is the
   *     one guarantee the whole mechanism exists for;
   *   - a row that is OUR OWN → also left alone. This is deliberately
   *     out of scope: it is the state `transaction()`'s compare-and-set
   *     leaves behind after this SAME instance lost a race with another
   *     writer that ignored the lock. Auto-healing that case here would
   *     silently undo the safety net the CAS exists to provide (two writers
   *     both believing themselves ready), so it is left to a fresh instance,
   *     not this method.
   *
   * COST. The identity check above is one indexed `SELECT` against the
   * connection this instance already has open — cheap enough to run on every
   * poll and every read RPC (both reach here through `lifecycle()`). Only
   * when that check finds the lock reclaimable does this method do anything
   * expensive (open a second connection, `BEGIN IMMEDIATE`), and that
   * expensive half is throttled to at most once per
   * {@link heartbeatIntervalMs} via `lastReclaimAttemptAt` — otherwise a
   * writable open that keeps failing (e.g. a read-only mount) would attempt
   * to reopen the file on every single poll.
   *
   * RACE BETWEEN TWO RECLAIMERS. Both may see the row as reclaimable from
   * the cheap check. Only one can hold `BEGIN IMMEDIATE` on the file at a
   * time, so they serialise there; the LOSER's transaction re-runs the same
   * identity check with a fresh read and finds the winner's row, then rolls
   * back and leaves its OWN connection completely untouched — no half-open
   * write handle, still reading through the same connection it had before
   * calling this method.
   */
  private tryReclaimWriterRole(): void {
    if (!this.foreignWriter || this.closed) {
      return;
    }
    const checkedAt = this.now();
    if (!isLockRowReclaimable(this.db, this.bootId, checkedAt, this.lockStaleAfterMs)) {
      return;
    }
    // A SEPARATE read of the clock for the throttle decision (rather than
    // reusing `checkedAt`) marks the moment this instance actually COMMITS to
    // the expensive half — the gap between the two is real: the row was
    // reclaimable a moment ago, but nothing stops another instance's claim
    // landing in between, which is exactly what the in-transaction re-check
    // below exists to catch.
    const attemptStartedAt = this.now();
    if (
      this.lastReclaimAttemptAt !== undefined &&
      attemptStartedAt - this.lastReclaimAttemptAt < this.heartbeatIntervalMs
    ) {
      return;
    }
    this.lastReclaimAttemptAt = attemptStartedAt;

    // Open a SECOND, independent connection and claim there FIRST — the
    // connection currently serving reads is not touched until the claim is
    // durably committed, so a failure at any point below (a read-only mount,
    // a lost race) leaves this instance exactly as it was.
    let writableDb: DatabaseSync;
    try {
      writableDb = this.openFile({ readOnly: false });
    } catch {
      return;
    }
    try {
      writableDb.exec('BEGIN IMMEDIATE');
    } catch {
      writableDb.close();
      return;
    }
    const claimedAt = this.now();
    try {
      // Re-checked INSIDE the transaction, against a connection that just
      // took SQLite's write lock: this is what makes two racing reclaimers
      // resolve to exactly one winner rather than both writing their own
      // identity in turn.
      if (!isLockRowReclaimable(writableDb, this.bootId, claimedAt, this.lockStaleAfterMs)) {
        writableDb.exec('ROLLBACK');
        writableDb.close();
        return;
      }
      const insert = writableDb.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      insert.run(META_KEYS.writerPid, String(process.pid));
      insert.run(META_KEYS.writerBootId, this.bootId);
      insert.run(META_KEYS.writerStartedAt, String(claimedAt));
      insert.run(META_KEYS.writerHeartbeatAt, String(claimedAt));
      writableDb.exec('COMMIT');
    } catch {
      try {
        writableDb.exec('ROLLBACK');
      } catch {
        // Not inside a transaction any more (COMMIT/ROLLBACK already ran, or
        // never started) — nothing left to undo.
      }
      writableDb.close();
      return;
    }

    // The claim is durable. Only now retire the old connection, and re-read
    // `generation` from the file rather than keep what this instance last
    // believed: the neighbour may have written while this instance was a
    // read-only observer.
    this.db.close();
    this.db = writableDb;
    this.generation = Number(this.readMeta(this.db, META_KEYS.generation) ?? '0');
    this.readOnly = false;
    this.foreignWriter = false;
    this.log({ event: 'writer-reclaimed', databaseFile: this.databaseFile });
    if (this.heartbeatTimer === undefined && this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (!this.readOnly) {
      try {
        // Release the claim so the next process does not have to wait out the
        // liveness window for a writer that left politely.
        this.db.prepare('DELETE FROM meta WHERE key IN (?, ?, ?, ?)').run(
          META_KEYS.writerPid,
          META_KEYS.writerBootId,
          META_KEYS.writerStartedAt,
          META_KEYS.writerHeartbeatAt
        );
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // Best effort: a lock we failed to release simply expires.
      }
    }
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new NarrativeIndexStoreError('storage-unavailable', 'this narrative index instance is closed');
    }
  }

  // ---- reads ------------------------------------------------------------

  getDocument(relPath: string): IndexedDocument | undefined {
    const row = this.db.prepare('SELECT * FROM document WHERE rel_path = ?').get(relPath) as
      | DocumentRow
      | undefined;
    return row ? toDocument(row) : undefined;
  }

  listDocuments(): IndexedDocument[] {
    const rows = this.db.prepare('SELECT * FROM document ORDER BY rel_path').all() as unknown as DocumentRow[];
    return rows.map(toDocument);
  }

  getEntity(entityId: string): NarrativeEntity | undefined {
    const row = this.db.prepare('SELECT payload FROM entity WHERE entity_id = ?').get(entityId) as
      | EntityRow
      | undefined;
    return row ? (JSON.parse(row.payload) as NarrativeEntity) : undefined;
  }

  findEntities(query: EntityQuery = {}): NarrativeEntity[] {
    assertQueryLimit(query.limit, 'EntityQuery.limit');
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.type !== undefined) {
      clauses.push('e.type = ?');
      params.push(query.type);
    }
    if (query.origin !== undefined) {
      clauses.push('e.origin = ?');
      params.push(query.origin);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT e.payload FROM entity e ${where} ORDER BY e.entity_id`)
      .all(...params) as unknown as EntityRow[];
    let entities = rows.map(row => JSON.parse(row.payload) as NarrativeEntity);
    if (query.namePrefix !== undefined && query.namePrefix.length > 0) {
      // THE PREFIX IS FOLDED IN JAVASCRIPT, ON PURPOSE, AND NOT BY SQL.
      //
      // SQLite's `lower()`, its `LIKE` folding and its `NOCASE` collation are
      // ALL ASCII-ONLY — `lower('КРИШНА')` returns `КРИШНА` unchanged. The names
      // in this product are routinely Cyrillic, so doing the fold in SQL would
      // make the filter silently case-SENSITIVE for exactly the alphabet that
      // matters, while the in-memory adapter (which folds with
      // `String.prototype.toLowerCase`) stayed case-insensitive. That is the
      // two-adapters-drift failure in its purest form, so the contract core
      // carries a Cyrillic case for it.
      //
      // The `entity_name_ci` / `entity_alias_ci` indexes are kept: they still
      // serve exact and ASCII lookups, and dropping them is a schema change.
      const prefix = query.namePrefix.toLowerCase();
      entities = entities.filter(entity =>
        [entity.name, ...entity.aliases].some(name => name.toLowerCase().startsWith(prefix))
      );
    }
    return query.limit === undefined ? entities : entities.slice(0, query.limit);
  }

  /** The WHERE clause of a {@link MentionQuery}, shared by the row query and the
   *  per-document aggregate so a filter cannot mean two things. */
  private mentionFilter(query: MentionQuery): { where: string; params: (string | number)[] } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.entityId !== undefined) {
      clauses.push('m.entity_id = ?');
      params.push(query.entityId);
    }
    if (query.relPath !== undefined) {
      clauses.push('d.rel_path = ?');
      params.push(query.relPath);
    }
    if (query.brokenOnly === true) {
      clauses.push('m.resolved = 0');
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  getMentions(query: MentionQuery = {}): NarrativeMention[] {
    assertQueryLimit(query.limit, 'MentionQuery.limit');
    const { where, params } = this.mentionFilter(query);
    // gh#47. `mention_id ASC` is the insertion order every caller before
    // `orderBy` relied on; the manuscript order is generated from the SAME rule
    // the in-memory adapter runs, so the two cannot drift silently.
    const order =
      query.orderBy === 'chapter' ? mentionOrderSql(query.direction ?? 'asc') : 'ORDER BY m.mention_id';
    // The cap is bound as a PARAMETER and appended AFTER the ordering, so it
    // selects the same rows the other adapter selects (ISS-349).
    const limit = query.limit === undefined ? '' : 'LIMIT ?';
    if (query.limit !== undefined) {
      params.push(query.limit);
    }
    const rows = this.db
      .prepare(
        `SELECT m.*, d.rel_path AS doc_rel_path FROM mention m
         JOIN document d ON d.doc_id = m.doc_id ${where} ${order} ${limit}`
      )
      .all(...params) as unknown as MentionRow[];
    return rows.map(toMention);
  }

  /**
   * gh#47 — one `GROUP BY` over the join `getMentions` already performs.
   *
   * The WHERE clause is built by the same helper, so a filter that narrows the
   * mentions narrows the counts identically; ordering is done in TypeScript by
   * the shared document rule rather than in SQL, because the trailing-group
   * tie-break is by path and both adapters must reach it the same way.
   */
  countMentionsByDocument(query: MentionQuery = {}): MentionDocumentCount[] {
    const { where, params } = this.mentionFilter(query);
    const rows = this.db
      .prepare(
        `SELECT d.rel_path, d.chapter_order, d.title, d.build_included, COUNT(*) AS mention_count
         FROM mention m JOIN document d ON d.doc_id = m.doc_id ${where}
         GROUP BY d.doc_id`
      )
      .all(...params) as unknown as {
      rel_path: string;
      chapter_order: number | null;
      title: string | null;
      build_included: number;
      mention_count: number;
    }[];
    return orderDocumentsByChapter(
      rows.map(row => {
        const exclusion = documentOrderExclusion({
          ...(row.chapter_order === null ? {} : { chapterOrder: row.chapter_order }),
          buildIncluded: row.build_included !== 0
        });
        return {
          relPath: row.rel_path,
          mentionCount: Number(row.mention_count),
          ...(row.chapter_order === null ? {} : { chapterOrder: row.chapter_order }),
          ...(row.title === null ? {} : { title: row.title }),
          ...(exclusion === undefined ? {} : { orderExclusion: exclusion })
        };
      })
    );
  }

  getRelations(query: RelationQuery = {}): NarrativeRelation[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.relType !== undefined) {
      clauses.push('r.rel_type = ?');
      params.push(query.relType);
    }
    if (query.origin !== undefined) {
      clauses.push('r.origin = ?');
      params.push(query.origin);
    }
    if (query.relPath !== undefined) {
      clauses.push('d.rel_path = ?');
      params.push(query.relPath);
    }
    if (query.brokenOnly === true) {
      clauses.push('(r.source_resolved = 0 OR r.target_resolved = 0)');
    }
    if (query.entityId !== undefined) {
      const direction = query.direction ?? 'either';
      if (direction === 'outgoing') {
        clauses.push('r.source_id = ?');
        params.push(query.entityId);
      } else if (direction === 'incoming') {
        clauses.push('r.target_id = ?');
        params.push(query.entityId);
      } else {
        clauses.push('(r.source_id = ? OR r.target_id = ?)');
        params.push(query.entityId, query.entityId);
      }
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.readRelations(where, params);
  }

  neighbourhood(query: NeighbourhoodQuery): NarrativeRelation[] {
    // Level-by-level rather than one recursive CTE: the port is what the core
    // may use, and a bounded loop of parameterized queries is easier to reason
    // about than a recursive query whose cost is invisible from the caller.
    const seen = new Set([query.entityId]);
    let frontier = [query.entityId];
    const collected: NarrativeRelation[] = [];
    const collectedIds = new Set<number>();
    for (let hop = 0; hop < query.depth && frontier.length > 0; hop++) {
      const placeholders = frontier.map(() => '?').join(', ');
      const clauses = [`(r.source_id IN (${placeholders}) OR r.target_id IN (${placeholders}))`];
      const params: (string | number)[] = [...frontier, ...frontier];
      if (query.relTypes !== undefined) {
        clauses.push(`r.rel_type IN (${query.relTypes.map(() => '?').join(', ')})`);
        params.push(...query.relTypes);
      }
      if (query.origins !== undefined) {
        clauses.push(`r.origin IN (${query.origins.map(() => '?').join(', ')})`);
        params.push(...query.origins);
      }
      const relations = this.readRelations(`WHERE ${clauses.join(' AND ')}`, params, collectedIds);
      const nextFrontier: string[] = [];
      for (const relation of relations) {
        collected.push(relation);
        for (const end of [relation.sourceId, relation.targetId]) {
          if (!seen.has(end)) {
            seen.add(end);
            nextFrontier.push(end);
          }
        }
      }
      frontier = nextFrontier;
    }
    return query.limit === undefined ? collected : collected.slice(0, query.limit);
  }

  /**
   * The collisions, each naming the definition in effect.
   *
   * THE WINNER IS JOINED, NOT STORED. `entity.doc_id` already says which card
   * owns the id, and `entity_id` is a primary key there, so that join yields
   * exactly one kept path per collision and cannot disagree with a second copy
   * — because there is no second copy. The joins are INNER on purpose: the
   * foreign key from `entity_duplicate.entity_id` means a row with no entity
   * behind it does not exist, and an OUTER join would be code handling a state
   * the schema forbids.
   *
   * ORDER IS PART OF THE CONTRACT (see {@link DuplicateEntityRecord}), so it is
   * sorted in SQL under the default `BINARY` collation — which the in-memory
   * adapter matches with a code-unit comparison, and which `localeCompare`
   * would not.
   */
  getDuplicateEntities(): DuplicateEntityRecord[] {
    const rows = this.db
      .prepare(
        `SELECT dup.entity_id AS entity_id, kept.rel_path AS kept_rel_path, excluded.rel_path AS excluded_rel_path
         FROM entity_duplicate dup
         JOIN entity e          ON e.entity_id      = dup.entity_id
         JOIN document kept     ON kept.doc_id      = e.doc_id
         JOIN document excluded ON excluded.doc_id  = dup.doc_id
         ORDER BY dup.entity_id, excluded.rel_path`
      )
      .all() as { entity_id: string; kept_rel_path: string; excluded_rel_path: string }[];
    const byId = new Map<string, DuplicateEntityRecord>();
    for (const row of rows) {
      const record = byId.get(row.entity_id);
      if (record === undefined) {
        byId.set(row.entity_id, {
          entityId: row.entity_id,
          keptRelPath: row.kept_rel_path,
          excludedRelPaths: [row.excluded_rel_path]
        });
        continue;
      }
      record.excludedRelPaths.push(row.excluded_rel_path);
    }
    // `Map` preserves insertion order, and insertion followed `ORDER BY
    // dup.entity_id` — so the grouping does not have to re-sort what SQL
    // already sorted.
    return [...byId.values()];
  }

  /** Shared relation reader: one query for the rows, one for their evidence. */
  private readRelations(
    where: string,
    params: (string | number)[],
    skipIds?: Set<number>
  ): NarrativeRelation[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, d.rel_path AS doc_rel_path FROM relation r
         LEFT JOIN document d ON d.doc_id = r.doc_id ${where} ORDER BY r.relation_id`
      )
      .all(...params) as unknown as RelationRow[];
    const kept = rows.filter(row => {
      if (skipIds?.has(row.relation_id)) {
        return false;
      }
      skipIds?.add(row.relation_id);
      return true;
    });
    if (kept.length === 0) {
      return [];
    }
    const placeholders = kept.map(() => '?').join(', ');
    const evidenceRows = this.db
      .prepare(
        // ORDERED DOWN TO A TOTAL KEY, not just by relation (TASK-022 WP-4a).
        // `ORDER BY re.relation_id` alone left the evidence rows of ONE
        // relation in whatever order the engine chose, while the in-memory
        // adapter returns them in the order they were written. That was
        // invisible while every relation had exactly one evidence row — and it
        // stopped being invisible when co-occurrence edges arrived, which carry
        // one row per shared chapter. `d.rel_path` rather than `re.doc_id`,
        // because a row id is an insertion artefact and a path is the identity
        // the producer sorts by.
        `SELECT re.*, d.rel_path AS doc_rel_path FROM relation_evidence re
         JOIN document d ON d.doc_id = re.doc_id
         WHERE re.relation_id IN (${placeholders})
         ORDER BY re.relation_id, d.rel_path, re.start_line, re.start_char`
      )
      .all(...kept.map(row => row.relation_id)) as unknown as EvidenceRow[];
    const evidenceByRelation = new Map<number, EvidenceRef[]>();
    for (const row of evidenceRows) {
      const list = evidenceByRelation.get(row.relation_id) ?? [];
      list.push(toEvidence(row.doc_rel_path, row));
      evidenceByRelation.set(row.relation_id, list);
    }
    return kept.map(row => {
      const relation: NarrativeRelation = {
        sourceId: row.source_id,
        targetId: row.target_id,
        relType: row.rel_type,
        origin: row.origin as NarrativeOrigin,
        sourceResolved: row.source_resolved !== 0,
        targetResolved: row.target_resolved !== 0,
        evidence: evidenceByRelation.get(row.relation_id) ?? []
      };
      if (row.confidence !== null) {
        relation.confidence = row.confidence;
      }
      if (row.doc_rel_path !== null) {
        relation.ownerPath = row.doc_rel_path;
      }
      // EVERY ONE OF THE FOUR IS `!== null`, NEVER `??` AND NEVER TRUTHINESS.
      // `list_position` is legitimately `0` — the FIRST owner of an artifact,
      // which is the commonest value there is — and a truthy test would drop it
      // and leave the whole chain looking like it starts at the second hop. The
      // three strings are author prose and may legitimately be empty.
      if (row.list_position !== null) {
        relation.listPosition = row.list_position;
      }
      if (row.story_time_from !== null) {
        relation.storyTimeFrom = row.story_time_from;
      }
      if (row.story_time_to !== null) {
        relation.storyTimeTo = row.story_time_to;
      }
      if (row.note !== null) {
        relation.note = row.note;
      }
      return relation;
    });
  }

  // ---- writes -----------------------------------------------------------

  private docIdOf(relPath: string): number {
    const row = this.db.prepare('SELECT doc_id FROM document WHERE rel_path = ?').get(relPath) as
      | { doc_id: number }
      | undefined;
    if (row === undefined) {
      throw new NarrativeIndexStoreError(
        'constraint-violation',
        `document '${relPath}' is not indexed`
      );
    }
    return row.doc_id;
  }

  private makeWriter(committedGeneration: number): NarrativeIndexWriter {
    return {
      putDocument: (input: IndexedDocumentInput): number => {
        const existing = this.db.prepare('SELECT doc_id FROM document WHERE rel_path = ?').get(input.relPath) as
          | { doc_id: number }
          | undefined;
        if (existing) {
          this.db
            .prepare(
              `UPDATE document SET kind = ?, size_bytes = ?, mtime_ms = ?, content_hash = ?,
               chapter_order = ?, title = ?, manifest_included = ?, build_included = ?,
               indexed_at = ?, generation = ?
               WHERE doc_id = ?`
            )
            .run(
              input.kind,
              input.sizeBytes,
              input.mtimeMs,
              input.contentHash,
              input.chapterOrder ?? null,
              input.title ?? null,
              (input.manifestIncluded ?? true) ? 1 : 0,
              (input.buildIncluded ?? true) ? 1 : 0,
              input.indexedAt,
              committedGeneration,
              existing.doc_id
            );
          return existing.doc_id;
        }
        const inserted = this.db
          .prepare(
            `INSERT INTO document (rel_path, kind, size_bytes, mtime_ms, content_hash,
             chapter_order, title, manifest_included, build_included, indexed_at, generation)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.relPath,
            input.kind,
            input.sizeBytes,
            input.mtimeMs,
            input.contentHash,
            input.chapterOrder ?? null,
            input.title ?? null,
            (input.manifestIncluded ?? true) ? 1 : 0,
            (input.buildIncluded ?? true) ? 1 : 0,
            input.indexedAt,
            committedGeneration
          );
        return Number(inserted.lastInsertRowid);
      },
      deleteDocument: (relPath: string): void => {
        this.db.prepare('DELETE FROM document WHERE rel_path = ?').run(relPath);
      },
      /**
       * Re-key a document, keeping `doc_id` (TASK-022 WP-4b, ОВ-3 step 5).
       *
       * ONE `UPDATE` MOVES ALMOST EVERYTHING, because `rel_path` lives in one
       * table and `mention`, `relation`, `relation_evidence` and `entity` all
       * hang off `doc_id` — which is exactly what ОВ-3 promises and why a paired
       * move costs no extraction.
       *
       * ALMOST. `entity.payload` carries a DENORMALIZED `sourcePath` inside its
       * JSON, because `getEntity` returns `JSON.parse(payload)` verbatim. That
       * column is the one place ОВ-3's "строки entity не трогаются вообще" is
       * not literally true, and leaving it would make a moved card report the
       * path it used to live at — visible to the reader as a dead navigation
       * target, and invisible to any test that only looked at `document`. It is
       * repaired here rather than at read time so the two adapters agree without
       * either of them owning a second source of truth.
       */
      moveDocument: (from: string, to: string, freshness: DocumentMoveFreshness): void => {
        const source = this.db.prepare('SELECT doc_id FROM document WHERE rel_path = ?').get(from) as
          | { doc_id: number }
          | undefined;
        if (source === undefined) {
          throw new NarrativeIndexStoreError(
            'constraint-violation',
            `cannot move document '${from}': it is not indexed`
          );
        }
        const destination = this.db.prepare('SELECT doc_id FROM document WHERE rel_path = ?').get(to) as
          | { doc_id: number }
          | undefined;
        if (destination !== undefined) {
          throw new NarrativeIndexStoreError(
            'constraint-violation',
            `cannot move document '${from}' onto '${to}': the destination is already indexed (UNIQUE(rel_path))`
          );
        }
        this.db
          .prepare(
            `UPDATE document SET rel_path = ?, size_bytes = ?, mtime_ms = ?, content_hash = ?,
             chapter_order = ?, title = ?, manifest_included = ?, build_included = ?,
             indexed_at = ?, generation = ?
             WHERE doc_id = ?`
          )
          .run(
            to,
            freshness.sizeBytes,
            freshness.mtimeMs,
            freshness.contentHash,
            freshness.chapterOrder ?? null,
            freshness.title ?? null,
            (freshness.manifestIncluded ?? true) ? 1 : 0,
            (freshness.buildIncluded ?? true) ? 1 : 0,
            freshness.indexedAt,
            committedGeneration,
            source.doc_id
          );
        const owned = this.db
          .prepare('SELECT entity_id, payload FROM entity WHERE doc_id = ?')
          .all(source.doc_id) as unknown as { entity_id: string; payload: string }[];
        const repair = this.db.prepare('UPDATE entity SET payload = ? WHERE entity_id = ?');
        for (const row of owned) {
          const entity = JSON.parse(row.payload) as NarrativeEntity;
          entity.sourcePath = to;
          repair.run(JSON.stringify(entity), row.entity_id);
        }
      },
      clearDocumentContent: (relPath: string): void => {
        const row = this.db.prepare('SELECT doc_id FROM document WHERE rel_path = ?').get(relPath) as
          | { doc_id: number }
          | undefined;
        if (row === undefined) {
          return;
        }
        this.db.prepare('DELETE FROM mention WHERE doc_id = ?').run(row.doc_id);
        // `relation_evidence` goes with the relation by its own cascade; the
        // evidence rows of a DERIVED relation that merely happens to cite this
        // document are left alone, because the caller recomputes the whole
        // derived layer immediately afterwards.
        this.db.prepare('DELETE FROM relation WHERE doc_id = ?').run(row.doc_id);
      },
      clearDerivedRelations: (): void => {
        this.db.prepare("DELETE FROM relation WHERE origin = 'derived'").run();
      },
      putEntity: (entity: NarrativeEntity): void => {
        const docId = this.docIdOf(entity.sourcePath);
        this.db
          .prepare(
            `INSERT INTO entity (entity_id, type, name, origin, doc_id, summary, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(entity_id) DO UPDATE SET
               type = excluded.type, name = excluded.name, origin = excluded.origin,
               doc_id = excluded.doc_id, summary = excluded.summary, payload = excluded.payload`
          )
          .run(
            entity.id,
            entity.type,
            entity.name,
            entity.origin,
            docId,
            entity.summary ?? null,
            JSON.stringify(entity)
          );
        this.db.prepare('DELETE FROM entity_alias WHERE entity_id = ?').run(entity.id);
        const alias = this.db.prepare('INSERT OR IGNORE INTO entity_alias (entity_id, alias) VALUES (?, ?)');
        for (const value of entity.aliases) {
          alias.run(entity.id, value);
        }
      },
      // Both refusals this call owes the port — "no entity row" and "the
      // excluded card IS the kept card" — come from the SCHEMA, not from here:
      // the first from the foreign key on `entity_id`, the second from
      // `entity_duplicate_excludes_the_kept_card`. Checking them in this method
      // too would move the enforcement into a layer a repair script bypasses,
      // and the schema teeth would then be testing this file.
      putDuplicateEntity: (entityId: string, excludedRelPath: string): void => {
        this.db
          .prepare('INSERT OR REPLACE INTO entity_duplicate (entity_id, doc_id) VALUES (?, ?)')
          .run(entityId, this.docIdOf(excludedRelPath));
      },
      putMention: (mention: NarrativeMention): void => {
        const docId = this.docIdOf(mention.evidence.path);
        const range = mention.evidence.range;
        const labelRange = mention.labelRange;
        this.db
          .prepare(
            `INSERT INTO mention (doc_id, entity_id, tag_kind, raw, label, resolved,
             start_line, start_char, end_line, end_char,
             label_start_line, label_start_char, label_end_line, label_end_char, evidence_kind)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            docId,
            mention.entityId,
            mention.kind ?? null,
            mention.raw,
            mention.label ?? null,
            mention.resolved ? 1 : 0,
            range?.start.line ?? null,
            range?.start.character ?? null,
            range?.end.line ?? null,
            range?.end.character ?? null,
            labelRange?.start.line ?? null,
            labelRange?.start.character ?? null,
            labelRange?.end.line ?? null,
            labelRange?.end.character ?? null,
            mention.evidence.evidenceKind
          );
      },
      putRelation: (relation: NarrativeRelation): number => {
        if (relation.evidence.length === 0) {
          // The DDL cannot express "at least one evidence row" — a row that does
          // not exist violates no constraint. This is therefore the ONE relation
          // invariant that has to live in the adapter, and saying so here is
          // better than letting it read like an oversight.
          throw new NarrativeIndexStoreError(
            'constraint-violation',
            `relation ${relation.sourceId}->${relation.targetId} carries no evidence`
          );
        }
        const docId = relation.ownerPath === undefined ? null : this.docIdOf(relation.ownerPath);
        const listPosition = relation.listPosition ?? null;
        // `relation_identity` treats a NULL doc_id and a NULL list_position as
        // -1, so the upsert has to find the existing row the same way rather
        // than relying on `ON CONFLICT`, which cannot name an expression index.
        //
        // `list_position` JOINS THE LOOKUP IN v3 (UR-031). Without it the second
        // `ownership:` entry naming an owner the card already named resolves to
        // the FIRST row and overwrites its story-time labels and note — the
        // artifact-returns-to-a-previous-holder beat, silently collapsed.
        const existing = this.db
          .prepare(
            `SELECT relation_id FROM relation
             WHERE source_id = ? AND target_id = ? AND rel_type = ? AND origin = ?
               AND COALESCE(doc_id, -1) = COALESCE(?, -1)
               AND COALESCE(list_position, -1) = COALESCE(?, -1)`
          )
          .get(
            relation.sourceId,
            relation.targetId,
            relation.relType,
            relation.origin,
            docId,
            listPosition
          ) as { relation_id: number } | undefined;
        let relationId: number;
        if (existing) {
          relationId = existing.relation_id;
          this.db
            .prepare(
              `UPDATE relation SET confidence = ?, source_resolved = ?, target_resolved = ?,
               story_time_from = ?, story_time_to = ?, note = ? WHERE relation_id = ?`
            )
            .run(
              relation.confidence ?? null,
              relation.sourceResolved ? 1 : 0,
              relation.targetResolved ? 1 : 0,
              relation.storyTimeFrom ?? null,
              relation.storyTimeTo ?? null,
              relation.note ?? null,
              relationId
            );
          this.db.prepare('DELETE FROM relation_evidence WHERE relation_id = ?').run(relationId);
        } else {
          const inserted = this.db
            .prepare(
              `INSERT INTO relation (source_id, target_id, rel_type, origin, confidence, doc_id,
               source_resolved, target_resolved, list_position, story_time_from, story_time_to, note)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              relation.sourceId,
              relation.targetId,
              relation.relType,
              relation.origin,
              relation.confidence ?? null,
              docId,
              relation.sourceResolved ? 1 : 0,
              relation.targetResolved ? 1 : 0,
              listPosition,
              relation.storyTimeFrom ?? null,
              relation.storyTimeTo ?? null,
              relation.note ?? null
            );
          relationId = Number(inserted.lastInsertRowid);
        }
        const insertEvidence = this.db.prepare(
          `INSERT OR REPLACE INTO relation_evidence
           (relation_id, doc_id, start_line, start_char, end_line, end_char, evidence_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const evidence of relation.evidence) {
          const range = evidence.range;
          insertEvidence.run(
            relationId,
            this.docIdOf(evidence.path),
            range?.start.line ?? null,
            range?.start.character ?? null,
            range?.end.line ?? null,
            range?.end.character ?? null,
            evidence.evidenceKind
          );
        }
        return relationId;
      },
      clearAll: (): void => {
        for (const table of ['relation_evidence', 'relation', 'mention', 'entity_alias', 'entity_duplicate', 'entity']) {
          this.db.exec(`DELETE FROM ${table}`);
        }
      }
    };
  }
}

// --------------------------------------------------------------------------
// The lock, readable without an open store
// --------------------------------------------------------------------------

interface ForeignLock {
  bootId: string;
  pid: number;
  heartbeatAt: number;
}

function readForeignWriterLock(
  db: DatabaseSync,
  ownBootId: string,
  now: number,
  staleAfterMs: number
): ForeignLock | undefined {
  const read = (key: string): string | undefined => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
  };
  const bootId = read(META_KEYS.writerBootId);
  if (bootId === undefined || bootId === ownBootId) {
    return undefined;
  }
  const heartbeatAt = Number(read(META_KEYS.writerHeartbeatAt) ?? '0');
  if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > staleAfterMs) {
    // An abandoned lock. Taking it over is the recovery a lock FILE cannot give
    // after `kill -9`.
    return undefined;
  }
  return { bootId, pid: Number(read(META_KEYS.writerPid) ?? '0'), heartbeatAt };
}

/**
 * Whether the writer-lock row in `meta` may be CLAIMED by `ownBootId` right
 * now (ISS-357's {@link SqliteNarrativeIndexStore.tryReclaimWriterRole}).
 *
 * DELIBERATELY NOT THE SAME QUESTION AS {@link readForeignWriterLock}. That
 * function answers "is someone else alive right now" and returns `undefined`
 * both when the row is genuinely absent AND when the row is this caller's
 * OWN — the two are indistinguishable to a function that only needs to know
 * whether to step down. A caller deciding whether to RECLAIM the role cannot
 * conflate those: a row that already belongs to us is what `transaction()`'s
 * lost compare-and-set leaves behind, and treating that as "free to claim"
 * would silently reclaim a role this same instance was just told to give up
 * — the exact failure the CAS exists to detect. So this function returns
 * `true` only for "no row at all" and "someone else's row, and stale"; a
 * live foreign row and this instance's OWN row both answer `false`.
 *
 * EXPORTED for its own direct test coverage of all four states — the same
 * reason {@link isRebuildBlockedByForeignWriter} is exported rather than
 * private: the state this decides is reached from inside a `BEGIN IMMEDIATE`
 * transaction as well as from a plain read, and asserting all four outcomes
 * against the transaction path specifically would need a second live
 * process for no better reason than restating what this function alone
 * already determines.
 */
export function isLockRowReclaimable(db: DatabaseSync, ownBootId: string, now: number, staleAfterMs: number): boolean {
  const read = (key: string): string | undefined => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value;
  };
  const bootId = read(META_KEYS.writerBootId);
  if (bootId === undefined) {
    return true;
  }
  if (bootId === ownBootId) {
    // Our own row: a CAS-loss step-down, not a foreign lock. Out of scope —
    // see the doc comment above.
    return false;
  }
  const heartbeatAt = Number(read(META_KEYS.writerHeartbeatAt) ?? '0');
  return !Number.isFinite(heartbeatAt) || now - heartbeatAt > staleAfterMs;
}

/**
 * Whether a rebuild of `databaseFile` must be refused right now.
 *
 * EXPORTED SEPARATELY FROM THE STORE ON PURPOSE. The refusal has to be
 * answerable when there is NO store instance — the hard case is precisely the
 * one where opening failed and the user is looking at an error in the status
 * bar with a Rebuild button under it. The rule is stated BY OWNERSHIP, not by
 * state: a live foreign lock blocks, whatever state produced it; an expired one
 * does not block, or "always refuse" would pass a test written only against the
 * live case.
 */
export function isRebuildBlockedByForeignWriter(
  databaseFile: string,
  options: { now: number; bootId: string; staleAfterMs?: number }
): boolean {
  const file = resolvePath(databaseFile);
  if (!existsSync(file)) {
    return false;
  }
  try {
    if (!statSync(file).isFile()) {
      return false;
    }
  } catch {
    return false;
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { open: true, readOnly: true, enableForeignKeyConstraints: false });
  } catch {
    // Unreadable is not the same as owned. Refusing here would make an
    // unreadable file permanently unrepairable.
    return false;
  }
  try {
    const lock = readForeignWriterLock(
      db,
      options.bootId,
      options.now,
      options.staleAfterMs ?? WRITER_LOCK_STALE_AFTER_MS
    );
    return lock !== undefined;
  } catch {
    return false;
  } finally {
    db.close();
  }
}
