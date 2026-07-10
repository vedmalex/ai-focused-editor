import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import {
  CREATABLE_ENTITY_KINDS,
  ENTITY_KIND_DIRECTORY,
  ENTITY_KIND_LABEL,
  ENTITY_KIND_TAG,
  KNOWLEDGE_CATEGORIES,
  buildEntityYaml,
  buildKnowledgeNoteMarkdown,
  createSemanticEntityId,
  entityRelativePath,
  knowledgeNoteRelativePath,
  selectionToSummary,
  shouldWrapSelectionAsTag,
  suggestEntityName,
  uniqueRelativePath
} from './entity-creation';

describe('entity kind tables', () => {
  test('CREATABLE_ENTITY_KINDS lists all four kinds', () => {
    expect(CREATABLE_ENTITY_KINDS).toEqual(['character', 'term', 'artifact', 'location']);
  });

  test('ENTITY_KIND_DIRECTORY maps each kind to its entities/ subdirectory', () => {
    expect(ENTITY_KIND_DIRECTORY).toEqual({
      character: 'characters',
      term: 'terms',
      artifact: 'artifacts',
      location: 'locations'
    });
  });

  test('ENTITY_KIND_TAG uses the char shorthand for character, verbatim otherwise', () => {
    expect(ENTITY_KIND_TAG).toEqual({
      character: 'char',
      term: 'term',
      artifact: 'artifact',
      location: 'location'
    });
  });

  test('ENTITY_KIND_LABEL is a human-readable capitalized label', () => {
    expect(ENTITY_KIND_LABEL).toEqual({
      character: 'Character',
      term: 'Term',
      artifact: 'Artifact',
      location: 'Location'
    });
  });
});

describe('createSemanticEntityId', () => {
  test('slugs a simple ASCII label', () => {
    expect(createSemanticEntityId('char', 'Arjuna')).toBe('arjuna');
  });

  test('slugs a multi-word label to dash-separated lowercase', () => {
    expect(createSemanticEntityId('char', 'Krishna the Charioteer')).toBe('krishna-the-charioteer');
  });

  test('strips accents via NFKD normalization before slugging', () => {
    expect(createSemanticEntityId('term', 'Élan Vital')).toBe('elan-vital');
  });

  test('trims leading/trailing punctuation runs produced by disallowed characters', () => {
    expect(createSemanticEntityId('artifact', '  ***Gandiva!!!  ')).toBe('gandiva');
  });

  test('caps the slug at 48 characters', () => {
    const label = 'a'.repeat(80);
    const id = createSemanticEntityId('term', label);
    expect(id.length).toBeLessThanOrEqual(48);
    expect(id).toBe('a'.repeat(48));
  });

  test('falls back to a kind-prefixed hash for a Cyrillic-only label (no allowed characters survive)', () => {
    const id = createSemanticEntityId('char', 'Кришна');
    expect(id).toMatch(/^char-[0-9a-z]+$/);
  });

  test('falls back to a kind-prefixed hash for a label with only symbols', () => {
    const id = createSemanticEntityId('term', '★★★');
    expect(id).toMatch(/^term-[0-9a-z]+$/);
  });

  test('hash fallback is deterministic for the same kind + label', () => {
    const first = createSemanticEntityId('char', 'Кришна');
    const second = createSemanticEntityId('char', 'Кришна');
    expect(first).toBe(second);
  });

  test('hash fallback prefix reflects the kind argument even for identical labels', () => {
    const charId = createSemanticEntityId('char', 'Кришна');
    const characterId = createSemanticEntityId('character', 'Кришна');
    expect(charId.startsWith('char-')).toBe(true);
    expect(characterId.startsWith('character-')).toBe(true);
    // Same label, different kind prefixes; the hash suffix stays identical.
    expect(charId.slice('char-'.length)).toBe(characterId.slice('character-'.length));
  });

  test('tag id and entity file id agree for ordinary labels regardless of kind argument', () => {
    // Downstream, the tag kind (e.g. `char`) and the entity kind (`character`) are
    // different strings, but the slug itself must not depend on which kind is
    // passed in the non-fallback path -- otherwise a `[[char:id|label]]` tag and
    // its `entities/characters/<id>.yaml` file could disagree on `id`.
    const label = 'Wielder of Gandiva';
    expect(createSemanticEntityId('char', label)).toBe(createSemanticEntityId('character', label));
  });

  test('empty label falls back to a hash id', () => {
    expect(createSemanticEntityId('note', '')).toMatch(/^note-[0-9a-z]+$/);
  });
});

describe('buildEntityYaml', () => {
  test('includes id, name, and an always-present empty aliases array', () => {
    const yaml = buildEntityYaml({ id: 'gandiva', name: 'Gandiva' });
    const parsed = parse(yaml);
    expect(parsed).toEqual({ id: 'gandiva', name: 'Gandiva', aliases: [] });
  });

  test('includes summary when non-blank after trimming', () => {
    const yaml = buildEntityYaml({ id: 'gandiva', name: 'Gandiva', summary: '  A divine bow.  ' });
    const parsed = parse(yaml);
    expect(parsed).toEqual({ id: 'gandiva', name: 'Gandiva', aliases: [], summary: 'A divine bow.' });
  });

  test('omits summary when blank/whitespace-only', () => {
    const yaml = buildEntityYaml({ id: 'gandiva', name: 'Gandiva', summary: '   ' });
    const parsed = parse(yaml);
    expect(parsed).toEqual({ id: 'gandiva', name: 'Gandiva', aliases: [] });
    expect(Object.prototype.hasOwnProperty.call(parsed, 'summary')).toBe(false);
  });

  test('omits summary when undefined', () => {
    const yaml = buildEntityYaml({ id: 'gandiva', name: 'Gandiva', summary: undefined });
    const parsed = parse(yaml);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'summary')).toBe(false);
  });

  test('key order matches the example entity files: id, name, aliases, summary', () => {
    const yaml = buildEntityYaml({ id: 'gandiva', name: 'Gandiva', summary: 'A divine bow.' });
    const idIndex = yaml.indexOf('id:');
    const nameIndex = yaml.indexOf('name:');
    const aliasesIndex = yaml.indexOf('aliases:');
    const summaryIndex = yaml.indexOf('summary:');
    expect(idIndex).toBeGreaterThanOrEqual(0);
    expect(idIndex).toBeLessThan(nameIndex);
    expect(nameIndex).toBeLessThan(aliasesIndex);
    expect(aliasesIndex).toBeLessThan(summaryIndex);
  });
});

describe('entityRelativePath', () => {
  test('builds entities/<dir>/<id>.yaml for every kind', () => {
    expect(entityRelativePath('character', 'arjuna')).toBe('entities/characters/arjuna.yaml');
    expect(entityRelativePath('term', 'dharma')).toBe('entities/terms/dharma.yaml');
    expect(entityRelativePath('artifact', 'gandiva')).toBe('entities/artifacts/gandiva.yaml');
    expect(entityRelativePath('location', 'kurukshetra')).toBe('entities/locations/kurukshetra.yaml');
  });
});

describe('uniqueRelativePath', () => {
  test('returns the desired path unchanged when free', () => {
    const result = uniqueRelativePath('entities/characters/arjuna.yaml', () => false);
    expect(result).toBe('entities/characters/arjuna.yaml');
  });

  test('inserts -2 before the extension when the desired path is taken', () => {
    const taken = new Set(['entities/characters/arjuna.yaml']);
    const result = uniqueRelativePath('entities/characters/arjuna.yaml', candidate => taken.has(candidate));
    expect(result).toBe('entities/characters/arjuna-2.yaml');
  });

  test('increments past multiple taken numbered suffixes', () => {
    const taken = new Set([
      'entities/characters/arjuna.yaml',
      'entities/characters/arjuna-2.yaml',
      'entities/characters/arjuna-3.yaml'
    ]);
    const result = uniqueRelativePath('entities/characters/arjuna.yaml', candidate => taken.has(candidate));
    expect(result).toBe('entities/characters/arjuna-4.yaml');
  });

  test('handles a desired path with no extension', () => {
    const taken = new Set(['knowledge/plans/roadmap']);
    const result = uniqueRelativePath('knowledge/plans/roadmap', candidate => taken.has(candidate));
    expect(result).toBe('knowledge/plans/roadmap-2');
  });

  test('handles a dotted directory segment without an extension on the filename', () => {
    // The last "." is in a directory segment, not the filename, so there is no extension to preserve.
    const taken = new Set(['entities/v1.0/characters/arjuna']);
    const result = uniqueRelativePath('entities/v1.0/characters/arjuna', candidate => taken.has(candidate));
    expect(result).toBe('entities/v1.0/characters/arjuna-2');
  });

  test('gives up after 99 numbered attempts and falls back to a hash suffix that terminates', () => {
    // exists() rejects every candidate unconditionally; the function must still
    // return in bounded time rather than looping forever.
    const result = uniqueRelativePath('entities/characters/arjuna.yaml', () => true);
    expect(result.startsWith('entities/characters/arjuna-')).toBe(true);
    expect(result.endsWith('.yaml')).toBe(true);
    // Not one of the 98 numbered candidates that were exhausted (2..99).
    expect(/arjuna-\d+\.yaml$/.test(result)).toBe(false);
  });

  test('hash fallback is deterministic for the same desired path', () => {
    const first = uniqueRelativePath('entities/characters/arjuna.yaml', () => true);
    const second = uniqueRelativePath('entities/characters/arjuna.yaml', () => true);
    expect(first).toBe(second);
  });
});

describe('suggestEntityName', () => {
  test('uses the first non-empty line of a multi-line selection', () => {
    expect(suggestEntityName('\n\n  Krishna  \nSecond line here')).toBe('Krishna');
  });

  test('collapses internal whitespace to single spaces', () => {
    expect(suggestEntityName('Krishna    the   \t Charioteer')).toBe('Krishna the Charioteer');
  });

  test('strips [ ] and | characters that collide with markdown link/tag syntax', () => {
    // Brackets and the pipe are removed outright (not replaced with a separator).
    expect(suggestEntityName('[[char:krishna|Krishna]]')).toBe('char:krishnaKrishna');
  });

  test('caps at 60 characters, cutting at a word boundary when possible', () => {
    const words = 'Krishna the divine charioteer who guides Arjuna through the great battle of Kurukshetra';
    const result = suggestEntityName(words);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(words.startsWith(result)).toBe(true);
    // Boundary cut: should not end mid-word (original char at cut point is a space or end of a word).
    expect(result.endsWith(' ')).toBe(false);
  });

  test('hard-cuts a single very long word with no boundary to cut at', () => {
    const longWord = 'a'.repeat(90);
    const result = suggestEntityName(longWord);
    expect(result.length).toBe(60);
    expect(result).toBe('a'.repeat(60));
  });

  test('returns empty string for an entirely blank selection', () => {
    expect(suggestEntityName('   \n   \n  ')).toBe('');
  });
});

describe('selectionToSummary', () => {
  test('normalizes whitespace to single spaces', () => {
    const summary = selectionToSummary('The   finest\narcher   of his generation.', 'Arjuna');
    expect(summary).toBe('The finest archer of his generation.');
  });

  test('returns undefined when the normalized selection equals the normalized name', () => {
    expect(selectionToSummary('  Arjuna   the   Archer  ', 'Arjuna the Archer')).toBeUndefined();
  });

  test('returns undefined when the selection is too short to add information (<12 chars)', () => {
    expect(selectionToSummary('Arjuna', 'Arjuna')).toBeUndefined();
    expect(selectionToSummary('short', 'Name')).toBeUndefined();
  });

  test('returns the normalized selection when it is meaningfully longer than the name', () => {
    const selection = 'Warrior-disciple whose questions create the central dialogue.';
    expect(selectionToSummary(selection, 'Arjuna')).toBe(selection);
  });

  test('caps at 500 characters', () => {
    const long = 'word '.repeat(200).trim(); // 999 characters before cap
    const summary = selectionToSummary(long, 'Name');
    expect(summary).toBeDefined();
    expect(summary!.length).toBeLessThanOrEqual(500);
  });
});

describe('shouldWrapSelectionAsTag', () => {
  test('true for a short single-line selection', () => {
    expect(shouldWrapSelectionAsTag('Arjuna')).toBe(true);
  });

  test('true at the 1-character lower boundary', () => {
    expect(shouldWrapSelectionAsTag('A')).toBe(true);
  });

  test('true at the 120-character upper boundary', () => {
    expect(shouldWrapSelectionAsTag('a'.repeat(120))).toBe(true);
  });

  test('false above the 120-character upper boundary', () => {
    expect(shouldWrapSelectionAsTag('a'.repeat(121))).toBe(false);
  });

  test('false for an empty/whitespace-only selection', () => {
    expect(shouldWrapSelectionAsTag('')).toBe(false);
    expect(shouldWrapSelectionAsTag('   ')).toBe(false);
  });

  test('false for a multi-line selection', () => {
    expect(shouldWrapSelectionAsTag('Arjuna\nthe Archer')).toBe(false);
  });

  test('false when already wrapped as a tag', () => {
    expect(shouldWrapSelectionAsTag('[[char:arjuna|Arjuna]]')).toBe(false);
  });

  test('true when brackets are present but not a full wrap', () => {
    expect(shouldWrapSelectionAsTag('[Arjuna]')).toBe(true);
  });

  test('trims surrounding whitespace before evaluating', () => {
    expect(shouldWrapSelectionAsTag('   Arjuna   ')).toBe(true);
  });
});

describe('KNOWLEDGE_CATEGORIES', () => {
  test('lists the three known categories', () => {
    expect(KNOWLEDGE_CATEGORIES).toEqual(['plans', 'questions', 'summaries']);
  });
});

describe('knowledgeNoteRelativePath', () => {
  test('builds knowledge/<category>/<slug>.md when a category is given', () => {
    expect(knowledgeNoteRelativePath('plans', 'Chapter Two Outline')).toBe('knowledge/plans/chapter-two-outline.md');
  });

  test('builds knowledge/<slug>.md when no category is given', () => {
    expect(knowledgeNoteRelativePath(undefined, 'Chapter Two Outline')).toBe('knowledge/chapter-two-outline.md');
  });

  test('slug falls back to a note-prefixed hash for a Cyrillic-only title', () => {
    const path = knowledgeNoteRelativePath('questions', 'Вопрос');
    expect(path).toMatch(/^knowledge\/questions\/note-[0-9a-z]+\.md$/);
  });
});

describe('buildKnowledgeNoteMarkdown', () => {
  test('renders an H1 title followed by a blank line', () => {
    expect(buildKnowledgeNoteMarkdown('Chapter Two Outline')).toBe('# Chapter Two Outline\n\n');
  });
});
