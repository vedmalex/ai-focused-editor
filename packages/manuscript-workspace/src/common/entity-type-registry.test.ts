import { describe, expect, test } from 'bun:test';
import {
  BASE_ENTITY_TYPES,
  ENTITY_KIND_IDS,
  ENTITY_TAG_KINDS,
  entityKindDirectories,
  entityKindLabelFields,
  entityKindLabels,
  entityKindSections,
  entityKindTags,
  entityTypeByDirectory,
  entityTypeById,
  entityTypeByTagKind,
  tagKindToEntityKind
} from './entity-type-registry';

describe('BASE_ENTITY_TYPES integrity', () => {
  test('declares exactly the four built-in kinds in canonical order', () => {
    expect(BASE_ENTITY_TYPES.map(type => type.id)).toEqual(['character', 'term', 'artifact', 'location']);
  });

  test('ids are unique', () => {
    const ids = BASE_ENTITY_TYPES.map(type => type.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('tagKinds are unique', () => {
    const tags = BASE_ENTITY_TYPES.map(type => type.tagKind);
    expect(new Set(tags).size).toBe(tags.length);
  });

  test('directories are unique', () => {
    const directories = BASE_ENTITY_TYPES.map(type => type.directory);
    expect(new Set(directories).size).toBe(directories.length);
  });

  test('character uses the char tag shorthand; every other kind is verbatim', () => {
    expect(entityTypeById('character')?.tagKind).toBe('char');
    for (const type of BASE_ENTITY_TYPES) {
      if (type.id !== 'character') {
        expect(type.tagKind).toBe(type.id);
      }
    }
  });
});

describe('derived value maps equal the previously hardcoded literals', () => {
  test('ENTITY_KIND_IDS matches the old CREATABLE_ENTITY_KINDS literal', () => {
    expect(ENTITY_KIND_IDS).toEqual(['character', 'term', 'artifact', 'location']);
  });

  test('ENTITY_TAG_KINDS matches the old completion-provider bare-kind list', () => {
    expect(ENTITY_TAG_KINDS).toEqual(['char', 'term', 'artifact', 'location']);
  });

  test('entityKindDirectories matches the old ENTITY_KIND_DIRECTORY', () => {
    expect(entityKindDirectories()).toEqual({
      character: 'characters',
      term: 'terms',
      artifact: 'artifacts',
      location: 'locations'
    });
  });

  test('entityKindTags matches the old ENTITY_KIND_TAG', () => {
    expect(entityKindTags()).toEqual({
      character: 'char',
      term: 'term',
      artifact: 'artifact',
      location: 'location'
    });
  });

  test('entityKindLabels matches the old ENTITY_KIND_LABEL', () => {
    expect(entityKindLabels()).toEqual({
      character: 'Character',
      term: 'Term',
      artifact: 'Artifact',
      location: 'Location'
    });
  });

  test('entityKindSections matches the old ENTITY_KIND_TO_SECTION', () => {
    expect(entityKindSections()).toEqual({
      character: 'characters',
      term: 'terms',
      artifact: 'artifacts',
      location: 'locations'
    });
  });

  test('entityKindLabelFields matches the old node labelField map (term uses "term")', () => {
    expect(entityKindLabelFields()).toEqual({
      character: 'name',
      term: 'term',
      artifact: 'name',
      location: 'name'
    });
  });
});

describe('lookups', () => {
  test('entityTypeById resolves each kind', () => {
    expect(entityTypeById('term')?.directory).toBe('terms');
    expect(entityTypeById('nope')).toBeUndefined();
  });

  test('entityTypeByTagKind resolves the char shorthand', () => {
    expect(entityTypeByTagKind('char')?.id).toBe('character');
    expect(entityTypeByTagKind('character')).toBeUndefined();
  });

  test('entityTypeByDirectory resolves the bare subdir', () => {
    expect(entityTypeByDirectory('locations')?.id).toBe('location');
    expect(entityTypeByDirectory('entities/locations')).toBeUndefined();
  });
});

describe('tagKindToEntityKind', () => {
  test('maps char to character', () => {
    expect(tagKindToEntityKind('char')).toBe('character');
  });

  test('passes the built-in kinds through verbatim', () => {
    expect(tagKindToEntityKind('term')).toBe('term');
    expect(tagKindToEntityKind('artifact')).toBe('artifact');
    expect(tagKindToEntityKind('location')).toBe('location');
  });

  test('passes UNKNOWN tag kinds through verbatim (preserves current link-nav semantics)', () => {
    expect(tagKindToEntityKind('faction')).toBe('faction');
    expect(tagKindToEntityKind('character')).toBe('character');
    expect(tagKindToEntityKind('')).toBe('');
  });
});

describe('fields schema mirrors the entity form editor', () => {
  test('every type shares the same ordered field set (label field name aside)', () => {
    for (const type of BASE_ENTITY_TYPES) {
      expect(type.fields.map(field => field.name)).toEqual([
        'id',
        type.id === 'term' ? 'term' : 'name',
        'aliases',
        'epithets',
        'summary',
        'backstory',
        'arc',
        'speechPatterns',
        'notes'
      ]);
    }
  });

  test('list fields are aliases/epithets/speechPatterns; scalars are text/textarea', () => {
    const character = entityTypeById('character')!;
    const byName = Object.fromEntries(character.fields.map(field => [field.name, field.kind]));
    expect(byName.id).toBe('text');
    expect(byName.name).toBe('text');
    expect(byName.aliases).toBe('list');
    expect(byName.epithets).toBe('list');
    expect(byName.speechPatterns).toBe('list');
    expect(byName.summary).toBe('textarea');
    expect(byName.backstory).toBe('textarea');
    expect(byName.arc).toBe('textarea');
    expect(byName.notes).toBe('textarea');
  });

  test('exactly one id field and one label field per type', () => {
    for (const type of BASE_ENTITY_TYPES) {
      expect(type.fields.filter(field => field.role === 'id')).toHaveLength(1);
      expect(type.fields.filter(field => field.role === 'label')).toHaveLength(1);
    }
  });
});
