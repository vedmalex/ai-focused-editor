import { describe, expect, test } from 'bun:test';
import {
  extractMetadataFields,
  flattenManifestRows,
  includeFlagToYaml,
  normalizeManifestPath,
  validateManifestRows,
  validateMetadata,
  type MetadataFields
} from './book-config-forms';

describe('extractMetadataFields', () => {
  test('reads the known fields', () => {
    const fields = extractMetadataFields({
      title: 'Sample Book',
      language: 'en',
      author: 'AI Focused Editor Team',
      cover: 'cover.png'
    });
    expect(fields.title).toBe('Sample Book');
    expect(fields.language).toBe('en');
    expect(fields.author).toBe('AI Focused Editor Team');
    expect(fields.cover).toBe('cover.png');
    expect(fields.unknown).toEqual([]);
  });

  test('collects unknown scalar keys as editable rows (in document order)', () => {
    const fields = extractMetadataFields({
      title: 'T',
      language: 'en',
      subtitle: 'A Study',
      year: 2026,
      draft: true
    });
    expect(fields.unknown).toEqual([
      { key: 'subtitle', value: 'A Study' },
      { key: 'year', value: '2026' },
      { key: 'draft', value: 'true' }
    ]);
  });

  test('drops unknown non-scalar structures from the model', () => {
    const fields = extractMetadataFields({
      title: 'T',
      language: 'en',
      keywords: ['a', 'b'],
      contributors: { editor: 'X' },
      note: 'kept'
    });
    // Only the scalar `note` survives as an editable row.
    expect(fields.unknown).toEqual([{ key: 'note', value: 'kept' }]);
  });

  test('null scalar becomes an empty-string row', () => {
    const fields = extractMetadataFields({ title: 'T', language: 'en', edition: null });
    expect(fields.unknown).toEqual([{ key: 'edition', value: '' }]);
  });

  test('missing/invalid input yields empty fields', () => {
    expect(extractMetadataFields(undefined)).toEqual({
      title: '',
      author: '',
      language: '',
      cover: '',
      unknown: []
    });
    expect(extractMetadataFields('not an object').unknown).toEqual([]);
  });
});

describe('validateMetadata', () => {
  const base: MetadataFields = { title: 'T', author: '', language: 'en', cover: '', unknown: [] };

  test('accepts a valid record', () => {
    expect(validateMetadata(base)).toEqual([]);
  });

  test('flags a missing title', () => {
    const problems = validateMetadata({ ...base, title: '   ' });
    expect(problems).toContainEqual({ severity: 'error', field: 'title', code: 'title-required', message: 'Title is required.' });
  });

  test('flags a missing language', () => {
    const problems = validateMetadata({ ...base, language: '' });
    expect(problems.some(p => p.field === 'language' && p.severity === 'error')).toBe(true);
  });

  test('flags a too-short language', () => {
    const problems = validateMetadata({ ...base, language: 'e' });
    expect(problems.some(p => p.field === 'language' && /2 characters/.test(p.message))).toBe(true);
  });

  test('flags duplicate custom keys and shadowed built-ins', () => {
    const problems = validateMetadata({
      ...base,
      unknown: [
        { key: 'tag', value: '1' },
        { key: 'tag', value: '2' },
        { key: 'title', value: 'oops' }
      ]
    });
    expect(problems.some(p => p.severity === 'error' && /Duplicate key "tag"/.test(p.message))).toBe(true);
    expect(problems.some(p => p.severity === 'warning' && /shadows a built-in/.test(p.message))).toBe(true);
  });

  test('ignores blank custom-key rows', () => {
    const problems = validateMetadata({ ...base, unknown: [{ key: '   ', value: 'x' }] });
    expect(problems).toEqual([]);
  });

  test('attaches stable codes and params for localized rendering', () => {
    const problems = validateMetadata({
      ...base,
      language: 'e',
      unknown: [
        { key: 'title', value: 'x' },
        { key: 'k', value: '1' },
        { key: 'k', value: '2' }
      ]
    });
    expect(problems.find(p => p.code === 'language-too-short')).toBeDefined();
    expect(problems.find(p => p.code === 'custom-key-shadows-builtin')?.params).toEqual(['title']);
    expect(problems.find(p => p.code === 'duplicate-key')?.params).toEqual(['k']);
  });
});

describe('flattenManifestRows', () => {
  const manifest = {
    version: 1,
    content: [
      { path: 'content/chapter-01.md', title: 'Chapter 1' },
      {
        path: 'content/part-01',
        title: 'Part One',
        children: [
          { path: 'content/part-01/chapter-02.md', title: 'Chapter 2' },
          { path: 'content/part-01/chapter-03.md', title: 'Chapter 3', include: false }
        ]
      },
      { path: 'content/notes-draft.md', title: 'Draft Notes' }
    ]
  };

  test('flattens nested entries in order with depth', () => {
    const rows = flattenManifestRows(manifest);
    expect(rows.map(r => [r.path, r.depth])).toEqual([
      ['content/chapter-01.md', 0],
      ['content/part-01', 0],
      ['content/part-01/chapter-02.md', 1],
      ['content/part-01/chapter-03.md', 1],
      ['content/notes-draft.md', 0]
    ]);
  });

  test('marks parents with children', () => {
    const rows = flattenManifestRows(manifest);
    expect(rows.find(r => r.path === 'content/part-01')?.hasChildren).toBe(true);
    expect(rows.find(r => r.path === 'content/chapter-01.md')?.hasChildren).toBe(false);
  });

  test('reads the include flag (absent = included, false = excluded)', () => {
    const rows = flattenManifestRows(manifest);
    expect(rows.find(r => r.path === 'content/chapter-01.md')?.include).toBe(true);
    expect(rows.find(r => r.path === 'content/part-01/chapter-03.md')?.include).toBe(false);
  });

  test('tracks parent paths and sibling indexes for nested rows', () => {
    const rows = flattenManifestRows({
      content: [
        { path: 'content/a.md' },
        { path: 'content/part', children: [
          { path: 'content/part/b.md' },
          { path: 'content/part/c.md' }
        ] },
        { path: 'content/d.md' }
      ]
    });
    expect(rows.map(row => [row.path, row.parentPath, row.siblingIndex])).toEqual([
      ['content/a.md', undefined, 0],
      ['content/part', undefined, 1],
      ['content/part/b.md', 'content/part', 0],
      ['content/part/c.md', 'content/part', 1],
      ['content/d.md', undefined, 2]
    ]);
  });

  test('accepts a bare content array', () => {
    const rows = flattenManifestRows([{ path: 'a.md', title: 'A' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ path: 'a.md', title: 'A', include: true, depth: 0, hasChildren: false, parentPath: undefined, siblingIndex: 0 });
  });

  test('skips entries without a path', () => {
    const rows = flattenManifestRows({ content: [{ title: 'no path' }, { path: 'ok.md' }] });
    expect(rows.map(r => r.path)).toEqual(['ok.md']);
  });

  test('missing/invalid input yields no rows', () => {
    expect(flattenManifestRows(undefined)).toEqual([]);
    expect(flattenManifestRows({})).toEqual([]);
  });
});

describe('includeFlagToYaml round-trip', () => {
  test('included -> delete key (undefined); excluded -> false', () => {
    expect(includeFlagToYaml(true)).toBeUndefined();
    expect(includeFlagToYaml(false)).toBe(false);
  });

  test('flatten then re-encode preserves the on-disk shape', () => {
    // Excluded entry carries `include: false`; encoding it back yields `false`.
    const excluded = flattenManifestRows([{ path: 'x.md', include: false }])[0];
    expect(includeFlagToYaml(excluded.include)).toBe(false);
    // Included entry has no `include`; encoding yields `undefined` (key deleted).
    const included = flattenManifestRows([{ path: 'y.md' }])[0];
    expect(includeFlagToYaml(included.include)).toBeUndefined();
    // An explicit `include: true` normalizes to the deleted default.
    const explicitTrue = flattenManifestRows([{ path: 'z.md', include: true }])[0];
    expect(includeFlagToYaml(explicitTrue.include)).toBeUndefined();
  });
});

describe('validateManifestRows', () => {
  test('warns on empty titles only', () => {
    const problems = validateManifestRows([
      { path: 'a.md', title: 'A', include: true, depth: 0, hasChildren: false },
      { path: 'b.md', title: '  ', include: true, depth: 0, hasChildren: false }
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'warning', field: 'b.md' });
  });

  test('attaches the missing-title code and path param', () => {
    const problems = validateManifestRows([
      { path: 'b.md', title: '  ', include: true, depth: 0, hasChildren: false }
    ]);
    expect(problems[0].code).toBe('missing-title');
    expect(problems[0].params).toEqual(['b.md']);
  });
});

describe('normalizeManifestPath', () => {
  test('trims, unifies slashes, drops leading ./ and trailing /', () => {
    expect(normalizeManifestPath('  ./content/part-01/  ')).toBe('content/part-01');
    expect(normalizeManifestPath('content\\part-01\\ch.md')).toBe('content/part-01/ch.md');
  });
});
