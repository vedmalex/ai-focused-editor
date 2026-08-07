/**
 * SCHEMA v3 THROUGH THE WHOLE PIPELINE — teeth B13 and B14 (TASK-022 WP-7,
 * UR-031, tech_spec ОВ-1 group B).
 *
 * WHY THESE ARE SEPARATE FROM THE GROUP-A TEETH. Group A proves the SCHEMA: it
 * inserts through the port, or through raw SQL against a perturbed DDL, and
 * asserts SQLite refuses or keeps what it should. That leaves one thing
 * unproven, and it is the thing UR-031 was actually about — that EXTRACTION
 * really carries the author's chronology and the manifest's title all the way
 * from a YAML file to a `getRelations()` / `listDocuments()` answer. An index
 * whose columns exist and whose pipeline never fills them passes every group-A
 * case and still shows the reader nothing.
 *
 * WHY A FIXTURE OF ITS OWN AND NOT WP-9a's `hardManuscript()`. WP-9a's fixture
 * is WP-9a's, and the plan says so; the standing lesson of this task is that two
 * work packages sharing one fixture lets either make the other's tooth green by
 * adding a file. `hardManuscript()`'s `gandiva.yaml` also names three DIFFERENT
 * owners, which is precisely the case v2 handled correctly — reusing it would
 * have proved nothing about the collapse UR-031 names.
 *
 * WHAT THE FIXTURE IS BUILT TO BREAK:
 *
 *   - `gandiva.yaml` names `varuna` TWICE, at positions 0 and 2, with different
 *     story time and different notes. Under the v2 identity key those two rows
 *     were ONE, and the second `putRelation` overwrote the first — so an author
 *     who wrote "Varuna, then Arjuna, then Varuna again" got an index that said
 *     "Varuna once, with the later note". This is the ordinary
 *     artifact-returns-to-its-owner beat, not an edge case.
 *   - `content/unlisted.md` is a real chapter the manifest does NOT name, so
 *     `title` has to come back ABSENT. The rejecting case is the tempting fix —
 *     falling back to the file name — which is the MANIFEST's rule for an entry
 *     that EXISTS (`manifest-extraction.ts:92`) and not a licence to invent a
 *     heading for a file the manifest never mentions.
 *   - one manifest entry states `title: ''`. This one was written to assert that
 *     "absent" and "empty" stay two different answers end to end, AND THAT WAS
 *     WRONG ABOUT THE WORLD — the tooth said so on its first run. The manifest
 *     walk resolves a title as `asString(entry.title) || <file name>`
 *     (`manifest-extraction.ts:92`), so an empty title in the YAML becomes the
 *     FILE NAME before extraction ever returns, and an empty string cannot reach
 *     the store down this path at all. The case below now asserts what actually
 *     happens, because that is the more useful fact: THE FALLBACK BELONGS TO THE
 *     MANIFEST ENTRY, not to the document row. An entry that exists but names no
 *     title gets the file name; a file the manifest never names gets NOTHING.
 *     The empty-versus-absent distinction is still real and still guarded — at
 *     the STORE, by tooth A14 in the contract core and in the schema run, where
 *     a producer other than this walk can reach it.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NarrativeIndexSession,
  type IndexableFile,
  type NarrativeIndexStore
} from '../../lib/common/index.js';
import { SqliteNarrativeIndexStore } from '../../lib/node/sqlite-narrative-index-store.js';
import { NARRATIVE_INDEX_SCHEMA_VERSION } from '../../lib/node/narrative-index-schema.js';
import { disposeAll, makeWorkspace, must } from './harness.mts';
import { file } from './manuscript-fixture.mts';

const opened: { close(): void }[] = [];

const GANDIVA = 'entities/artifacts/gandiva.yaml';
const NAMED_CHAPTER = 'content/ch-01.md';
const BLANK_TITLE_CHAPTER = 'content/ch-02.md';
const UNLISTED_CHAPTER = 'content/unlisted.md';

/**
 * A manuscript in which the SAME owner appears twice and one chapter is unnamed.
 *
 * `arjuna` sits BETWEEN the two `varuna` entries on purpose: a "deduplicate
 * consecutive owners" implementation would keep both `varuna` rows here anyway,
 * so the assertion is about identity and not about adjacency.
 */
function returningOwnerManuscript(): IndexableFile[] {
  return [
    file(
      'manifest.yaml',
      [
        'content:',
        `  - path: ${NAMED_CHAPTER}`,
        '    title: Глава первая',
        `  - path: ${BLANK_TITLE_CHAPTER}`,
        "    title: ''"
      ].join('\n')
    ),
    file('entities/characters/varuna.yaml', ['id: varuna', 'name: Варуна'].join('\n')),
    file('entities/characters/arjuna.yaml', ['id: arjuna', 'name: Арджуна'].join('\n')),
    file(
      GANDIVA,
      [
        'id: gandiva',
        'name: Гандива',
        'ownership:',
        '  - owner: varuna',
        '    to: век богов',
        '    note: хранит лук до времён людей',
        '  - owner: arjuna',
        '    from: великая война',
        '    note: владеет им в битве',
        '  - owner: varuna',
        '    from: после ухода',
        '    note: лук возвращается к прежнему хозяину'
      ].join('\n')
    ),
    file(NAMED_CHAPTER, 'Здесь [[char:varuna|Варуна]] и [[char:arjuna|Арджуна]].'),
    file(BLANK_TITLE_CHAPTER, 'Только [[char:arjuna|Арджуна]].'),
    file(UNLISTED_CHAPTER, 'Черновик про [[char:varuna|Варуну]].')
  ];
}

function buildIndex(name: string): NarrativeIndexStore {
  const workspace = makeWorkspace(name);
  const store = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0
  });
  opened.push(store);
  const session = new NarrativeIndexSession({
    store,
    schemaVersion: NARRATIVE_INDEX_SCHEMA_VERSION
  });
  must(session.rebuild(returningOwnerManuscript()), 'rebuild');
  return store;
}

test('the schema version really is 3 — the constant the pragma is written from', () => {
  // A one-line assertion, and it earns its place: every other case here would
  // pass unchanged against a database still stamped v2, because the columns and
  // the version travel separately. This is what makes "we forgot to bump it"
  // visible, which matters because the bump is the ONLY thing that makes an
  // existing developer's on-disk index rebuild instead of being read with the
  // wrong shape.
  assert.equal(NARRATIVE_INDEX_SCHEMA_VERSION, 3);
});

test('B13: an artifact returning to a previous owner survives rebuild() as TWO relations', () => {
  const store = buildIndex('v3-returning-owner');
  const ownership = store
    .getRelations({ relType: 'ownership' })
    .slice()
    .sort((left, right) => (left.listPosition ?? -1) - (right.listPosition ?? -1));

  assert.equal(ownership.length, 3, 'the two varuna entries were folded into one');
  assert.deepEqual(
    ownership.map(relation => [relation.targetId, relation.listPosition]),
    [
      ['varuna', 0],
      ['arjuna', 1],
      ['varuna', 2]
    ],
    'the chronology is the LIST ORDER and nothing else'
  );

  // Each hop kept ITS OWN author text. This is the half that the v2 collapse
  // destroyed silently: the row survived, wearing the last writer's note.
  assert.deepEqual(
    ownership.map(relation => [relation.storyTimeFrom, relation.storyTimeTo, relation.note]),
    [
      [undefined, 'век богов', 'хранит лук до времён людей'],
      ['великая война', undefined, 'владеет им в битве'],
      ['после ухода', undefined, 'лук возвращается к прежнему хозяину']
    ],
    'a hop is wearing another hop’s story time or note'
  );

  // And the ends really resolve, so this is not passing because the whole
  // ownership layer arrived broken.
  for (const relation of ownership) {
    assert.equal(relation.sourceResolved, true, 'sourceResolved');
    assert.equal(relation.targetResolved, true, `targetResolved for ${relation.targetId}`);
    assert.equal(relation.ownerPath, GANDIVA, 'ownerPath');
  }
});

test('B13 second half: a SECOND rebuild is idempotent, not a doubling', () => {
  // The identity key got FINER in v3, and a key that is too fine stops matching
  // on re-write — which would turn every rebuild into an append. Without this
  // half, "delete the unique index entirely" would pass the case above.
  const store = buildIndex('v3-returning-owner-twice');
  const session = new NarrativeIndexSession({
    store,
    schemaVersion: NARRATIVE_INDEX_SCHEMA_VERSION
  });
  must(session.rebuild(returningOwnerManuscript()), 'second rebuild');
  assert.equal(
    store.getRelations({ relType: 'ownership' }).length,
    3,
    'a second rebuild changed the ownership row count'
  );
});

test('B14: a chapter the manifest names carries its title; one it does not carries none', () => {
  const store = buildIndex('v3-chapter-titles');
  const byPath = new Map(store.listDocuments().map(document => [document.relPath, document]));

  const named = byPath.get(NAMED_CHAPTER);
  assert.ok(named !== undefined, 'the named chapter is not indexed');
  assert.equal(named.title, 'Глава первая', 'title of a chapter the manifest names');
  assert.equal(named.chapterOrder, 0, 'chapterOrder of the same chapter');

  const unlisted = byPath.get(UNLISTED_CHAPTER);
  assert.ok(unlisted !== undefined, 'the unlisted chapter is not indexed at all — its mentions are real');
  assert.equal(
    unlisted.title,
    undefined,
    'the unlisted chapter was given a title; falling back to the file name here INVENTS a heading'
  );
  assert.equal(unlisted.chapterOrder, undefined, 'the unlisted chapter was given a position');
  assert.equal(unlisted.manifestIncluded, false, 'manifestIncluded');
});

test('B14 second half: an EMPTY manifest title becomes the FILE NAME, and that is the manifest\'s rule', () => {
  // MEASURED, NOT ASSUMED — and the first edition of this case asserted the
  // opposite and was WRONG. `extractManifestChapters` resolves a title as
  // `asString(entry.title) || <file name>` (`manifest-extraction.ts:92`), which
  // is byte-identical to `NodeNarrativeGraphService.collectChapters` and is the
  // behaviour the WP-9b baseline already pins from the widget side. So `''` in
  // the YAML never reaches the store: the walk substitutes the file name.
  //
  // WHAT THIS PAIR IS REALLY FOR. Put beside the unlisted chapter above, it
  // shows WHERE the fallback lives: an entry the manifest HAS gets a title one
  // way or another, and a file the manifest does not name gets none. An
  // implementation that moved the fallback down to the document row would pass
  // this half and fail the one above — which is exactly the confusion the two
  // halves exist to keep apart.
  const store = buildIndex('v3-blank-title');
  const blank = store.listDocuments().find(document => document.relPath === BLANK_TITLE_CHAPTER);
  assert.ok(blank !== undefined, 'the blank-title chapter is not indexed');
  assert.equal(
    blank.title,
    'ch-02.md',
    'an empty manifest title no longer falls back to the file name — the manifest walk changed'
  );
  assert.equal(blank.chapterOrder, 1, 'the blank-title chapter still has its position');
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
