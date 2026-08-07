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
 *
 * THIS CONSTANT IS THE ONLY PLACE THE NUMBER IS WRITTEN DOWN. tech_spec ОВ-1
 * prints a `PRAGMA user_version = N` line as an ILLUSTRATION of the write below,
 * not as a second source — an earlier edition of that section printed `1` while
 * this constant already held `2`, and the divergence survived two phases
 * unnoticed because the prose read as a claim rather than as an example.
 *
 * v3 (UR-031) added `document.title`, four chronology columns on `relation`, and
 * `list_position` to `relation_identity`. No data migration accompanies it: a
 * `user_version` mismatch already rebuilds the whole file from the manuscript.
 *
 * v4 (gh#47) added `document.build_included`. Same absence of a migration, same
 * reason. WHO OWNS THE NUMBER: two open plans (gh#48, gh#49) each proposed
 * taking "v4" independently, which this constant's own history says is exactly
 * how a version number quietly forks. The epic's rule is that the number goes to
 * whoever migrates FIRST and the others take the next one — that is gh#47 here,
 * so gh#48 takes v5. Plans state "the next bump", never a literal.
 */
export const NARRATIVE_INDEX_SCHEMA_VERSION = 4;

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
  -- v3: the manifest's display title. NULLABLE for the same reason
  -- \`chapter_order\` is: a \`content/\` chapter the manifest does not name has
  -- neither. NULL and '' are DIFFERENT answers and nothing may fold them.
  title             TEXT,
  manifest_included INTEGER NOT NULL DEFAULT 1,
  -- v4 (gh#47): part of the BUILT BOOK, which is NOT the same question as
  -- \`manifest_included\`. An \`include: false\` entry is still LISTED, so it is
  -- stored with \`manifest_included = 1\` and a real \`chapter_order\`; only this
  -- column says it is out of the build. Both are read: \`manifest_included\` by
  -- the context assembler and the AI tools' document answer, this one by
  -- manuscript ordering, which means order in the book being built.
  build_included    INTEGER NOT NULL DEFAULT 1,
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

-- The LOSERS of an id collision. The WINNER is not a column here: it is the
-- card that owns the \`entity\` row, named once by the foreign key below.
--
-- THAT FOREIGN KEY IS WHY \`DuplicateEntityRecord.keptRelPath\` CAN BE REQUIRED.
-- Without it a duplicate row could outlive the entity it lost to — delete the
-- winning card and the row would still be there, naming a collision no
-- definition is in effect for. With it, the winner's card cascades to the
-- entity and the entity cascades to here, so "a collision with no winner" is
-- not a state to handle but a state that cannot be written.
CREATE TABLE entity_duplicate (
  entity_id TEXT    NOT NULL REFERENCES entity(entity_id) ON DELETE CASCADE,
  doc_id    INTEGER NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, doc_id)
) STRICT;

-- One card cannot be both the winner and a loser of the same collision. This
-- is a two-table invariant, so it is a TRIGGER rather than a CHECK — but it is
-- still in the DDL, for the reason the module note gives: an adapter can be
-- bypassed by a migration or by a second implementation of the port, and the
-- shape it protects (\`keptRelPath\` never appearing in \`excludedRelPaths\`) is a
-- promise the READER is entitled to. Both directions are covered, because the
-- entity upsert can move the winner onto a card already recorded as excluded.
CREATE TRIGGER entity_duplicate_excludes_the_kept_card
BEFORE INSERT ON entity_duplicate
WHEN EXISTS (SELECT 1 FROM entity WHERE entity.entity_id = NEW.entity_id AND entity.doc_id = NEW.doc_id)
BEGIN
  SELECT RAISE(ABORT, 'entity_duplicate names the card that owns the entity');
END;

CREATE TRIGGER entity_insert_is_not_an_excluded_card
BEFORE INSERT ON entity
WHEN EXISTS (SELECT 1 FROM entity_duplicate
             WHERE entity_duplicate.entity_id = NEW.entity_id AND entity_duplicate.doc_id = NEW.doc_id)
BEGIN
  SELECT RAISE(ABORT, 'entity insert: this card is already excluded from this id');
END;

CREATE TRIGGER entity_update_is_not_an_excluded_card
BEFORE UPDATE ON entity
WHEN EXISTS (SELECT 1 FROM entity_duplicate
             WHERE entity_duplicate.entity_id = NEW.entity_id AND entity_duplicate.doc_id = NEW.doc_id)
BEGIN
  SELECT RAISE(ABORT, 'entity update: this card is already excluded from this id');
END;

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
  -- v3 (UR-031): the ownership chronology. All four are AUTHOR-WRITTEN TEXT
  -- that extraction already produced and the v2 storage boundary discarded,
  -- while the Narrative Map went on rendering them from its own file read.
  --
  -- NONE OF THEM IS GUARDED BY A CHECK, and that follows the rule this module's
  -- header states. "An explicit relation read from a list must have a position"
  -- is an invariant of EXTRACTION, not of structure: a derived edge legitimately
  -- has none, and a future third producer may legitimately have none either. A
  -- CHECK tying \`list_position IS NOT NULL\` to \`origin <> 'derived'\` would
  -- forbid that producer before it exists and would be deleted by the first
  -- person to meet it — guarding right up until its first real test.
  list_position   INTEGER,
  story_time_from TEXT,
  story_time_to   TEXT,
  note            TEXT,
  CHECK (origin = 'derived' OR doc_id IS NOT NULL)
) STRICT;
-- \`list_position\` IS PART OF IDENTITY (v3). Without it, two \`ownership:\`
-- entries naming the SAME owner — an artifact returning to a previous holder,
-- which is an ordinary story beat — collide on this index, \`putRelation\`
-- resolves the collision with an UPDATE, and the second entry's story-time
-- labels and note overwrite the first's. Adding the columns without adding this
-- term would have stored the chronology and still lost the beat.
--
-- COALESCE rather than NOT NULL: a derived edge has no list to have a position
-- in. The sentinel cannot collide with a real value, because real positions are
-- zero-based and non-negative.
CREATE UNIQUE INDEX relation_identity ON relation(source_id, target_id, rel_type, origin,
                                                  COALESCE(doc_id, -1),
                                                  COALESCE(list_position, -1));
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
