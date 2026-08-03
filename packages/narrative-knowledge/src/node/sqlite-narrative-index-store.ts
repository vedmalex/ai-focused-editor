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
  type DuplicateEntityRecord,
  type EntityQuery,
  type EvidenceRef,
  type IndexedDocument,
  type IndexedDocumentInput,
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
  | { event: 'rebuild-refused'; reason: 'foreign-writer'; databaseFile: string };

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
  manifest_included: number;
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
    indexedAt: row.indexed_at,
    generation: row.generation
  };
  if (row.chapter_order !== null) {
    document.chapterOrder = row.chapter_order;
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
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  private generation = 0;
  private readOnly = false;
  private corrupted = false;
  private foreignWriter = false;
  private closed = false;

  constructor(options: SqliteNarrativeIndexStoreOptions) {
    this.databaseFile = resolvePath(options.databaseFile);
    this.workspaceRoot = options.workspaceRoot;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.bootId = options.bootId ?? randomUUID();
    this.lockStaleAfterMs = options.lockStaleAfterMs ?? WRITER_LOCK_STALE_AFTER_MS;

    this.db = this.openOrRebuild();
    this.claimWriterLock();

    const interval = options.heartbeatIntervalMs ?? WRITER_HEARTBEAT_INTERVAL_MS;
    if (interval > 0 && !this.readOnly) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), interval);
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

  lifecycle(): NarrativeIndexStoreLifecycle {
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
    // expired while a human was looking at the status bar.
    if (isRebuildBlockedByForeignWriter(this.databaseFile, { now: this.now(), bootId: this.bootId })) {
      this.log({ event: 'rebuild-refused', reason: 'foreign-writer', databaseFile: this.databaseFile });
      throw new NarrativeIndexStoreError(
        'rebuild-refused',
        'the narrative index is owned by another live process; rebuilding would delete its work'
      );
    }
    if (this.readOnly) {
      throw new NarrativeIndexStoreError('read-only', 'this narrative index instance may not write');
    }
    this.db.close();
    this.db = this.buildFresh('absent');
    this.claimWriterLock();
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

  getMentions(query: MentionQuery = {}): NarrativeMention[] {
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
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT m.*, d.rel_path AS doc_rel_path FROM mention m
         JOIN document d ON d.doc_id = m.doc_id ${where} ORDER BY m.mention_id`
      )
      .all(...params) as unknown as MentionRow[];
    return rows.map(toMention);
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

  getDuplicateEntities(): DuplicateEntityRecord[] {
    const rows = this.db
      .prepare(
        `SELECT dup.entity_id AS entity_id, d.rel_path AS rel_path FROM entity_duplicate dup
         JOIN document d ON d.doc_id = dup.doc_id ORDER BY dup.entity_id, d.rel_path`
      )
      .all() as { entity_id: string; rel_path: string }[];
    const byId = new Map<string, string[]>();
    for (const row of rows) {
      const paths = byId.get(row.entity_id) ?? [];
      paths.push(row.rel_path);
      byId.set(row.entity_id, paths);
    }
    return [...byId.entries()].map(([entityId, relPaths]) => ({ entityId, relPaths }));
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
        `SELECT re.*, d.rel_path AS doc_rel_path FROM relation_evidence re
         JOIN document d ON d.doc_id = re.doc_id
         WHERE re.relation_id IN (${placeholders})
         ORDER BY re.relation_id`
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
               chapter_order = ?, manifest_included = ?, indexed_at = ?, generation = ?
               WHERE doc_id = ?`
            )
            .run(
              input.kind,
              input.sizeBytes,
              input.mtimeMs,
              input.contentHash,
              input.chapterOrder ?? null,
              (input.manifestIncluded ?? true) ? 1 : 0,
              input.indexedAt,
              committedGeneration,
              existing.doc_id
            );
          return existing.doc_id;
        }
        const inserted = this.db
          .prepare(
            `INSERT INTO document (rel_path, kind, size_bytes, mtime_ms, content_hash,
             chapter_order, manifest_included, indexed_at, generation)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.relPath,
            input.kind,
            input.sizeBytes,
            input.mtimeMs,
            input.contentHash,
            input.chapterOrder ?? null,
            (input.manifestIncluded ?? true) ? 1 : 0,
            input.indexedAt,
            committedGeneration
          );
        return Number(inserted.lastInsertRowid);
      },
      deleteDocument: (relPath: string): void => {
        this.db.prepare('DELETE FROM document WHERE rel_path = ?').run(relPath);
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
      putDuplicateEntity: (entityId: string, relPath: string): void => {
        this.db
          .prepare('INSERT OR REPLACE INTO entity_duplicate (entity_id, doc_id) VALUES (?, ?)')
          .run(entityId, this.docIdOf(relPath));
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
        // `relation_identity` treats a NULL doc_id as -1, so the upsert has to
        // find the existing row the same way rather than relying on
        // `ON CONFLICT`, which cannot name an expression index.
        const existing = this.db
          .prepare(
            `SELECT relation_id FROM relation
             WHERE source_id = ? AND target_id = ? AND rel_type = ? AND origin = ?
               AND COALESCE(doc_id, -1) = COALESCE(?, -1)`
          )
          .get(relation.sourceId, relation.targetId, relation.relType, relation.origin, docId) as
          | { relation_id: number }
          | undefined;
        let relationId: number;
        if (existing) {
          relationId = existing.relation_id;
          this.db
            .prepare(
              'UPDATE relation SET confidence = ?, source_resolved = ?, target_resolved = ? WHERE relation_id = ?'
            )
            .run(
              relation.confidence ?? null,
              relation.sourceResolved ? 1 : 0,
              relation.targetResolved ? 1 : 0,
              relationId
            );
          this.db.prepare('DELETE FROM relation_evidence WHERE relation_id = ?').run(relationId);
        } else {
          const inserted = this.db
            .prepare(
              `INSERT INTO relation (source_id, target_id, rel_type, origin, confidence, doc_id,
               source_resolved, target_resolved) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              relation.sourceId,
              relation.targetId,
              relation.relType,
              relation.origin,
              relation.confidence ?? null,
              docId,
              relation.sourceResolved ? 1 : 0,
              relation.targetResolved ? 1 : 0
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
