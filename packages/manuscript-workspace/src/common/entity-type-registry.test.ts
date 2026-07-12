import { describe, expect, test } from 'bun:test';
import {
  BASE_ENTITY_TYPES,
  DEFAULT_AUTHOR_FIELDS,
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
  mergeEntityTypes,
  parseEntityTypesYaml,
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

describe('parseEntityTypesYaml — empty / absent', () => {
  test('empty string yields no types and no problems', () => {
    expect(parseEntityTypesYaml('')).toEqual({ types: [], problems: [] });
  });

  test('whitespace-only yields no types and no problems', () => {
    expect(parseEntityTypesYaml('   \n  ')).toEqual({ types: [], problems: [] });
  });

  test('a null document (comments only) is a legitimate empty file', () => {
    expect(parseEntityTypesYaml('# just a comment\n')).toEqual({ types: [], problems: [] });
  });

  test('non-list / non-{types} document is an invalid-shape problem', () => {
    const result = parseEntityTypesYaml('id: faction\nlabel: Faction\n');
    expect(result.types).toEqual([]);
    expect(result.problems.map(p => p.code)).toEqual(['invalid-shape']);
  });

  test('invalid YAML is an invalid-shape problem, not a throw', () => {
    const result = parseEntityTypesYaml('types: [unterminated');
    expect(result.types).toEqual([]);
    expect(result.problems.map(p => p.code)).toEqual(['invalid-shape']);
  });
});

describe('parseEntityTypesYaml — defaults', () => {
  test('a minimal { id, label } entry fills in tagKind/directory/icon/fields', () => {
    const { types, problems } = parseEntityTypesYaml('- id: faction\n  label: Faction\n');
    expect(problems).toEqual([]);
    expect(types).toHaveLength(1);
    const faction = types[0];
    expect(faction.id).toBe('faction');
    expect(faction.label).toBe('Faction');
    expect(faction.tagKind).toBe('faction');
    expect(faction.directory).toBe('faction');
    expect(faction.sectionKind).toBe('faction');
    expect(faction.icon).toContain('codicon');
    expect(faction.sectionIcon).toContain('codicon');
    expect(faction.fields).toEqual([...DEFAULT_AUTHOR_FIELDS]);
  });

  test('the { types: [...] } object form is accepted', () => {
    const { types, problems } = parseEntityTypesYaml('types:\n  - id: faction\n    label: Faction\n');
    expect(problems).toEqual([]);
    expect(types.map(t => t.id)).toEqual(['faction']);
  });

  test('explicit tagKind/directory/accentClass override the defaults', () => {
    const { types } = parseEntityTypesYaml(
      '- id: faction\n  label: Faction\n  tagKind: fac\n  directory: factions\n  accentClass: afe-ico-factions\n'
    );
    expect(types[0].tagKind).toBe('fac');
    expect(types[0].directory).toBe('factions');
    expect(types[0].accentClass).toBe('afe-ico-factions');
  });

  test('DEFAULT_AUTHOR_FIELDS is the id/name/aliases/summary/notes subset with one id + one label', () => {
    expect(DEFAULT_AUTHOR_FIELDS.map(f => f.name)).toEqual(['id', 'name', 'aliases', 'summary', 'notes']);
    expect(DEFAULT_AUTHOR_FIELDS.filter(f => f.role === 'id')).toHaveLength(1);
    expect(DEFAULT_AUTHOR_FIELDS.filter(f => f.role === 'label')).toHaveLength(1);
  });

  test('a provided fields list is normalised to have exactly one id and one label', () => {
    const { types } = parseEntityTypesYaml(
      '- id: faction\n  label: Faction\n  fields:\n    - name: motto\n      kind: text\n    - name: members\n      kind: list\n'
    );
    const fields = types[0].fields;
    expect(fields.filter(f => f.role === 'id')).toHaveLength(1);
    expect(fields.filter(f => f.role === 'label')).toHaveLength(1);
    // id is prepended; the first author field becomes the label.
    expect(fields[0].name).toBe('id');
    expect(fields.find(f => f.role === 'label')?.name).toBe('motto');
  });
});

describe('parseEntityTypesYaml — validation codes', () => {
  test('a non-object entry is invalid-entry', () => {
    const { types, problems } = parseEntityTypesYaml('- just a string\n');
    expect(types).toEqual([]);
    expect(problems.map(p => p.code)).toEqual(['invalid-entry']);
  });

  test('a missing id is missing-id', () => {
    const { problems } = parseEntityTypesYaml('- label: No Id\n');
    expect(problems.map(p => p.code)).toEqual(['missing-id']);
  });

  test('a non-kebab id is invalid-id', () => {
    const { problems } = parseEntityTypesYaml('- id: Faction_One\n  label: X\n');
    expect(problems.map(p => p.code)).toEqual(['invalid-id']);
  });

  test('a missing label is missing-label', () => {
    const { problems } = parseEntityTypesYaml('- id: faction\n');
    expect(problems.map(p => p.code)).toEqual(['missing-label']);
  });

  test('colliding with a built-in id / tagKind / directory is reserved-*', () => {
    expect(parseEntityTypesYaml('- id: character\n  label: C\n').problems.map(p => p.code)).toEqual(['reserved-id']);
    expect(parseEntityTypesYaml('- id: hero\n  label: H\n  tagKind: char\n').problems.map(p => p.code)).toEqual(['reserved-tag-kind']);
    expect(parseEntityTypesYaml('- id: hero\n  label: H\n  directory: characters\n').problems.map(p => p.code)).toEqual(['reserved-directory']);
  });

  test('duplicate author id / tagKind / directory is duplicate-*', () => {
    const dupId = parseEntityTypesYaml('- id: faction\n  label: A\n- id: faction\n  label: B\n');
    expect(dupId.types).toHaveLength(1);
    expect(dupId.problems.map(p => p.code)).toEqual(['duplicate-id']);

    const dupTag = parseEntityTypesYaml('- id: faction\n  label: A\n  tagKind: fac\n- id: guild\n  label: B\n  tagKind: fac\n');
    expect(dupTag.problems.map(p => p.code)).toEqual(['duplicate-tag-kind']);

    const dupDir = parseEntityTypesYaml('- id: faction\n  label: A\n  directory: groups\n- id: guild\n  label: B\n  directory: groups\n');
    expect(dupDir.problems.map(p => p.code)).toEqual(['duplicate-directory']);
  });

  test('valid entries survive alongside invalid ones', () => {
    const { types, problems } = parseEntityTypesYaml('- id: faction\n  label: Faction\n- id: Bad Id\n  label: X\n- id: guild\n  label: Guild\n');
    expect(types.map(t => t.id)).toEqual(['faction', 'guild']);
    expect(problems.map(p => p.code)).toEqual(['invalid-id']);
  });
});

describe('mergeEntityTypes', () => {
  test('built-ins come first tagged built-in; author types append tagged book', () => {
    const { types } = parseEntityTypesYaml('- id: faction\n  label: Faction\n');
    const effective = mergeEntityTypes(BASE_ENTITY_TYPES, types);
    expect(effective.map(t => t.id)).toEqual(['character', 'term', 'artifact', 'location', 'faction']);
    expect(effective.slice(0, 4).every(t => t.origin === 'built-in')).toBe(true);
    expect(effective[4].origin).toBe('book');
  });

  test('an empty author list yields exactly the built-in set', () => {
    const effective = mergeEntityTypes(BASE_ENTITY_TYPES, []);
    expect(effective.map(t => t.id)).toEqual(['character', 'term', 'artifact', 'location']);
    expect(effective.every(t => t.origin === 'built-in')).toBe(true);
  });

  test('defensively skips an author type that collides with a built-in (never overrides)', () => {
    const collidingAuthor = [{
      id: 'character',
      tagKind: 'char',
      directory: 'characters',
      label: 'Hijacked',
      sectionKind: 'characters',
      icon: 'codicon codicon-person',
      sectionIcon: 'codicon codicon-account',
      fields: [...DEFAULT_AUTHOR_FIELDS]
    }];
    const effective = mergeEntityTypes(BASE_ENTITY_TYPES, collidingAuthor);
    expect(effective).toHaveLength(4);
    expect(effective.find(t => t.id === 'character')?.label).toBe('Character');
    expect(effective.find(t => t.id === 'character')?.origin).toBe('built-in');
  });
});
