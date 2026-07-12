import { expect, test, describe } from 'bun:test';
import {
  detectBookRoots,
  parseManifest,
  resolveEntityTypes,
  buildEntityIndex,
  buildEntitySkeleton,
  humanizeFilename,
  type RawEntityFile
} from './book-model';

describe('detectBookRoots', () => {
  test('detects a vault-root book', () => {
    expect(detectBookRoots(['manifest.yaml'])).toEqual(['']);
  });
  test('detects first-level subfolder books', () => {
    expect(detectBookRoots(['book-a/manifest.yaml', 'book-b/manifest.yaml'])).toEqual(['book-a', 'book-b']);
  });
  test('ignores deep manifests', () => {
    expect(detectBookRoots(['book/content/manifest.yaml'])).toEqual([]);
  });
  test('vault root sorts first, then alphabetical, de-duplicated', () => {
    expect(detectBookRoots(['z/manifest.yaml', 'manifest.yaml', 'a/manifest.yaml', 'a/manifest.yaml']))
      .toEqual(['', 'a', 'z']);
  });
});

describe('parseManifest', () => {
  const yaml = `version: 1
content:
  - path: content/chapter-01.md
    title: Chapter 1 — The Field
  - path: content/part-01
    title: Part One
    children:
      - path: content/part-01/chapter-02.md
        title: Chapter 2
  - path: content/notes.md
`;

  test('parses ordered chapters with titles and nested children', () => {
    const nodes = parseManifest(yaml);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({ title: 'Chapter 1 — The Field', path: 'content/chapter-01.md' });
    expect(nodes[1].children?.[0]).toMatchObject({ title: 'Chapter 2', path: 'content/part-01/chapter-02.md' });
  });

  test('falls back to a humanised filename when title is missing', () => {
    expect(parseManifest(yaml)[2].title).toBe('Notes');
  });

  test('returns [] for malformed or empty input', () => {
    expect(parseManifest('')).toEqual([]);
    expect(parseManifest(': : bad')).toEqual([]);
    expect(parseManifest('version: 1')).toEqual([]);
  });

  test('skips entries with no path', () => {
    expect(parseManifest('content:\n  - title: orphan\n')).toEqual([]);
  });
});

describe('humanizeFilename', () => {
  test('drops extension, splits separators, capitalises', () => {
    expect(humanizeFilename('content/part-01/chapter-two.md')).toBe('Chapter two');
    expect(humanizeFilename('notes_draft.md')).toBe('Notes draft');
  });
});

describe('resolveEntityTypes', () => {
  test('built-ins only when no types.yaml', () => {
    const { types, problems } = resolveEntityTypes(undefined);
    expect(problems).toHaveLength(0);
    expect(types.map(t => t.id)).toEqual(['character', 'term', 'artifact', 'location']);
    expect(types.every(t => t.origin === 'built-in')).toBe(true);
  });

  test('appends a valid author type', () => {
    const { types, problems } = resolveEntityTypes('types:\n  - id: sloka\n    label: Шлока\n');
    expect(problems).toHaveLength(0);
    const sloka = types.find(t => t.id === 'sloka');
    expect(sloka).toMatchObject({ tagKind: 'sloka', directory: 'sloka', origin: 'book' });
  });

  test('reports a problem for an author type shadowing a built-in', () => {
    const { problems } = resolveEntityTypes('types:\n  - id: character\n    label: Nope\n');
    expect(problems.some(p => p.code === 'reserved-id')).toBe(true);
  });
});

describe('buildEntityIndex', () => {
  const { types } = resolveEntityTypes('types:\n  - id: sloka\n    label: Шлока\n');
  const files: RawEntityFile[] = [
    { path: 'entities/characters/krishna.yaml', directory: 'characters', text: 'id: krishna\nname: Krishna\naliases:\n  - Govinda\nepithets:\n  - Slayer of Madhu\n' },
    { path: 'entities/terms/dharma.yaml', directory: 'terms', text: 'id: dharma\nterm: dharma\n' },
    { path: 'entities/sloka/bg-2-47.yaml', directory: 'sloka', text: 'id: bg-2-47\nname: Право на действие (2.47)\n' },
    { path: 'entities/unknown/x.yaml', directory: 'unknown', text: 'id: x\n' }
  ];

  test('indexes cards by directory, using the type label field', () => {
    const index = buildEntityIndex(files, types);
    expect(index.map(e => e.id).sort()).toEqual(['bg-2-47', 'dharma', 'krishna']);
    const krishna = index.find(e => e.id === 'krishna')!;
    expect(krishna).toMatchObject({ kind: 'character', tagKind: 'char', label: 'Krishna' });
    expect(krishna.aliases).toEqual(['Govinda', 'Slayer of Madhu']);
  });

  test('term uses its `term` label field', () => {
    const term = buildEntityIndex(files, types).find(e => e.id === 'dharma')!;
    expect(term.label).toBe('dharma');
  });

  test('author type indexes identically to a built-in', () => {
    const sloka = buildEntityIndex(files, types).find(e => e.id === 'bg-2-47')!;
    expect(sloka).toMatchObject({ kind: 'sloka', tagKind: 'sloka', label: 'Право на действие (2.47)' });
  });

  test('skips cards under an unknown directory', () => {
    expect(buildEntityIndex(files, types).some(e => e.id === 'x')).toBe(false);
  });

  test('falls back to filename stem when id is missing', () => {
    const index = buildEntityIndex([{ path: 'entities/characters/nameless.yaml', directory: 'characters', text: 'name: Anon\n' }], types);
    expect(index[0].id).toBe('nameless');
  });
});

describe('buildEntitySkeleton', () => {
  const { types } = resolveEntityTypes(undefined);
  const character = types.find(t => t.id === 'character')!;

  test('seeds id and label, list fields empty', () => {
    const yaml = buildEntitySkeleton(character, 'shiva', 'Shiva');
    expect(yaml).toContain('id: shiva');
    expect(yaml).toContain('name: Shiva');
    expect(yaml).toContain('aliases: []');
  });

  test('quotes a scalar that needs quoting', () => {
    const yaml = buildEntitySkeleton(character, 'bg-2-47', 'Verse: 2.47');
    expect(yaml).toContain("name: 'Verse: 2.47'");
  });
});
