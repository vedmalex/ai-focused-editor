import { describe, expect, test } from 'bun:test';
import { Document } from 'yaml';
import {
  DEFAULT_AUTHOR_FIELDS,
  DEFAULT_AUTHOR_ICON,
  parseEntityTypesYaml
} from './entity-type-registry';
import {
  defaultFieldRows,
  emptyAuthorTypeRow,
  fieldsEqualDefault,
  hasBlockingTypeProblems,
  rowToYamlPatch,
  serializeTypesDocument,
  typesToRows,
  validateTypeRows,
  type AuthorTypeRow
} from './entity-type-forms';

function authorRow(overrides: Partial<AuthorTypeRow> = {}): AuthorTypeRow {
  return { ...emptyAuthorTypeRow(), id: 'faction', label: 'Faction', ...overrides };
}

describe('typesToRows', () => {
  test('flattens parsed descriptors with defaults already resolved', () => {
    const { types } = parseEntityTypesYaml('- id: faction\n  label: Faction\n');
    const rows = typesToRows(types);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'faction',
      label: 'Faction',
      // parse defaults tagKind/directory to the id and icon to the registry default.
      tagKind: 'faction',
      directory: 'faction',
      icon: DEFAULT_AUTHOR_ICON,
      fields: DEFAULT_AUTHOR_FIELDS.map(field => ({ name: field.name, kind: field.kind, label: field.labelKey }))
    });
  });

  test('carries an explicit accentClass through', () => {
    const { types } = parseEntityTypesYaml('- id: faction\n  label: Faction\n  accentClass: afe-ico-factions\n');
    expect(typesToRows(types)[0].accentClass).toBe('afe-ico-factions');
  });

  test('normalises field order to id-then-label-then-rest', () => {
    // motto is authored first with no role; parse promotes it to the label, and
    // prepends an id field. typesToRows must surface id at 0 and label at 1.
    const { types } = parseEntityTypesYaml(
      '- id: faction\n  label: Faction\n  fields:\n    - { name: motto, kind: text }\n    - { name: members, kind: list }\n'
    );
    const rows = typesToRows(types);
    expect(rows[0].fields[0].name).toBe('id');
    expect(rows[0].fields[1].name).toBe('motto');
    expect(rows[0].fields.map(field => field.name)).toEqual(['id', 'motto', 'members']);
  });
});

describe('default omission', () => {
  test('a minimal type writes only id + label', () => {
    const patch = rowToYamlPatch(authorRow());
    expect(patch).toEqual({ id: 'faction', label: 'Faction' });
  });

  test('tagKind/directory are omitted when they equal the id, written otherwise', () => {
    expect(rowToYamlPatch(authorRow({ tagKind: 'faction', directory: 'faction' })))
      .toEqual({ id: 'faction', label: 'Faction' });
    const patch = rowToYamlPatch(authorRow({ tagKind: 'fac', directory: 'factions' }));
    expect(patch.tagKind).toBe('fac');
    expect(patch.directory).toBe('factions');
  });

  test('the default icon is omitted; a custom icon is written', () => {
    expect('icon' in rowToYamlPatch(authorRow({ icon: DEFAULT_AUTHOR_ICON }))).toBe(false);
    expect(rowToYamlPatch(authorRow({ icon: 'codicon codicon-organization' })).icon)
      .toBe('codicon codicon-organization');
  });

  test('default fields are omitted; a changed schema is written', () => {
    expect('fields' in rowToYamlPatch(authorRow())).toBe(false);
    const custom = authorRow({ fields: [...defaultFieldRows(), { name: 'motto', kind: 'text', label: '' }] });
    expect(Array.isArray(rowToYamlPatch(custom).fields)).toBe(true);
  });

  test('fieldsEqualDefault is true for the seeded default schema', () => {
    expect(fieldsEqualDefault(defaultFieldRows())).toBe(true);
    expect(fieldsEqualDefault(defaultFieldRows().slice(0, 3))).toBe(false);
  });
});

describe('serializeTypesDocument', () => {
  test('preserves the version key and a leading comment', () => {
    const { parseDocument } = require('yaml');
    const doc = parseDocument('# my types\nversion: 1\ntypes: []\n') as Document;
    const out = serializeTypesDocument(doc, [authorRow()]);
    expect(out).toContain('# my types');
    expect(out).toContain('version: 1');
    expect(out).toContain('id: faction');
    expect(out).toContain('label: Faction');
  });

  test('round-trips: parse -> rows -> serialize -> parse yields equivalent types', () => {
    const source = 'version: 1\ntypes:\n  - id: faction\n    label: Faction\n    tagKind: fac\n    directory: factions\n  - id: guild\n    label: Guild\n';
    const { parseDocument } = require('yaml');
    const first = parseEntityTypesYaml(source);
    const rows = typesToRows(first.types);
    const out = serializeTypesDocument(parseDocument(source) as Document, rows);
    const second = parseEntityTypesYaml(out);
    expect(second.problems).toEqual([]);
    expect(second.types).toEqual(first.types);
  });

  test('round-trips a custom field schema', () => {
    const source = 'types:\n  - id: faction\n    label: Faction\n    fields:\n      - { name: id, kind: text, role: id }\n      - { name: name, kind: text, role: label }\n      - { name: motto, kind: textarea }\n';
    const { parseDocument } = require('yaml');
    const first = parseEntityTypesYaml(source);
    const rows = typesToRows(first.types);
    const out = serializeTypesDocument(parseDocument(source) as Document, rows);
    const second = parseEntityTypesYaml(out);
    expect(second.types).toEqual(first.types);
    expect(second.types[0].fields.map(f => f.name)).toEqual(['id', 'name', 'motto']);
  });
});

describe('validateTypeRows delegates to the registry parser', () => {
  test('an empty list is valid', () => {
    const problems = validateTypeRows([]);
    expect(problems).toEqual([]);
    expect(hasBlockingTypeProblems(problems)).toBe(false);
  });

  test('a clean author type is valid', () => {
    expect(validateTypeRows([authorRow()])).toEqual([]);
  });

  test('surfaces reserved-id against a built-in', () => {
    const problems = validateTypeRows([authorRow({ id: 'character', label: 'Hijack' })]);
    expect(problems.map(p => p.code)).toEqual(['reserved-id']);
    expect(hasBlockingTypeProblems(problems)).toBe(true);
  });

  test('surfaces reserved-tag-kind against a built-in tag', () => {
    const problems = validateTypeRows([authorRow({ id: 'hero', label: 'Hero', tagKind: 'char' })]);
    expect(problems.map(p => p.code)).toEqual(['reserved-tag-kind']);
  });

  test('surfaces duplicate-tag-kind across author rows with the row index', () => {
    const problems = validateTypeRows([
      authorRow({ id: 'faction', label: 'A', tagKind: 'grp' }),
      authorRow({ id: 'guild', label: 'B', tagKind: 'grp' })
    ]);
    expect(problems.map(p => p.code)).toEqual(['duplicate-tag-kind']);
    // The second row is the offender, so the problem index points at row 1.
    expect(problems[0].index).toBe(1);
  });

  test('surfaces a bad-kebab id as invalid-id', () => {
    const problems = validateTypeRows([authorRow({ id: 'Bad_Id', label: 'X' })]);
    expect(problems.map(p => p.code)).toEqual(['invalid-id']);
    expect(hasBlockingTypeProblems(problems)).toBe(true);
  });

  test('surfaces a missing label as missing-label', () => {
    const problems = validateTypeRows([authorRow({ id: 'faction', label: '' })]);
    expect(problems.map(p => p.code)).toEqual(['missing-label']);
  });
});

describe('field normalization preserves id/label roles', () => {
  test('positional roles survive a serialize -> parse round trip', () => {
    const row = authorRow({
      fields: [
        { name: 'id', kind: 'text', label: '' },
        { name: 'title', kind: 'text', label: '' },
        { name: 'motto', kind: 'textarea', label: '' }
      ]
    });
    const parsed = parseEntityTypesYaml(serializeTypesDocument(undefined, [row]));
    const fields = parsed.types[0].fields;
    expect(fields.filter(f => f.role === 'id')).toHaveLength(1);
    expect(fields.filter(f => f.role === 'label')).toHaveLength(1);
    expect(fields.find(f => f.role === 'id')?.name).toBe('id');
    expect(fields.find(f => f.role === 'label')?.name).toBe('title');
  });
});
