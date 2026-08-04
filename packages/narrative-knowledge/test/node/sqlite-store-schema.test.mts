/**
 * Group A of the ОВ-1 teeth — THE SCHEMA ONES (TASK-022 WP-3).
 *
 * Six teeth, run by DIRECT INSERTION, with no extraction and no `rebuild()`
 * anywhere near them. They belong here and not in WP-4a because that is where
 * they can actually be RUN: WP-3 closes in G3 in parallel with the extraction
 * work, so a tooth needing extracted fixtures would be neither green nor red
 * here — it would be SKIPPED, which is the worst of the three.
 *
 * WHAT MAKES THESE DIFFERENT FROM THE CONTRACT CORE. The contract asserts that
 * a forbidden value is REJECTED. These assert WHO rejects it: SQLite, through a
 * `CHECK` or through `STRICT`. That distinction is the entire reason the
 * constraints were put in the DDL rather than in the adapter — an adapter can
 * be bypassed by a migration, a repair script or a second implementation of the
 * port, and a schema cannot.
 *
 * AND EVERY ONE OF THEM HAS A REJECTING CASE THAT REMOVES THE CONSTRAINT. A
 * `CHECK` nobody ever violated is a `CHECK` nobody has tested; a rejecting case
 * that cannot bite is worse still, so each perturbation asserts THAT IT
 * CHANGED THE DDL TEXT before drawing any conclusion from the result.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  NARRATIVE_INDEX_DDL,
  NARRATIVE_INDEX_PRAGMAS
} from '../../lib/node/narrative-index-schema.js';
import { SqliteNarrativeIndexStore } from '../../lib/node/sqlite-narrative-index-store.js';
import { caught, disposeAll, makeWorkspace, messageOf, must } from './harness.mts';

const opened: { close(): void }[] = [];

function newStore() {
  const workspace = makeWorkspace('schema');
  const store = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0
  });
  opened.push(store);
  return store;
}

/**
 * An in-memory database carrying `ddl`.
 *
 * Used only by the rejecting cases: they need to run the SAME insert against a
 * DELIBERATELY WEAKENED schema and see it pass, which is what proves the
 * constraint — and not something else — was doing the rejecting.
 */
function scratch(ddl: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const pragma of NARRATIVE_INDEX_PRAGMAS) {
    if (pragma.startsWith('PRAGMA journal_mode')) {
      continue; // WAL is meaningless for `:memory:`.
    }
    db.exec(pragma);
  }
  db.exec(ddl);
  db.exec(
    `INSERT INTO document (rel_path, kind, size_bytes, mtime_ms, content_hash, indexed_at, generation)
     VALUES ('manuscript/ch-01.md', 'chapter', 1, 1, 'h', 1, 1)`
  );
  return db;
}

/** Weaken the DDL, ASSERTING THE EDIT LANDED. A `replace` that matched nothing
 *  would leave the rejecting case running against the intact schema and passing
 *  for the wrong reason — the "tooth that will not bite" failure. */
function weaken(find: string, replaceWith: string): string {
  assert.ok(NARRATIVE_INDEX_DDL.includes(find), `the DDL no longer contains ${JSON.stringify(find)}`);
  const weakened = NARRATIVE_INDEX_DDL.replace(find, replaceWith);
  assert.notEqual(weakened, NARRATIVE_INDEX_DDL, 'the perturbation did not change the DDL');
  return weakened;
}

const CHAPTER = 'manuscript/ch-01.md';
const CARD = 'entities/krishna.yaml';

function seed(store: ReturnType<typeof newStore>) {
  store.transaction((writer: any) => {
    writer.putDocument({
      relPath: CHAPTER,
      kind: 'chapter',
      sizeBytes: 1,
      mtimeMs: 1,
      contentHash: 'h',
      indexedAt: 1
    });
    writer.putDocument({
      relPath: CARD,
      kind: 'entity-card',
      sizeBytes: 1,
      mtimeMs: 1,
      contentHash: 'h',
      indexedAt: 1
    });
  });
}

// --------------------------------------------------------------------------
// A5 — document.generation is local
// --------------------------------------------------------------------------

test('A5: re-indexing one document does not touch its neighbours generation', () => {
  const store = newStore();
  seed(store);
  const before = must(store.getDocument(CARD), 'the card document').generation;
  store.transaction((writer: any) =>
    writer.putDocument({
      relPath: CHAPTER,
      kind: 'chapter',
      sizeBytes: 2,
      mtimeMs: 2,
      contentHash: 'h2',
      indexedAt: 2
    })
  );
  assert.equal(must(store.getDocument(CARD), 'the card document').generation, before, 'the neighbour moved');
  assert.ok(
    must(store.getDocument(CHAPTER), 'the chapter document').generation > before,
    'the re-indexed document did not advance'
  );
});

// --------------------------------------------------------------------------
// A6 — STRICT
// --------------------------------------------------------------------------

test('A6: writing a string into an INTEGER column throws — STRICT is on', () => {
  const store = newStore();
  const error = caught(() =>
    store.transaction((writer: any) =>
      writer.putDocument({
        relPath: CHAPTER,
        kind: 'chapter',
        // Unconstructible in TypeScript; the cast is the point, because a
        // `JSON.parse` of untrusted data can produce exactly this.
        sizeBytes: 'not-a-number' as unknown as number,
        mtimeMs: 1,
        contentHash: 'h',
        indexedAt: 1
      })
    )
  );
  assert.ok(error !== undefined, 'the write was accepted');
  assert.match(
    messageOf(error),
    /cannot store TEXT value in INTEGER column/,
    `expected a STRICT refusal from SQLite, got: ${messageOf(error)}`
  );
  assert.equal(store.listDocuments().length, 0, 'the rejected row was still written');
});

test('A6 rejecting case: without STRICT the same write is silently coerced', () => {
  // The failure STRICT prevents is not a crash — it is a SILENT COERCION, and
  // this is what it looks like when the guard is removed.
  const db = scratch(weaken(') STRICT;\nCREATE INDEX document_chapter_order', ');\nCREATE INDEX document_chapter_order'));
  db.exec(
    `INSERT INTO document (rel_path, kind, size_bytes, mtime_ms, content_hash, indexed_at, generation)
     VALUES ('b.md', 'chapter', 'not-a-number', 1, 'h', 1, 1)`
  );
  const row = db.prepare("SELECT size_bytes FROM document WHERE rel_path = 'b.md'").get() as any;
  assert.equal(row.size_bytes, 'not-a-number', 'the non-STRICT table did not accept the text after all');
  db.close();
});

// --------------------------------------------------------------------------
// A7 — CHECK (origin = 'derived' OR doc_id IS NOT NULL)
// --------------------------------------------------------------------------

test("A7: an 'ai-candidate' relation with no owning document is refused BY THE SCHEMA", () => {
  const store = newStore();
  seed(store);
  const error = caught(() =>
    store.transaction((writer: any) =>
      writer.putRelation({
        sourceId: 'krishna',
        targetId: 'arjuna',
        relType: 'ownership',
        origin: 'ai-candidate',
        ownerPath: undefined,
        sourceResolved: true,
        targetResolved: true,
        evidence: [{ path: CARD, evidenceKind: 'whole-file' }]
      })
    )
  );
  assert.ok(error !== undefined, 'the ownerless ai-candidate relation was accepted');
  assert.match(
    messageOf(error),
    /CHECK constraint failed: origin = 'derived' OR doc_id IS NOT NULL/,
    `expected the DDL CHECK to refuse it, got: ${messageOf(error)}`
  );
});

test("A7 paired positive: 'derived' with no owning document IS accepted", () => {
  // Without this half, "refuse every ownerless relation" would pass the test
  // above while breaking the one origin that is meant to have no document.
  const store = newStore();
  seed(store);
  store.transaction((writer: any) =>
    writer.putRelation({
      sourceId: 'krishna',
      targetId: 'arjuna',
      relType: 'co-occurrence',
      origin: 'derived',
      ownerPath: undefined,
      sourceResolved: true,
      targetResolved: true,
      evidence: [{ path: CHAPTER, evidenceKind: 'whole-file' }]
    })
  );
  assert.equal(store.getRelations({ origin: 'derived' }).length, 1);
});

test('A7 rejecting case: without the CHECK the same insert succeeds', () => {
  const db = scratch(
    weaken(
      "  target_resolved INTEGER NOT NULL,\n  CHECK (origin = 'derived' OR doc_id IS NOT NULL)\n) STRICT;",
      '  target_resolved INTEGER NOT NULL\n) STRICT;'
    )
  );
  db.exec(
    `INSERT INTO relation (source_id, target_id, rel_type, origin, source_resolved, target_resolved)
     VALUES ('a', 'b', 'ownership', 'ai-candidate', 1, 1)`
  );
  const row = db.prepare('SELECT COUNT(*) AS n FROM relation').get() as any;
  assert.equal(Number(row.n), 1, 'the weakened schema still refused');
  db.close();
});

// --------------------------------------------------------------------------
// A8 — mention.tag_kind is NULLABLE
// --------------------------------------------------------------------------

test('A8: a mention with no tag kind is accepted — the bare wiki form has none', () => {
  const store = newStore();
  seed(store);
  store.transaction((writer: any) =>
    writer.putMention({
      entityId: 'krishna',
      raw: '[[krishna]]',
      resolved: true,
      evidence: {
        path: CHAPTER,
        evidenceKind: 'range',
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 11 } }
      }
    })
  );
  const stored = store.getMentions()[0];
  assert.equal(stored.kind, undefined, 'a kind materialised out of nowhere');
  assert.equal('kind' in stored, false, 'the key must be ABSENT, not present-and-undefined');
});

test('A8 rejecting case: a schema with tag_kind NOT NULL refuses the bare form', () => {
  // The TASK-013 U-B regression in one line: make `kind` mandatory and the
  // unmarked `[[id]]` form has no valid representation left.
  const db = scratch(weaken('  tag_kind   TEXT,', '  tag_kind   TEXT NOT NULL,'));
  const error = caught(() =>
    db.exec(
      `INSERT INTO mention (doc_id, entity_id, raw, resolved, evidence_kind, start_line, start_char, end_line, end_char)
       VALUES (1, 'krishna', '[[krishna]]', 1, 'range', 1, 0, 1, 11)`
    )
  );
  assert.ok(error !== undefined, 'a NOT NULL tag_kind accepted the bare form anyway');
  assert.match(messageOf(error), /NOT NULL constraint failed: mention\.tag_kind/);
  db.close();
});

// --------------------------------------------------------------------------
// A10 — the relation-evidence CHECK pair
// --------------------------------------------------------------------------

test("A10: relation evidence claiming 'whole-file' while carrying coordinates is refused", () => {
  const store = newStore();
  seed(store);
  const error = caught(() =>
    store.transaction((writer: any) =>
      writer.putRelation({
        sourceId: 'krishna',
        targetId: 'arjuna',
        relType: 'ownership',
        origin: 'explicit',
        ownerPath: CARD,
        sourceResolved: true,
        targetResolved: true,
        // The zero-filling failure ISS-320 is about: no range exists, so the
        // implementation invents one and marks it whole-file anyway.
        evidence: [
          {
            path: CARD,
            evidenceKind: 'whole-file',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
          }
        ]
      })
    )
  );
  assert.ok(error !== undefined, 'a whole-file evidence with coordinates was accepted');
  assert.match(
    messageOf(error),
    /CHECK constraint failed: \(evidence_kind = 'range'\) = \(start_line IS NOT NULL\)/,
    `expected the relation_evidence CHECK, got: ${messageOf(error)}`
  );
});

test("A10: relation evidence claiming 'range' with no coordinates is refused", () => {
  const store = newStore();
  seed(store);
  const error = caught(() =>
    store.transaction((writer: any) =>
      writer.putRelation({
        sourceId: 'krishna',
        targetId: 'arjuna',
        relType: 'ownership',
        origin: 'explicit',
        ownerPath: CARD,
        sourceResolved: true,
        targetResolved: true,
        evidence: [{ path: CARD, evidenceKind: 'range' }]
      })
    )
  );
  assert.ok(error !== undefined, 'a range evidence without coordinates was accepted');
  assert.match(messageOf(error), /CHECK constraint failed/);
});

test("A10 paired positive: 'whole-file' with no coordinates at all IS accepted", () => {
  const store = newStore();
  seed(store);
  store.transaction((writer: any) =>
    writer.putRelation({
      sourceId: 'krishna',
      targetId: 'arjuna',
      relType: 'ownership',
      origin: 'explicit',
      ownerPath: CARD,
      sourceResolved: true,
      targetResolved: true,
      evidence: [{ path: CARD, evidenceKind: 'whole-file' }]
    })
  );
  const stored = store.getRelations()[0];
  assert.equal(stored.evidence[0].evidenceKind, 'whole-file');
  assert.equal(stored.evidence[0].range, undefined);
});

test("A10, THE LITERAL WORDING: a 'range' evidence starting at line 0 IS accepted, and that is correct", () => {
  // tech_spec ОВ-1 states tooth A10 as "a direct insert of start_line = 0 with
  // evidence_kind = 'range' for an ownership relation is refused by the
  // schema". THE PRINTED DDL DOES NOT DO THAT, and could not: the constraint is
  // `(evidence_kind = 'range') = (start_line IS NOT NULL)`, and `0 IS NOT NULL`
  // is true, so the pair holds. It also SHOULD NOT do it — `EvidencePosition` is
  // zero-based, so line 0 is the FIRST LINE and a legitimate range starts there.
  // Nor can a schema know that a relation is an `ownership` one: `rel_type` is
  // an opaque string by decision (UR-013/gh#57).
  //
  // ОВ-1's own rule — "at any divergence the `### DDL` section is correct" —
  // settles it in favour of the DDL. The behaviour is pinned HERE so that it
  // cannot change without someone deciding to change it.
  const store = newStore();
  seed(store);
  store.transaction((writer: any) =>
    writer.putRelation({
      sourceId: 'krishna',
      targetId: 'arjuna',
      relType: 'ownership',
      origin: 'explicit',
      ownerPath: CARD,
      sourceResolved: true,
      targetResolved: true,
      evidence: [
        {
          path: CARD,
          evidenceKind: 'range',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
        }
      ]
    })
  );
  const stored = store.getRelations()[0];
  assert.equal(stored.evidence[0].evidenceKind, 'range');
  assert.equal(stored.evidence[0].range.start.line, 0);
});

test('A10 rejecting case: without the CHECK the mismatched evidence is stored', () => {
  const db = scratch(
    weaken(
      "  evidence_kind TEXT NOT NULL,\n  CHECK ((evidence_kind = 'range') = (start_line IS NOT NULL))\n) STRICT;\nCREATE UNIQUE INDEX relation_evidence_identity",
      '  evidence_kind TEXT NOT NULL\n) STRICT;\nCREATE UNIQUE INDEX relation_evidence_identity'
    )
  );
  db.exec(
    `INSERT INTO relation (relation_id, source_id, target_id, rel_type, origin, doc_id, source_resolved, target_resolved)
     VALUES (1, 'a', 'b', 'ownership', 'explicit', 1, 1, 1)`
  );
  db.exec(
    `INSERT INTO relation_evidence (relation_id, doc_id, start_line, start_char, end_line, end_char, evidence_kind)
     VALUES (1, 1, 0, 0, 0, 0, 'whole-file')`
  );
  const row = db.prepare('SELECT COUNT(*) AS n FROM relation_evidence').get() as any;
  assert.equal(Number(row.n), 1, 'the weakened schema still refused');
  db.close();
});

// --------------------------------------------------------------------------
// A11 — the mention CHECK pair
// --------------------------------------------------------------------------

test('A11: a mention whose evidence_kind disagrees with its coordinates is refused, both ways', () => {
  const store = newStore();
  seed(store);
  const wholeFileWithRange = caught(() =>
    store.transaction((writer: any) =>
      writer.putMention({
        entityId: 'krishna',
        raw: 'krishna',
        resolved: true,
        evidence: {
          path: CHAPTER,
          evidenceKind: 'whole-file',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
        }
      })
    )
  );
  assert.ok(wholeFileWithRange !== undefined, "a 'whole-file' mention with coordinates was accepted");
  assert.match(
    messageOf(wholeFileWithRange),
    /CHECK constraint failed: \(evidence_kind = 'range'\) = \(start_line IS NOT NULL\)/
  );

  const rangeWithout = caught(() =>
    store.transaction((writer: any) =>
      writer.putMention({
        entityId: 'krishna',
        raw: 'krishna',
        resolved: true,
        evidence: { path: CHAPTER, evidenceKind: 'range' }
      })
    )
  );
  assert.ok(rangeWithout !== undefined, "a 'range' mention without coordinates was accepted");
  assert.match(messageOf(rangeWithout), /CHECK constraint failed/);
});

test('A11: a LABEL range on a whole-file mention is refused — forbidden, not merely absent', () => {
  const store = newStore();
  seed(store);
  const error = caught(() =>
    store.transaction((writer: any) =>
      writer.putMention({
        entityId: 'krishna',
        raw: 'krishna',
        resolved: true,
        evidence: { path: CHAPTER, evidenceKind: 'whole-file' },
        labelRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }
      })
    )
  );
  assert.ok(error !== undefined, 'a label range on a whole-file mention was accepted');
  assert.match(
    messageOf(error),
    /CHECK constraint failed: label_start_line IS NULL OR evidence_kind = 'range'/
  );
});

test('A11 rejecting case: without the two CHECKs both forbidden mentions are stored', () => {
  const db = scratch(
    weaken(
      "  evidence_kind TEXT NOT NULL,\n  CHECK ((evidence_kind = 'range') = (start_line IS NOT NULL)),\n  CHECK (label_start_line IS NULL OR evidence_kind = 'range')\n) STRICT;",
      '  evidence_kind TEXT NOT NULL\n) STRICT;'
    )
  );
  db.exec(
    `INSERT INTO mention (doc_id, entity_id, raw, resolved, evidence_kind, start_line, start_char, end_line, end_char)
     VALUES (1, 'krishna', 'k', 1, 'whole-file', 0, 0, 0, 0)`
  );
  db.exec(
    `INSERT INTO mention (doc_id, entity_id, raw, resolved, evidence_kind, label_start_line)
     VALUES (1, 'krishna', 'k', 1, 'whole-file', 2)`
  );
  const row = db.prepare('SELECT COUNT(*) AS n FROM mention').get() as any;
  assert.equal(Number(row.n), 2, 'the weakened schema still refused');
  db.close();
});

// --------------------------------------------------------------------------
// A12 — the collision record names the definition IN EFFECT
//
// The contract core asserts that both adapters answer a collision with a
// winner and a set of losers. These assert that in SQLITE it is the SCHEMA
// holding that shape up: a foreign key so a duplicate cannot exist without —
// or outlive — the entity it lost to, and a trigger pair so one card cannot be
// both sides of one collision. An adapter-level check would be bypassed by the
// first repair script anyone writes, and `keptRelPath` would silently become a
// field the reader has to distrust.
// --------------------------------------------------------------------------

const OTHER_CARD = 'entities/arjuna.yaml';

function seedThreeCards(store: ReturnType<typeof newStore>) {
  seed(store);
  store.transaction((writer: any) =>
    writer.putDocument({
      relPath: OTHER_CARD,
      kind: 'entity-card',
      sizeBytes: 1,
      mtimeMs: 1,
      contentHash: 'h',
      indexedAt: 1
    })
  );
}

function card(id: string, sourcePath: string) {
  return {
    id,
    type: 'character',
    name: id,
    sourcePath,
    sourceUri: `file:///workspace/${sourcePath}`,
    origin: 'explicit',
    aliases: []
  };
}

/** A scratch database carrying `ddl`, two documents and one entity owned by the
 *  first of them — the smallest state in which a collision is expressible. */
function scratchWithEntity(ddl: string): DatabaseSync {
  const db = scratch(ddl);
  db.exec(
    `INSERT INTO document (rel_path, kind, size_bytes, mtime_ms, content_hash, indexed_at, generation)
     VALUES ('${CARD}', 'entity-card', 1, 1, 'h', 1, 1)`
  );
  db.exec(
    `INSERT INTO entity (entity_id, type, name, origin, doc_id, payload)
     VALUES ('krishna', 'character', 'krishna', 'explicit', 2, '{}')`
  );
  return db;
}

test('A12: a duplicate of an id NO card defines is refused BY THE SCHEMA', () => {
  const store = newStore();
  seedThreeCards(store);
  const error = caught(() =>
    store.transaction((writer: any) => writer.putDuplicateEntity('krishna', OTHER_CARD))
  );
  assert.ok(error !== undefined, 'a duplicate with no entity behind it was accepted');
  assert.match(
    messageOf(error),
    /FOREIGN KEY constraint failed/,
    `expected the entity_duplicate.entity_id foreign key to refuse it, got: ${messageOf(error)}`
  );
});

test('A12 rejecting case: without that foreign key the winnerless collision is storable', () => {
  // What the constraint prevents is not a crash — it is a FINDING NOBODY CAN
  // ACT ON: two cards named as colliding with no statement of which definition
  // the index is using. Here is the row, and here is the reader coming back
  // empty because it has no winner to join to.
  const db = scratch(
    weaken(
      '  entity_id TEXT    NOT NULL REFERENCES entity(entity_id) ON DELETE CASCADE,\n  doc_id    INTEGER NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,\n  PRIMARY KEY (entity_id, doc_id)',
      '  entity_id TEXT    NOT NULL,\n  doc_id    INTEGER NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,\n  PRIMARY KEY (entity_id, doc_id)'
    )
  );
  db.exec("INSERT INTO entity_duplicate (entity_id, doc_id) VALUES ('krishna', 1)");
  const stored = db.prepare('SELECT COUNT(*) AS n FROM entity_duplicate').get() as any;
  assert.equal(Number(stored.n), 1, 'the weakened schema still refused');
  const joined = db
    .prepare(
      `SELECT COUNT(*) AS n FROM entity_duplicate dup
       JOIN entity e ON e.entity_id = dup.entity_id`
    )
    .get() as any;
  assert.equal(Number(joined.n), 0, 'the orphan row somehow found a winner');
  db.close();
});

test('A12: excluding the card that OWNS the entity is refused BY THE SCHEMA', () => {
  const store = newStore();
  seedThreeCards(store);
  store.transaction((writer: any) => writer.putEntity(card('krishna', CARD)));
  const error = caught(() => store.transaction((writer: any) => writer.putDuplicateEntity('krishna', CARD)));
  assert.ok(error !== undefined, 'the kept card was accepted as its own duplicate');
  assert.match(
    messageOf(error),
    /entity_duplicate names the card that owns the entity/,
    `expected the DDL trigger to refuse it, got: ${messageOf(error)}`
  );
});

test('A12 paired positive: a DIFFERENT card is accepted, and the record names both sides', () => {
  // Without this half, a trigger that refused every duplicate would pass the
  // case above while making the whole table unwritable.
  const store = newStore();
  seedThreeCards(store);
  store.transaction((writer: any) => {
    writer.putEntity(card('krishna', CARD));
    writer.putDuplicateEntity('krishna', OTHER_CARD);
  });
  assert.deepEqual(store.getDuplicateEntities(), [
    { entityId: 'krishna', keptRelPath: CARD, excludedRelPaths: [OTHER_CARD] }
  ]);
});

test('A12 rejecting case: without the trigger a card is stored as both winner and loser', () => {
  const db = scratchWithEntity(
    weaken(
      "CREATE TRIGGER entity_duplicate_excludes_the_kept_card\nBEFORE INSERT ON entity_duplicate\nWHEN EXISTS (SELECT 1 FROM entity WHERE entity.entity_id = NEW.entity_id AND entity.doc_id = NEW.doc_id)\nBEGIN\n  SELECT RAISE(ABORT, 'entity_duplicate names the card that owns the entity');\nEND;",
      ''
    )
  );
  db.exec("INSERT INTO entity_duplicate (entity_id, doc_id) VALUES ('krishna', 2)");
  const row = db
    .prepare(
      `SELECT kept.rel_path AS kept, excluded.rel_path AS excluded
       FROM entity_duplicate dup
       JOIN entity e          ON e.entity_id     = dup.entity_id
       JOIN document kept     ON kept.doc_id     = e.doc_id
       JOIN document excluded ON excluded.doc_id = dup.doc_id`
    )
    .get() as any;
  assert.ok(row !== undefined, 'the weakened schema still refused');
  assert.equal(row.kept, row.excluded, 'the contradiction did not materialise, so the tooth proves nothing');
  db.close();
});

test('A12: moving the entity onto an already-excluded card is refused BY THE SCHEMA', () => {
  const store = newStore();
  seedThreeCards(store);
  store.transaction((writer: any) => {
    writer.putEntity(card('krishna', CARD));
    writer.putDuplicateEntity('krishna', OTHER_CARD);
  });
  const error = caught(() => store.transaction((writer: any) => writer.putEntity(card('krishna', OTHER_CARD))));
  assert.ok(error !== undefined, 'the winner was moved onto a card excluded from the same id');
  assert.match(
    messageOf(error),
    /this card is already excluded from this id/,
    `expected one of the entity triggers to refuse it, got: ${messageOf(error)}`
  );
  assert.deepEqual(
    store.getDuplicateEntities(),
    [{ entityId: 'krishna', keptRelPath: CARD, excludedRelPaths: [OTHER_CARD] }],
    'the refused move left something behind'
  );
});

test('A12 rejecting case: without the entity triggers the winner moves onto a loser', () => {
  const db = scratchWithEntity(
    weaken(
      "CREATE TRIGGER entity_update_is_not_an_excluded_card\nBEFORE UPDATE ON entity\nWHEN EXISTS (SELECT 1 FROM entity_duplicate\n             WHERE entity_duplicate.entity_id = NEW.entity_id AND entity_duplicate.doc_id = NEW.doc_id)\nBEGIN\n  SELECT RAISE(ABORT, 'entity update: this card is already excluded from this id');\nEND;",
      ''
    )
  );
  db.exec("INSERT INTO entity_duplicate (entity_id, doc_id) VALUES ('krishna', 1)");
  db.exec("UPDATE entity SET doc_id = 1 WHERE entity_id = 'krishna'");
  const row = db.prepare("SELECT doc_id FROM entity WHERE entity_id = 'krishna'").get() as any;
  assert.equal(Number(row.doc_id), 1, 'the weakened schema still refused the move');
  db.close();
});

test('A12: a collision does not outlive its winner — deleting the kept card cascades it away', () => {
  const store = newStore();
  seedThreeCards(store);
  store.transaction((writer: any) => {
    writer.putEntity(card('krishna', CARD));
    writer.putDuplicateEntity('krishna', OTHER_CARD);
  });
  store.transaction((writer: any) => writer.deleteDocument(CARD));
  assert.equal(store.getEntity('krishna'), undefined, 'the entity survived its card');
  assert.deepEqual(store.getDuplicateEntities(), [], 'the collision survived its winner');
});

test('A12 rejecting case: without that foreign key the duplicate row outlives its winner', () => {
  const db = scratchWithEntity(
    weaken(
      '  entity_id TEXT    NOT NULL REFERENCES entity(entity_id) ON DELETE CASCADE,\n  doc_id    INTEGER NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,\n  PRIMARY KEY (entity_id, doc_id)',
      '  entity_id TEXT    NOT NULL,\n  doc_id    INTEGER NOT NULL REFERENCES document(doc_id) ON DELETE CASCADE,\n  PRIMARY KEY (entity_id, doc_id)'
    )
  );
  db.exec("INSERT INTO entity_duplicate (entity_id, doc_id) VALUES ('krishna', 1)");
  // Delete the WINNER's card. The entity cascades away; without the foreign key
  // the duplicate row does not, and the index is left asserting a collision
  // whose winning definition no longer exists.
  db.exec(`DELETE FROM document WHERE rel_path = '${CARD}'`);
  const entities = db.prepare('SELECT COUNT(*) AS n FROM entity').get() as any;
  assert.equal(Number(entities.n), 0, 'the entity did not cascade, so this proves nothing about the duplicate');
  const orphans = db.prepare('SELECT COUNT(*) AS n FROM entity_duplicate').get() as any;
  assert.equal(Number(orphans.n), 1, 'the weakened schema cascaded anyway');
  db.close();
});

// --------------------------------------------------------------------------
// The partial indexes the findings layer will read
// --------------------------------------------------------------------------

test('the partial indexes named in the DDL really exist in the built database', () => {
  // Read through a SECOND, independent connection to the file on disk, so the
  // assertion is about what was actually created and not about anything the
  // adapter holds in memory.
  const workspace = makeWorkspace('indexes');
  const store = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0
  });
  opened.push(store);
  const db = new DatabaseSync(workspace.databaseFile, { open: true, readOnly: true });
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as any[]).map(
    row => row.name
  );
  db.close();
  for (const expected of [
    'mention_broken',
    'relation_broken',
    'relation_identity',
    'relation_evidence_identity',
    'document_chapter_order'
  ]) {
    assert.ok(indexes.includes(expected), `index ${expected} is missing; saw ${indexes.join(', ')}`);
  }
});

after(() => {
  for (const store of opened.reverse()) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  disposeAll();
});
