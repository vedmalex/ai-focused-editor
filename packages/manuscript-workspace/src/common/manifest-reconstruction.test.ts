import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { flattenManifestRows } from './book-config-forms';
import {
  appendEntriesToManifest,
  buildManifestYaml,
  extractFirstHeading,
  humanizeName,
  isDiscoverableManuscriptPath,
  reconstructManifestEntries,
  type DiscoveredManuscriptFile
} from './manifest-reconstruction';

function files(...paths: Array<string | DiscoveredManuscriptFile>): DiscoveredManuscriptFile[] {
  return paths.map(entry => (typeof entry === 'string' ? { path: entry } : entry));
}

describe('extractFirstHeading', () => {
  test('returns the first ATX heading text', () => {
    expect(extractFirstHeading('\nsome intro\n# The Real Title\n## Later\n')).toBe('The Real Title');
  });

  test('strips closing hashes and leading indentation', () => {
    expect(extractFirstHeading('   ## Boxed Title ##\n')).toBe('Boxed Title');
  });

  test('is undefined when there is no heading', () => {
    expect(extractFirstHeading('just a paragraph\nno headings here\n')).toBeUndefined();
  });

  test('ignores a bare hash with no space (not an ATX heading)', () => {
    expect(extractFirstHeading('#nospace\n# Yes Space\n')).toBe('Yes Space');
  });
});

describe('humanizeName', () => {
  test('strips a numeric ordering prefix and title-cases', () => {
    expect(humanizeName('02-part-one')).toBe('Part One');
    expect(humanizeName('01-introduction')).toBe('Introduction');
    expect(humanizeName('3. chapter_three')).toBe('Chapter Three');
  });

  test('handles a name without a numeric prefix', () => {
    expect(humanizeName('part-01')).toBe('Part 01');
    expect(humanizeName('chapter-two')).toBe('Chapter Two');
  });

  test('keeps digits when the whole name is a numeric prefix', () => {
    expect(humanizeName('01')).toBe('01');
  });
});

describe('isDiscoverableManuscriptPath', () => {
  test('accepts markdown at the root and under content/ and arbitrary folders', () => {
    expect(isDiscoverableManuscriptPath('intro.md')).toBe(true);
    expect(isDiscoverableManuscriptPath('content/chapter-01.md')).toBe(true);
    expect(isDiscoverableManuscriptPath('drafts/scene.md')).toBe(true);
  });

  test('rejects excluded and hidden directories, and non-markdown', () => {
    expect(isDiscoverableManuscriptPath('build/out.md')).toBe(false);
    expect(isDiscoverableManuscriptPath('knowledge/plans/roadmap.md')).toBe(false);
    expect(isDiscoverableManuscriptPath('.prompts/skills/x/SKILL.md')).toBe(false);
    expect(isDiscoverableManuscriptPath('.hidden/note.md')).toBe(false);
    expect(isDiscoverableManuscriptPath('content/cover.png')).toBe(false);
  });
});

describe('reconstructManifestEntries', () => {
  test('content/ is a transparent root; files become top-level chapters', () => {
    const entries = reconstructManifestEntries(
      files(
        { path: 'content/chapter-01.md', firstHeading: 'The Field of Decision' },
        'content/notes-draft.md'
      )
    );
    expect(entries).toEqual([
      { path: 'content/chapter-01.md', title: 'The Field of Decision' },
      { path: 'content/notes-draft.md', title: 'Notes Draft' }
    ]);
  });

  test('directories become parts and nested dirs nest', () => {
    const entries = reconstructManifestEntries(
      files('content/part-01/chapter-02.md', 'content/part-01/sub/deep.md')
    );
    // Siblings natural-sort by base name: `chapter-02` < `sub`.
    expect(entries).toEqual([
      {
        path: 'content/part-01',
        title: 'Part 01',
        children: [
          { path: 'content/part-01/chapter-02.md', title: 'Chapter 02' },
          {
            path: 'content/part-01/sub',
            title: 'Sub',
            children: [{ path: 'content/part-01/sub/deep.md', title: 'Deep' }]
          }
        ]
      }
    ]);
  });

  test('an old folder with chapters at the root and in arbitrary folders is picked up', () => {
    const entries = reconstructManifestEntries(files('intro.md', 'drafts/scene.md'));
    expect(entries).toEqual([
      { path: 'drafts', title: 'Drafts', children: [{ path: 'drafts/scene.md', title: 'Scene' }] },
      { path: 'intro.md', title: 'Intro' }
    ]);
  });

  test('numeric prefixes sort first and naturally (2 < 10), then lexicographic', () => {
    const entries = reconstructManifestEntries(
      files(
        'content/10-ten.md',
        'content/2-two.md',
        'content/beta.md',
        'content/alpha.md'
      )
    );
    expect(entries.map(entry => entry.path)).toEqual([
      'content/2-two.md',
      'content/10-ten.md',
      'content/alpha.md',
      'content/beta.md'
    ]);
  });

  test('first heading wins over the humanized filename for the title', () => {
    const entries = reconstructManifestEntries(
      files({ path: 'content/01-start.md', firstHeading: 'Chapter One: A Beginning' })
    );
    expect(entries[0].title).toBe('Chapter One: A Beginning');
  });

  test('ignores non-markdown and duplicate paths', () => {
    const entries = reconstructManifestEntries(
      files('content/a.md', 'content/a.md', 'content/cover.png')
    );
    expect(entries.map(entry => entry.path)).toEqual(['content/a.md']);
  });

  test('output round-trips through the manifest reader (flattenManifestRows)', () => {
    const entries = reconstructManifestEntries(
      files('content/chapter-01.md', 'content/part-01/chapter-02.md')
    );
    const rows = flattenManifestRows(parse(buildManifestYaml(entries)));
    expect(rows.map(row => ({ path: row.path, hasChildren: row.hasChildren, depth: row.depth }))).toEqual([
      { path: 'content/chapter-01.md', hasChildren: false, depth: 0 },
      { path: 'content/part-01', hasChildren: true, depth: 0 },
      { path: 'content/part-01/chapter-02.md', hasChildren: false, depth: 1 }
    ]);
  });
});

describe('buildManifestYaml', () => {
  test('matches the on-disk manifest schema shape', () => {
    const yaml = buildManifestYaml([
      { path: 'content/chapter-01.md', title: 'Chapter 1 — The Field of Decision' },
      {
        path: 'content/part-01',
        title: 'Part One',
        children: [{ path: 'content/part-01/chapter-02.md', title: 'Chapter 2' }]
      }
    ]);
    expect(yaml).toBe(
      'version: 1\n' +
        'content:\n' +
        '  - path: content/chapter-01.md\n' +
        '    title: Chapter 1 — The Field of Decision\n' +
        '  - path: content/part-01\n' +
        '    title: Part One\n' +
        '    children:\n' +
        '      - path: content/part-01/chapter-02.md\n' +
        '        title: Chapter 2\n'
    );
  });

  test('quotes titles that need it (colon) so they round-trip', () => {
    const yaml = buildManifestYaml([{ path: 'content/a.md', title: 'Ch 2: Begins' }]);
    expect(flattenManifestRows(parse(yaml))[0].title).toBe('Ch 2: Begins');
  });
});

describe('appendEntriesToManifest', () => {
  const existing =
    'version: 1\n' +
    'content:\n' +
    '  # keep this comment\n' +
    '  - path: content/chapter-01.md\n' +
    '    title: Intro\n' +
    '  - path: content/part-01\n' +
    '    title: Part One\n' +
    '    children:\n' +
    '      - path: content/part-01/chapter-02.md\n' +
    '        title: Two\n';

  test('appends a new part at the end of content and preserves comments', () => {
    const merged = appendEntriesToManifest(existing, [
      {
        path: 'content/part-02',
        title: 'Part Two',
        children: [{ path: 'content/part-02/chapter-09.md', title: 'Nine' }]
      }
    ]);
    expect(merged).toContain('# keep this comment');
    const rows = flattenManifestRows(parse(merged));
    expect(rows.map(row => row.path)).toEqual([
      'content/chapter-01.md',
      'content/part-01',
      'content/part-01/chapter-02.md',
      'content/part-02',
      'content/part-02/chapter-09.md'
    ]);
  });

  test('a new chapter lands at the END of its existing parent part', () => {
    const merged = appendEntriesToManifest(existing, [
      {
        path: 'content/part-01',
        title: 'Part One',
        children: [{ path: 'content/part-01/chapter-03.md', title: 'Three' }]
      }
    ]);
    const rows = flattenManifestRows(parse(merged));
    const partOneChildren = rows.filter(row => row.parentPath === 'content/part-01').map(row => row.path);
    expect(partOneChildren).toEqual([
      'content/part-01/chapter-02.md',
      'content/part-01/chapter-03.md'
    ]);
    // The existing part is not duplicated.
    expect(rows.filter(row => row.path === 'content/part-01')).toHaveLength(1);
  });

  test('a chapter already present is not duplicated', () => {
    const merged = appendEntriesToManifest(existing, [
      { path: 'content/chapter-01.md', title: 'Intro (rediscovered)' }
    ]);
    const rows = flattenManifestRows(parse(merged));
    expect(rows.filter(row => row.path === 'content/chapter-01.md')).toHaveLength(1);
    // The existing title is left untouched (never overwritten).
    expect(rows.find(row => row.path === 'content/chapter-01.md')?.title).toBe('Intro');
  });

  test('seeds a content list when the manifest has none', () => {
    const merged = appendEntriesToManifest('version: 1\n', [
      { path: 'content/a.md', title: 'A' }
    ]);
    expect(flattenManifestRows(parse(merged)).map(row => row.path)).toEqual(['content/a.md']);
  });
});
