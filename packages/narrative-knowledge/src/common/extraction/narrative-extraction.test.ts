/**
 * WP-2's readiness block, as tests (TASK-022).
 *
 * The plan states the condition for checkboxes №3 and №4 as a LIST, and this
 * file follows it item by item rather than by theme: a case per output kind, a
 * case with no manifest, a case per REFERENCE FORM with an explicit
 * `kind === undefined` check, a case on `EntityTypeProblem`, FOUR extracting
 * cases (relation sources 1-4) plus ONE structural REJECTING case (source 5),
 * a broken relation end, the gh#66 characterization, the two relation-origin
 * cases, and the R-14 ordering case.
 *
 * EVERY ASSERTION IS OVER THE OUTPUT OF A PURE FUNCTION, never over database
 * state. That is not a convenience — WP-2 is `src/common` with zero filesystem,
 * it closes in G3, and `rebuild()` does not exist until WP-4a. A readiness
 * condition phrased over tables could not have been checked honestly anywhere
 * in the graph. The same two decisions checked at the SCHEMA level are WP-3's
 * teeth 11 and 12; these are the extraction half, and the two fail differently.
 */

import { describe, expect, test } from 'bun:test';
import { isRangeEvidence } from '../graph';
import { classifyDocument } from './document-classification';
import { extractNarrativeIndex, type WorkspaceFile } from './narrative-extraction';

const uriFor = (path: string): string => `file:///workspace/${path}`;

const file = (path: string, text: string): WorkspaceFile => ({ path, uri: uriFor(path), text });

// ---------------------------------------------------------------------------
// The fixture manuscript
// ---------------------------------------------------------------------------

// `include: false` sits on the APPENDIX, not on the file under it: inheritance
// is the part of the walk that a naive rewrite loses, and a flag written
// directly on the leaf would not notice.
const MANIFEST = `version: 1
content:
  - path: content/chapter-01.md
    title: The Field of Decision
  - path: content/part-01
    title: Part One
    children:
      - path: content/part-01/chapter-02.md
        title: The Teaching Begins
  - path: content/appendix
    title: Appendix
    include: false
    children:
      - path: content/appendix/notes-draft.md
        title: Draft Notes
`;

const TYPES_YAML = `types:
  - id: sloka
    label: Sloka
  - id: character
    label: Not allowed to shadow a built-in
`;

/**
 * Chapter one, with its lines numbered so the range assertions below can be
 * read against it:
 *
 *   0  ---
 *   1  title: The Field of Decision
 *   2  summary: Featuring [[char:krishna|Krishna]]
 *   3  ---
 *   4  (blank)
 *   5  A hush falls. [[char:arjuna|Arjuna]] lowers [[gandiva]].
 *
 * `krishna` is named ONLY in the front matter and `arjuna`/`gandiva` ONLY in
 * the prose, so the two sources cannot be confused for one another.
 */
const CHAPTER_ONE = `---
title: The Field of Decision
summary: Featuring [[char:krishna|Krishna]]
---

A hush falls. [[char:arjuna|Arjuna]] lowers [[gandiva]].
`;

// `[[char:gandiva|Gandiva]]` names a REAL id under the WRONG kind — `gandiva`
// is an artifact. It is the case that tells "resolve by id alone" apart from
// "resolve by kind and id", and the two rules differ only here.
const CHAPTER_TWO = `Krishna answers [[char:nobody|Nobody]] beside [[char:gandiva|Gandiva]].
`;

const KRISHNA_CARD = `id: krishna
name: Krishna
aliases:
  - Govinda
  - Madhava
backstory: Cousin, friend and charioteer to [[arjuna]].
`;

const ARJUNA_CARD = `id: arjuna
name: Arjuna
`;

const VARUNA_CARD = `id: varuna
name: Varuna
`;

const AGNI_CARD = `id: agni
name: Agni
`;

/**
 * The artifact card carries all three ownership cases at once: an entry with NO
 * `origin` (reads as `explicit`), an entry that states `ai-candidate`, and an
 * entry naming an owner no card defines. The two story-time labels are ordered
 * so that sorting by them would REVERSE the list (`август` < `январь` by code
 * point as well as by Russian collation).
 */
const GANDIVA_CARD = `id: gandiva
name: Gandiva
ownership:
  - owner: varuna
    from: январь
    note: Guarded before it reached mortals.
  - owner: agni
    from: август
    origin: ai-candidate
  - owner: nobody-at-all
`;

const SLOKA_CARD = `id: bg-2-47
name: The right to action
`;

// BOTH source-5 files carry a `[[...]]` reference ON PURPOSE. Without one they
// would produce nothing under ANY implementation, and "these files contribute
// no relations" would be true by having nothing to contribute rather than by
// being refused. With one, any implementation that classifies them as a chapter
// or as a card immediately produces a mention or a relation from them.
const CITATIONS_YAML = `version: 1
citations:
  - id: bg-2-47
    title: Bhagavad-gita 2.47
    source: documents/gita-notes.md
    note: Quoted where [[krishna]] answers.
`;

const EXCERPTS_JSONL =
  '{"id":"dharma-context","text":"Spoken by [[krishna]] on the field.","source":"bg-2-47",' +
  '"targetPath":"content/chapter-01.md","targetLine":9}\n';

function manuscript(): WorkspaceFile[] {
  return [
    file('manifest.yaml', MANIFEST),
    file('entities/types.yaml', TYPES_YAML),
    file('entities/characters/krishna.yaml', KRISHNA_CARD),
    file('entities/characters/arjuna.yaml', ARJUNA_CARD),
    file('entities/characters/varuna.yaml', VARUNA_CARD),
    file('entities/characters/agni.yaml', AGNI_CARD),
    file('entities/artifacts/gandiva.yaml', GANDIVA_CARD),
    file('entities/sloka/bg-2-47.yaml', SLOKA_CARD),
    file('content/chapter-01.md', CHAPTER_ONE),
    file('content/part-01/chapter-02.md', CHAPTER_TWO),
    file('sources/citations.yaml', CITATIONS_YAML),
    file('sources/excerpts.jsonl', EXCERPTS_JSONL)
  ];
}

const withoutPaths = (files: WorkspaceFile[], paths: string[]): WorkspaceFile[] =>
  files.filter(candidate => !paths.includes(candidate.path));

// ---------------------------------------------------------------------------
// One case per kind of output
// ---------------------------------------------------------------------------

describe('output kinds', () => {
  test('a prose mention carries an EXACT range, in whole-file coordinates', () => {
    const index = extractNarrativeIndex(manuscript());
    const mention = index.mentions.find(candidate => candidate.entityId === 'arjuna');

    expect(mention).toBeDefined();
    expect(mention!.kind).toBe('char');
    expect(mention!.raw).toBe('[[char:arjuna|Arjuna]]');
    expect(mention!.label).toBe('Arjuna');
    expect(mention!.resolved).toBe(true);
    expect(mention!.evidence.evidenceKind).toBe('range');
    // Line 5 of the FILE, not line 1 of the body: an implementation that scans
    // the body and forgets the four lines the front matter occupies reports
    // line 1 here, and every navigation lands four lines too high.
    expect(mention!.evidence).toEqual({
      path: 'content/chapter-01.md',
      evidenceKind: 'range',
      range: { start: { line: 5, character: 14 }, end: { line: 5, character: 36 } }
    });
    expect(mention!.labelRange).toEqual({
      start: { line: 5, character: 28 },
      end: { line: 5, character: 34 }
    });
  });

  test('entity aliases survive extraction, and a mention keeps its display label', () => {
    const index = extractNarrativeIndex(manuscript());
    const krishna = index.entities.find(entity => entity.id === 'krishna');

    expect(krishna).toBeDefined();
    expect(krishna!.aliases).toEqual(['Govinda', 'Madhava']);
    expect(krishna!.name).toBe('Krishna');
    expect(krishna!.type).toBe('character');
    expect(krishna!.sourcePath).toBe('entities/characters/krishna.yaml');
    expect(krishna!.sourceUri).toBe(uriFor('entities/characters/krishna.yaml'));

    const labelled = index.mentions.find(candidate => candidate.entityId === 'krishna');
    expect(labelled!.label).toBe('Krishna');
  });

  test('a duplicate id keeps ONE card, reports the loser, and drops its relations', () => {
    const index = extractNarrativeIndex([
      ...manuscript(),
      // The loser carries relation-bearing text, so "excluded" has something to
      // be observably true about beyond the entity row itself.
      file(
        'entities/locations/krishna.yaml',
        'id: krishna\nname: A location that stole an id\nsummary: Next to [[varuna]].\n'
      )
    ]);

    const krishnas = index.entities.filter(entity => entity.id === 'krishna');
    expect(krishnas).toHaveLength(1);
    // First card in input order wins — the pattern `parseModes` sets, not the
    // unconditional insert `readEntityDirectory` does.
    expect(krishnas[0].type).toBe('character');
    expect(index.duplicates).toEqual([{
      entityId: 'krishna',
      sourcePath: 'entities/locations/krishna.yaml',
      keptSourcePath: 'entities/characters/krishna.yaml'
    }]);
    // A relation owned by a card the index does not hold would name a
    // `sourceId` with no row behind it — a broken end MANUFACTURED by the
    // extractor rather than found in the manuscript.
    expect(index.relations.some(relation => relation.ownerPath === 'entities/locations/krishna.yaml')).toBe(false);
    expect(index.relations.some(relation => relation.targetId === 'varuna' && relation.relType === 'mentions')).toBe(false);
  });

  test('a broken reference is KEPT, flagged, and never dropped', () => {
    const index = extractNarrativeIndex(manuscript());
    const broken = index.mentions.find(candidate => candidate.entityId === 'nobody');

    expect(broken).toBeDefined();
    expect(broken!.resolved).toBe(false);
    // Dropping it would be the failure this index exists to prevent: a broken
    // link the author cannot be shown is a broken link nobody ever fixes.
    expect(broken!.evidence.path).toBe('content/part-01/chapter-02.md');
  });

  test('a legacy card — no origin, no evidence field — reads as author-written', () => {
    const index = extractNarrativeIndex(manuscript());
    const arjuna = index.entities.find(entity => entity.id === 'arjuna')!;

    expect(arjuna.origin).toBe('explicit');
    // The card file IS where it was read from, so the evidence is a fact rather
    // than an invention — unlike the legacy TRANSPORT shape, which has nowhere
    // to carry one and therefore gets none.
    expect(arjuna.evidence).toEqual({
      path: 'entities/characters/arjuna.yaml',
      evidenceKind: 'whole-file'
    });
  });
});

// ---------------------------------------------------------------------------
// A workspace that is not a manuscript
// ---------------------------------------------------------------------------

describe('no manifest', () => {
  test('an absent manifest is reported as absence, not as a problem', () => {
    const index = extractNarrativeIndex(withoutPaths(manuscript(), ['manifest.yaml']));

    expect(index.manifestPresent).toBe(false);
    expect(index.chapters).toEqual([]);
    // `cause: 'no-manuscript'` is not an error, and a problem here would make
    // every consumer present an ordinary directory as a broken book.
    expect(index.manifestProblems).toEqual([]);
  });

  test('a PRESENT but unwalkable manifest is a problem, and that is a different answer', () => {
    const index = extractNarrativeIndex([
      ...withoutPaths(manuscript(), ['manifest.yaml']),
      file('manifest.yaml', 'version: 1\n')
    ]);

    expect(index.manifestPresent).toBe(true);
    expect(index.manifestProblems.map(problem => problem.code)).toEqual(['invalid-shape']);
  });

  test('the manifest orders chapters and inherits include: false', () => {
    const index = extractNarrativeIndex(manuscript());

    expect(index.chapters).toEqual([
      { path: 'content/chapter-01.md', title: 'The Field of Decision', order: 0, buildIncluded: true },
      { path: 'content/part-01/chapter-02.md', title: 'The Teaching Begins', order: 1, buildIncluded: true },
      // The flag is on the APPENDIX, not on this file. A walk that reads only
      // the entry's own `include:` reports `true` here.
      { path: 'content/appendix/notes-draft.md', title: 'Draft Notes', order: 2, buildIncluded: false }
    ]);
  });
});

// ---------------------------------------------------------------------------
// BOTH reference forms (ISS-307)
// ---------------------------------------------------------------------------

describe('two reference forms', () => {
  test('the LABELED form carries its kind', () => {
    const index = extractNarrativeIndex(manuscript());
    const labelled = index.mentions.find(candidate => candidate.raw === '[[char:arjuna|Arjuna]]');

    expect(labelled).toBeDefined();
    expect(labelled!.kind).toBe('char');
  });

  test('the UNLABELED bare form survives with kind === undefined', () => {
    const index = extractNarrativeIndex(manuscript());
    const bare = index.mentions.find(candidate => candidate.raw === '[[gandiva]]');

    expect(bare).toBeDefined();
    // Explicitly `undefined`, not "falsy": discarding this form or inventing a
    // kind for it is forbidden, and the TASK-013 U-B regression is what that
    // rule was bought with.
    expect(bare!.kind).toBeUndefined();
    expect('kind' in bare!).toBe(false);
    expect(bare!.entityId).toBe('gandiva');
    // Matched BY ID ALONE, across every type — the bare form names no kind to
    // check against.
    expect(bare!.resolved).toBe(true);
    // And that is a DIFFERENT rule from the labeled form's, not a lazier
    // version of it: the SAME id under a WRONG kind does NOT resolve. Collapse
    // the two rules into "by id alone" and a `[[char:gandiva]]` pointing at an
    // artifact starts reading as a working link.
    const wrongKind = index.mentions.find(candidate => candidate.raw === '[[char:gandiva|Gandiva]]');
    expect(wrongKind).toBeDefined();
    expect(wrongKind!.entityId).toBe('gandiva');
    expect(wrongKind!.resolved).toBe(false);
    expect(bare!.evidence).toEqual({
      path: 'content/chapter-01.md',
      evidenceKind: 'range',
      range: { start: { line: 5, character: 44 }, end: { line: 5, character: 55 } }
    });
  });
});

// ---------------------------------------------------------------------------
// entities/types.yaml — BOTH outputs
// ---------------------------------------------------------------------------

describe('entity types', () => {
  test('author types are appended and their problems are reported, both', () => {
    const index = extractNarrativeIndex(manuscript());

    const sloka = index.effectiveTypes.find(type => type.id === 'sloka');
    expect(sloka).toBeDefined();
    expect(sloka!.origin).toBe('book');
    expect(sloka!.directory).toBe('sloka');

    // A card in the author type's directory is a card only BECAUSE the type
    // was declared — classification cannot be done from the built-ins alone.
    expect(index.entities.some(entity => entity.id === 'bg-2-47' && entity.type === 'sloka')).toBe(true);

    expect(index.typeProblems).toHaveLength(1);
    expect(index.typeProblems[0].code).toBe('reserved-id');
    expect(index.typeProblems[0].id).toBe('character');
    // The built-in survives the attempted shadowing.
    expect(index.effectiveTypes.find(type => type.id === 'character')!.origin).toBe('built-in');
  });

  test('a card of an UNDECLARED author type is not a card at all', () => {
    const index = extractNarrativeIndex(
      withoutPaths(manuscript(), ['entities/types.yaml'])
    );

    expect(index.entities.some(entity => entity.id === 'bg-2-47')).toBe(false);
    expect(classifyDocument('entities/sloka/bg-2-47.yaml', index.effectiveTypes)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// One case per relation/mention SOURCE, by the plan's route table
// ---------------------------------------------------------------------------

describe('source 1 — a mention in prose', () => {
  test('lands as a mention with evidenceKind range and non-empty coordinates', () => {
    const index = extractNarrativeIndex(manuscript());
    const mention = index.mentions.find(candidate => candidate.entityId === 'arjuna')!;

    expect(isRangeEvidence(mention.evidence)).toBe(true);
    const range = isRangeEvidence(mention.evidence) ? mention.evidence.range : undefined;
    expect(range).toBeDefined();
    expect(range!.end.character).toBeGreaterThan(range!.start.character);
  });
});

describe('source 2 — ownership', () => {
  test('lands as a relation with whole-file evidence, owned by the artifact card', () => {
    const index = extractNarrativeIndex(manuscript());
    const ownership = index.relations.filter(relation => relation.relType === 'ownership');

    expect(ownership).toHaveLength(3);
    for (const relation of ownership) {
      expect(relation.sourceId).toBe('gandiva');
      expect(relation.ownerPath).toBe('entities/artifacts/gandiva.yaml');
      expect(relation.evidence).toHaveLength(1);
      expect(relation.evidence[0]).toEqual({
        path: 'entities/artifacts/gandiva.yaml',
        evidenceKind: 'whole-file'
      });
    }
  });

  test('LIST ORDER is the chronology, and the story-time labels are opaque (R-14)', () => {
    const index = extractNarrativeIndex(manuscript());
    const ownership = index.relations.filter(relation => relation.relType === 'ownership');

    // `август` sorts before `январь` by code point AND by Russian collation, so
    // an implementation that sorts by the label reverses these two.
    expect(ownership.map(relation => relation.targetId)).toEqual(['varuna', 'agni', 'nobody-at-all']);
    expect(ownership.map(relation => relation.listPosition)).toEqual([0, 1, 2]);
    // Carried verbatim, under names that refuse the date reading.
    expect(ownership[0].storyTimeFrom).toBe('январь');
    expect(ownership[1].storyTimeFrom).toBe('август');
    expect(ownership[0].note).toBe('Guarded before it reached mortals.');
  });
});

describe('source 3 — a mention INSIDE a card', () => {
  test('lands as an entity→entity relation with evidence', () => {
    const index = extractNarrativeIndex(manuscript());
    const cardMentions = index.relations.filter(relation => relation.relType === 'mentions');

    // An implementation that reads only chapter prose produces NOTHING here.
    expect(cardMentions).toHaveLength(1);
    expect(cardMentions[0].sourceId).toBe('krishna');
    expect(cardMentions[0].targetId).toBe('arjuna');
    expect(cardMentions[0].sourceResolved).toBe(true);
    expect(cardMentions[0].targetResolved).toBe(true);
    expect(cardMentions[0].evidence[0]).toEqual({
      path: 'entities/characters/krishna.yaml',
      evidenceKind: 'whole-file'
    });
  });

  test('a card reference does NOT also become a chapter mention', () => {
    const index = extractNarrativeIndex(manuscript());
    // Every mention row belongs to a chapter file: source 3 routes to
    // `relation`, not to `mention`.
    for (const mention of index.mentions) {
      expect(mention.evidence.path.startsWith('content/')).toBe(true);
    }
  });
});

describe('source 4 — a mention ONLY in front matter', () => {
  test('lands as a mention with whole-file evidence, no range, no label range', () => {
    const index = extractNarrativeIndex(manuscript());
    const fromFrontMatter = index.mentions.filter(candidate => candidate.entityId === 'krishna');

    // REJECTING CASE (a): an implementation that dropped the front-matter
    // mention leaves this empty.
    expect(fromFrontMatter).toHaveLength(1);
    const mention = fromFrontMatter[0];
    // REJECTING CASE (b): an implementation that filled a zero range to satisfy
    // a NOT NULL reports `range` here, and the reader is sent to the top of the
    // file with no way to tell that from a working link.
    expect(mention.evidence).toEqual({
      path: 'content/chapter-01.md',
      evidenceKind: 'whole-file'
    });
    expect(isRangeEvidence(mention.evidence)).toBe(false);
    expect(mention.labelRange).toBeUndefined();
    expect(mention.kind).toBe('char');
    expect(mention.resolved).toBe(true);
  });
});

describe('source 5 — citations and excerpts', () => {
  test('classify as NOTHING: the index does not read them', () => {
    const index = extractNarrativeIndex(manuscript());

    expect(classifyDocument('sources/citations.yaml', index.effectiveTypes)).toBeUndefined();
    expect(classifyDocument('sources/excerpts.jsonl', index.effectiveTypes)).toBeUndefined();
  });

  test('contribute NOT ONE relation — removing them changes nothing', () => {
    const withSources = extractNarrativeIndex(manuscript());
    const withoutSources = extractNarrativeIndex(
      withoutPaths(manuscript(), ['sources/citations.yaml', 'sources/excerpts.jsonl'])
    );

    // Neither end of a citation is an ENTITY: it binds a source to a PLACE in
    // the manuscript. Stored as a relation, every row would arrive with both
    // ends unresolved and `relation_broken` would fire on correct data.
    expect(withSources.relations).toEqual(withoutSources.relations);
    expect(withSources.entities).toEqual(withoutSources.entities);
    expect(withSources.mentions).toEqual(withoutSources.mentions);
    // Both fixture files carry a `[[krishna]]`, so an implementation that read
    // them as prose or as a card would leave a fingerprint HERE even if the
    // comparison above were somehow satisfied.
    expect(withSources.relations.every(relation => !relation.ownerPath?.startsWith('sources/'))).toBe(true);
    expect(withSources.mentions.every(mention => !mention.evidence.path.startsWith('sources/'))).toBe(true);
    expect(withSources.entities.every(entity => !entity.sourcePath.startsWith('sources/'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A broken relation end (ISS-319)
// ---------------------------------------------------------------------------

describe('a broken relation end', () => {
  test('is stored WITH the flag, never resolved into its own name', () => {
    const index = extractNarrativeIndex(manuscript());
    const broken = index.relations.find(relation => relation.targetId === 'nobody-at-all');

    expect(broken).toBeDefined();
    // Today's `readOwnership` does `labels.byId.get(owner) ?? owner`
    // (`node-narrative-graph-service.ts:353`) — the missing entity silently
    // becomes its own label and the defect disappears. An implementation
    // repeating that has no way to make this assertion true.
    expect(broken!.targetResolved).toBe(false);
    expect(broken!.sourceResolved).toBe(true);
    expect(broken!.targetId).toBe('nobody-at-all');
  });
});

// ---------------------------------------------------------------------------
// gh#66 — CHARACTERIZATION, not approval (R-15)
// ---------------------------------------------------------------------------

describe('a Cyrillic tag kind (gh#66)', () => {
  const CYRILLIC = '[[персонаж:krishna]]';

  test('is a mention in chapter PROSE and invisible in a CARD — today', () => {
    const index = extractNarrativeIndex([
      ...withoutPaths(manuscript(), ['content/chapter-01.md', 'entities/characters/krishna.yaml']),
      file('content/chapter-01.md', `A hush falls. ${CYRILLIC} speaks.\n`),
      file('entities/characters/krishna.yaml', `id: krishna\nname: Krishna\nbackstory: Beside ${CYRILLIC} on the field.\n`)
    ]);

    // Prose goes through the Unicode-aware wiki-link classifier.
    const prose = index.mentions.filter(mention => mention.raw === CYRILLIC);
    expect(prose).toHaveLength(1);
    expect(prose[0].kind).toBe('персонаж');

    // The card goes through `entity-mentions`, still on the pre-TASK-013 ASCII
    // kind grammar `[a-z][\w-]*`, so the same string is not a reference at all.
    const fromCard = index.relations.filter(relation => relation.sourceId === 'krishna');
    expect(fromCard).toHaveLength(0);
  });

  test('an ASCII kind IS seen by both paths — the split is about the KIND, not the parser being absent', () => {
    const index = extractNarrativeIndex([
      ...withoutPaths(manuscript(), ['content/chapter-01.md', 'entities/characters/krishna.yaml']),
      file('content/chapter-01.md', 'A hush falls. [[char:arjuna]] speaks.\n'),
      file('entities/characters/krishna.yaml', 'id: krishna\nname: Krishna\nbackstory: Beside [[char:arjuna]] on the field.\n')
    ]);

    expect(index.mentions.filter(mention => mention.raw === '[[char:arjuna]]')).toHaveLength(1);
    expect(index.relations.filter(relation => relation.sourceId === 'krishna')).toHaveLength(1);
  });

  // THIS IS NOT AN ENDORSEMENT. #46 inherits the asymmetry and does not repair
  // it — measuring what today's ASCII filter is protecting is gh#66's work.
  // What these two tests buy is that the asymmetry cannot change unnoticed IN
  // EITHER DIRECTION: unifying the parsers reddens the first test, and letting
  // the prose path regress to ASCII reddens it too.
});

// ---------------------------------------------------------------------------
// relation.origin (F-P11-2)
// ---------------------------------------------------------------------------

describe('relation origin', () => {
  test('an ownership entry that STATES ai-candidate is extracted as one', () => {
    const index = extractNarrativeIndex(manuscript());
    const agni = index.relations.find(relation => relation.targetId === 'agni')!;

    // Without this, an `ai-candidate` relation exists NOWHERE on any path of
    // #46 — there is no writer for one, so the fixture is hand-written and this
    // read is the only thing that proves the value survives.
    expect(agni.origin).toBe('ai-candidate');
  });

  test('an ownership entry with NO origin field is author-written', () => {
    const index = extractNarrativeIndex(manuscript());
    const varuna = index.relations.find(relation => relation.targetId === 'varuna')!;

    expect(varuna.origin).toBe('explicit');
  });

  test('an unknown origin is reported rather than silently accepted', () => {
    const index = extractNarrativeIndex([
      ...withoutPaths(manuscript(), ['entities/artifacts/gandiva.yaml']),
      file('entities/artifacts/gandiva.yaml', 'id: gandiva\nname: Gandiva\nownership:\n  - owner: varuna\n    origin: ai_candidate\n')
    ]);

    expect(index.cardProblems.map(problem => problem.code)).toEqual(['unknown-origin']);
    // A typo must not promote a candidate to author-written in silence.
    expect(index.relations.find(relation => relation.targetId === 'varuna')!.origin).toBe('explicit');
  });

  test('a card that states ai-candidate passes it to the relations its text implies', () => {
    const index = extractNarrativeIndex([
      ...withoutPaths(manuscript(), ['entities/characters/krishna.yaml']),
      file('entities/characters/krishna.yaml', 'id: krishna\nname: Krishna\norigin: ai-candidate\nbackstory: Beside [[arjuna]].\n')
    ]);

    expect(index.entities.find(entity => entity.id === 'krishna')!.origin).toBe('ai-candidate');
    expect(index.relations.find(relation => relation.relType === 'mentions')!.origin).toBe('ai-candidate');
  });
});

// ---------------------------------------------------------------------------
// Purity — the property prohibitions (a) and (c) exist to protect
// ---------------------------------------------------------------------------

describe('purity', () => {
  test('the same input yields a deeply equal result, twice', () => {
    expect(extractNarrativeIndex(manuscript())).toEqual(extractNarrativeIndex(manuscript()));
  });

  test('a malformed card is reported and costs nothing else', () => {
    const index = extractNarrativeIndex([
      ...manuscript(),
      file('entities/terms/broken.yaml', 'id: [unclosed\n')
    ]);

    expect(index.cardProblems.map(problem => problem.code)).toEqual(['invalid-yaml']);
    expect(index.entities.some(entity => entity.id === 'broken')).toBe(false);
    // Everything else still extracted.
    expect(index.entities.some(entity => entity.id === 'krishna')).toBe(true);
  });
});
