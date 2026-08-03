/**
 * The index schema, as code (TASK-022 WP-3, tech_spec ОВ-1).
 *
 * ONE PRINTED EDITION. `tech_spec` ОВ-1 states the rule for the document; this
 * module is its executable twin, and the same rule applies here: the DDL text
 * below is the ONLY place the schema is written down in this package. Nothing
 * else builds `CREATE TABLE` strings, and nothing else hard-codes a column
 * name that the DDL does not already contain.
 *
 * THE TEXT IS EXPORTED, AND THAT IS DELIBERATE. Several of the schema teeth are
 * of the form "a schema WITHOUT this constraint must fail the test" — a
 * rejecting case that can only be run by PERTURBING the real DDL and re-running
 * the same insert. Exporting the text is what makes that possible without
 * keeping a second, hand-copied schema in the test folder, which would drift
 * and would then be testing itself.
 *
 * WHERE CONSTRAINTS LIVE (ISS-318). Structural invariants that cannot be
 * recovered from the source files are enforced HERE, in the DDL, because an
 * adapter can be bypassed by a migration or a repair script and a schema cannot.
 * VOCABULARIES are NOT: `origin` values and `rel_type` values are checked by
 * `ajv` at the moment a file is read, where there is a path and a line number to
 * show the author — a `CHECK` firing three layers down would produce
 * `SQLITE_CONSTRAINT` and no file name.
 */

/**
 * Schema version, authoritative in `PRAGMA user_version`.
 *
 * It lives in the pragma rather than in a `meta` row so that it remains
 * readable by a future version that renames `meta`. A mismatch is not an error
 * to recover from — the database is a rebuildable cache, so a mismatch is
 * simply a rebuild with cause `schema-version-mismatch`.
 */
export const NARRATIVE_INDEX_SCHEMA_VERSION = 1;

/**
 * Pragmas applied to every connection, in this order.
 *
 * `busy_timeout` is set by PRAGMA and NOT by the constructor's `timeout`
 * option: the pinned API subset (ОВ-7) allows only `open`, `readOnly` and
 * `enableForeignKeyConstraints` on the constructor, and a pragma is portable
 * across every Node version in range.
 *
 * `synchronous = NORMAL` under WAL means a PROCESS crash is safe while an OS
 * crash may cost the last transaction. For a cache that can be rebuilt from
 * Markdown and YAML that is the right trade, not an accepted risk.
 */
export const NARRATIVE_INDEX_PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL'
];

/**
 * The DDL.
 *
 * Every `CHECK` here has a tooth in the node run that attempts the forbidden
 * state and asserts SQLITE refuses it. A `CHECK` nobody has violated is a
 * `CHECK` nobody has tested.
 */
export const NARRATIVE_INDEX_DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE document (
  doc_id            INTEGER PRIMARY KEY,
  rel_path          TEXT    NOT NULL UNIQUE,
  kind              TEXT    NOT NULL,
  size_bytes        INTEGER NOT NULL,
  mtime_ms          INTEGER NOT NULL,
  content_hash      TEXT    NOT NULL,
  chapter_order     INTEGER,
  manifest_included INTEGER NOT NULL DEFAULT 1,
  indexed_at        INTEGER NOT NULL,
  generation        INTEGER NOT NULL
) STRICT;
CREATE INDEX document_chapter_order ON document(chapter_order) WHERE chapter_order IS NOT NULL;
CREATE INDEX document_kind          ON document(kind);

CREATE TABLE entity (
  entity_id TEXT    NOT NULL PRIMARY KEY,
  type      TEXT    NOT NULL,
  name      TEXT    NOT NULL,
  origin    TEXT    NOT NULL,
  doc_id    INTEGER NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,
  summary   TEXT,
  payload   TEXT    NOT NULL
) STRICT;
CREATE INDEX entity_type    ON entity(type);
CREATE INDEX entity_name_ci ON entity(name COLLATE NOCASE);
CREATE INDEX entity_doc     ON entity(doc_id);
CREATE INDEX entity_origin  ON entity(origin);

CREATE TABLE entity_alias (
  entity_id TEXT NOT NULL REFERENCES entity(entity_id) ON DELETE CASCADE,
  alias     TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias)
) STRICT;
CREATE INDEX entity_alias_ci ON entity_alias(alias COLLATE NOCASE);

CREATE TABLE entity_duplicate (
  entity_id TEXT    NOT NULL,
  doc_id    INTEGER NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, doc_id)
) STRICT;

CREATE TABLE mention (
  mention_id INTEGER PRIMARY KEY,
  doc_id     INTEGER NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,
  entity_id  TEXT    NOT NULL,
  tag_kind   TEXT,
  raw        TEXT    NOT NULL,
  label      TEXT,
  resolved   INTEGER NOT NULL,
  start_line INTEGER, start_char INTEGER,
  end_line   INTEGER, end_char   INTEGER,
  label_start_line INTEGER, label_start_char INTEGER,
  label_end_line   INTEGER, label_end_char   INTEGER,
  evidence_kind TEXT NOT NULL,
  CHECK ((evidence_kind = 'range') = (start_line IS NOT NULL)),
  CHECK (label_start_line IS NULL OR evidence_kind = 'range')
) STRICT;
CREATE INDEX mention_doc        ON mention(doc_id);
CREATE INDEX mention_entity_doc ON mention(entity_id, doc_id);
CREATE INDEX mention_broken     ON mention(doc_id) WHERE resolved = 0;

CREATE TABLE relation (
  relation_id     INTEGER PRIMARY KEY,
  source_id       TEXT    NOT NULL,
  target_id       TEXT    NOT NULL,
  rel_type        TEXT    NOT NULL,
  origin          TEXT    NOT NULL,
  confidence      REAL,
  doc_id          INTEGER REFERENCES document(doc_id) ON DELETE CASCADE,
  source_resolved INTEGER NOT NULL,
  target_resolved INTEGER NOT NULL,
  CHECK (origin = 'derived' OR doc_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX relation_identity ON relation(source_id, target_id, rel_type, origin,
                                                  COALESCE(doc_id, -1));
CREATE INDEX relation_source ON relation(source_id);
CREATE INDEX relation_target ON relation(target_id);
CREATE INDEX relation_origin ON relation(origin);
CREATE INDEX relation_broken ON relation(doc_id)
  WHERE source_resolved = 0 OR target_resolved = 0;

CREATE TABLE relation_evidence (
  relation_id INTEGER NOT NULL REFERENCES relation(relation_id) ON DELETE CASCADE,
  doc_id      INTEGER NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,
  start_line    INTEGER, start_char INTEGER,
  end_line      INTEGER, end_char   INTEGER,
  evidence_kind TEXT NOT NULL,
  CHECK ((evidence_kind = 'range') = (start_line IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX relation_evidence_identity ON relation_evidence(
  relation_id, doc_id, COALESCE(start_line, -1), COALESCE(start_char, -1));
`;

/**
 * ONE DEPARTURE FROM THE PRINTED DDL, AND WHY.
 *
 * `tech_spec` ОВ-1 writes the identity of `relation_evidence` as a table-level
 * `PRIMARY KEY (relation_id, doc_id, COALESCE(start_line, -1), COALESCE(start_char, -1))`.
 * SQLite REFUSES that statement outright — verified, not inferred:
 *
 *     DDL FAIL: expressions prohibited in PRIMARY KEY and UNIQUE constraints
 *
 * The constraint is expressible one line down, as a UNIQUE INDEX, where SQLite
 * does allow expressions — and that is what the DDL above uses. The SEMANTICS
 * are identical (one evidence row per relation, document and start position,
 * with every coordinate-less evidence collapsing onto a single slot), and
 * `INSERT OR REPLACE` resolves against a unique index exactly as it does
 * against a primary key. What changes is that the table now has an implicit
 * `rowid`, which nothing reads.
 *
 * The same expression appears in `relation_identity` and needed no change: it
 * was already written as a `CREATE UNIQUE INDEX`.
 */
export const RELATION_EVIDENCE_IDENTITY_DEPARTURE =
  'PRIMARY KEY with COALESCE expressions is rejected by SQLite; expressed as a UNIQUE INDEX instead';

/**
 * Keys of the `meta` table.
 *
 * `generation` is the compare-and-set target that detects a second writer;
 * the four `writer_*` keys are the cooperative lock. The lock is a ROW rather
 * than an external `.lock` file on purpose: a file lock does not survive a
 * `kill -9` (it leaves a lock nobody will ever release), is unreliable on
 * network filesystems, and — the load-bearing reason — lives OUTSIDE the
 * database's transactional boundary, so it can drift out of step with
 * `generation`. A row is updated atomically WITH the data.
 */
export const META_KEYS = {
  schemaVersion: 'schema_version',
  generation: 'generation',
  workspaceRoot: 'workspace_root',
  engineSqlite: 'engine_sqlite',
  createdAt: 'created_at',
  writerPid: 'writer_pid',
  writerBootId: 'writer_boot_id',
  writerStartedAt: 'writer_started_at',
  writerHeartbeatAt: 'writer_heartbeat_at'
} as const;

/** How often the writer refreshes its heartbeat. */
export const WRITER_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How old a heartbeat may be before the lock counts as abandoned.
 *
 * Three missed beats. This is the recovery a lock FILE cannot offer: a process
 * killed with `kill -9` writes no release, and without an expiry the index
 * would be read-only forever after one crash.
 */
export const WRITER_LOCK_STALE_AFTER_MS = 30_000;
