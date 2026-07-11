import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import {
  extractMetadataFields,
  flattenManifestRows
} from './book-config-forms';
import {
  DEFAULT_BOOK_LANGUAGE,
  DEFAULT_FIRST_CHAPTER_TITLE,
  bookScaffoldEntries,
  buildChapterMarkdown,
  isNewBookOnlyEntry,
  missingScaffoldEntries,
  slugifyBookFolderName,
  type BookScaffoldEntry
} from './book-scaffold';

/** Parent folder path of a workspace-relative path, or '' for a root-level entry. */
function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** The exact, ordered list of paths the scaffold is expected to produce. */
const EXPECTED_PATHS = [
  'manifest.yaml',
  'metadata.yaml',
  'content',
  'content/chapter-01.md',
  'entities',
  'entities/characters',
  'entities/terms',
  'entities/artifacts',
  'entities/locations',
  'sources',
  'sources/citations.yaml',
  'sources/excerpts.jsonl',
  'knowledge',
  'knowledge/plans',
  'knowledge/questions',
  'knowledge/summaries',
  'ai',
  'ai/prompts',
  'ai/prompts/custom-modes.yaml',
  '.prompts',
  '.prompts/skills',
  '.prompts/skills/style-guide',
  '.prompts/skills/style-guide/SKILL.md'
];

describe('bookScaffoldEntries — structure', () => {
  test('returns the canonical path list, in order, for the no-options (doctor) call', () => {
    const paths = bookScaffoldEntries().map(entry => entry.path);
    expect(paths).toEqual(EXPECTED_PATHS);
  });

  test('the path list is identical whether or not options are given', () => {
    const withOptions = bookScaffoldEntries({ title: 'My Book' }).map(entry => entry.path);
    expect(withOptions).toEqual(EXPECTED_PATHS);
  });

  test('paths are workspace-relative: forward slashes, no leading ./, no trailing slash', () => {
    for (const entry of bookScaffoldEntries()) {
      expect(entry.path.startsWith('./')).toBe(false);
      expect(entry.path.startsWith('/')).toBe(false);
      expect(entry.path.includes('\\')).toBe(false);
      expect(entry.path.endsWith('/')).toBe(false);
    }
  });

  test('every parent folder precedes its children (sequential creation is safe)', () => {
    const entries = bookScaffoldEntries();
    const indexByPath = new Map(entries.map((entry, index) => [entry.path, index]));
    entries.forEach((entry, childIndex) => {
      const parent = parentPath(entry.path);
      if (parent && indexByPath.has(parent)) {
        expect(indexByPath.get(parent)!).toBeLessThan(childIndex);
      }
    });
  });

  test('every non-root child has a folder parent present in the scaffold', () => {
    const byPath = new Map(bookScaffoldEntries().map(entry => [entry.path, entry]));
    for (const entry of byPath.values()) {
      const parent = parentPath(entry.path);
      if (parent) {
        const parentEntry = byPath.get(parent);
        expect(parentEntry).toBeDefined();
        expect(parentEntry!.kind).toBe('folder');
      }
    }
  });
});

describe('bookScaffoldEntries — kind/level/seed invariants', () => {
  const entries = bookScaffoldEntries({ title: 'My Book' });
  const byPath = new Map(entries.map(entry => [entry.path, entry]));

  test('folders never carry a seed; files always do', () => {
    for (const entry of entries) {
      if (entry.kind === 'folder') {
        expect(entry.seed).toBeUndefined();
      } else {
        expect(typeof entry.seed).toBe('string');
      }
    }
  });

  test('every entry has a non-empty English description', () => {
    for (const entry of entries) {
      expect(entry.description.trim().length).toBeGreaterThan(0);
    }
  });

  test('required entries are exactly the config files, content/, entities/*, and sources/', () => {
    const required = entries.filter(entry => entry.level === 'required').map(entry => entry.path);
    expect(required).toEqual([
      'manifest.yaml',
      'metadata.yaml',
      'content',
      'entities',
      'entities/characters',
      'entities/terms',
      'entities/artifacts',
      'entities/locations',
      'sources'
    ]);
  });

  test('recommended entries are the starter chapter, source files, knowledge/*, and ai/*', () => {
    const recommended = entries.filter(entry => entry.level === 'recommended').map(entry => entry.path);
    expect(recommended).toEqual([
      'content/chapter-01.md',
      'sources/citations.yaml',
      'sources/excerpts.jsonl',
      'knowledge',
      'knowledge/plans',
      'knowledge/questions',
      'knowledge/summaries',
      'ai',
      'ai/prompts',
      'ai/prompts/custom-modes.yaml',
      '.prompts',
      '.prompts/skills',
      '.prompts/skills/style-guide',
      '.prompts/skills/style-guide/SKILL.md'
    ]);
  });

  test('required and recommended partition every entry', () => {
    const levels = new Set(entries.map(entry => entry.level));
    expect([...levels].sort()).toEqual(['recommended', 'required']);
    const requiredCount = entries.filter(entry => entry.level === 'required').length;
    const recommendedCount = entries.filter(entry => entry.level === 'recommended').length;
    expect(requiredCount + recommendedCount).toBe(entries.length);
  });

  test('excerpts.jsonl seeds to an empty string, not undefined', () => {
    expect(byPath.get('sources/excerpts.jsonl')!.seed).toBe('');
  });
});

describe('metadata.yaml seed', () => {
  test('carries title/author/language from options and parses cleanly', () => {
    const entries = bookScaffoldEntries({ title: 'Sample Book', author: 'A. Author', language: 'en' });
    const seed = entries.find(entry => entry.path === 'metadata.yaml')!.seed!;
    const parsed = parse(seed) as Record<string, unknown>;
    expect(parsed).toEqual({ title: 'Sample Book', author: 'A. Author', language: 'en' });
    // Readable by the metadata form editor.
    const fields = extractMetadataFields(parsed);
    expect(fields.title).toBe('Sample Book');
    expect(fields.author).toBe('A. Author');
    expect(fields.language).toBe('en');
  });

  test('always contains title/author/language keys even with no options', () => {
    const seed = bookScaffoldEntries().find(entry => entry.path === 'metadata.yaml')!.seed!;
    const parsed = parse(seed) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['author', 'language', 'title']);
    expect(parsed.language).toBe(DEFAULT_BOOK_LANGUAGE);
  });

  test('defaults language to ru and leaves author empty when omitted', () => {
    const seed = bookScaffoldEntries({ title: 'My Book' }).find(entry => entry.path === 'metadata.yaml')!.seed!;
    const parsed = parse(seed) as Record<string, unknown>;
    expect(parsed.title).toBe('My Book');
    expect(parsed.language).toBe('ru');
    expect(parsed.author).toBe('');
  });

  test('safely quotes titles/authors with apostrophes, quotes, and colons', () => {
    const tricky = `O'Brien's: "Great" Book`;
    const seed = bookScaffoldEntries({ title: tricky, author: "It's Me: \"X\"" }).find(
      entry => entry.path === 'metadata.yaml'
    )!.seed!;
    const parsed = parse(seed) as Record<string, unknown>;
    expect(parsed.title).toBe(tricky);
    expect(parsed.author).toBe("It's Me: \"X\"");
  });

  test('preserves a Cyrillic title verbatim', () => {
    const seed = bookScaffoldEntries({ title: 'Война и мир', author: 'Лев Толстой', language: 'ru' }).find(
      entry => entry.path === 'metadata.yaml'
    )!.seed!;
    const parsed = parse(seed) as Record<string, unknown>;
    expect(parsed.title).toBe('Война и мир');
    expect(parsed.author).toBe('Лев Толстой');
  });
});

describe('manifest.yaml seed', () => {
  test('no options => empty content, readable by flattenManifestRows', () => {
    const seed = bookScaffoldEntries().find(entry => entry.path === 'manifest.yaml')!.seed!;
    expect(seed).toBe('version: 1\ncontent: []\n');
    const parsed = parse(seed);
    expect(flattenManifestRows(parsed)).toEqual([]);
  });

  test('with options => lists content/chapter-01.md with the first chapter title', () => {
    const seed = bookScaffoldEntries({ title: 'My Book', firstChapterTitle: 'The Beginning' }).find(
      entry => entry.path === 'manifest.yaml'
    )!.seed!;
    const parsed = parse(seed) as { version: number; content: unknown[] };
    expect(parsed.version).toBe(1);
    const rows = flattenManifestRows(parsed);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('content/chapter-01.md');
    expect(rows[0].title).toBe('The Beginning');
    expect(rows[0].include).toBe(true);
    expect(rows[0].depth).toBe(0);
  });

  test('defaults the first chapter title when only a title is given', () => {
    const seed = bookScaffoldEntries({ title: 'My Book' }).find(entry => entry.path === 'manifest.yaml')!.seed!;
    const rows = flattenManifestRows(parse(seed));
    expect(rows[0].title).toBe(DEFAULT_FIRST_CHAPTER_TITLE);
  });

  test('safely quotes a first chapter title with a colon and apostrophe', () => {
    const seed = bookScaffoldEntries({ title: 'My Book', firstChapterTitle: "Ch. 1: A Hero's Start" }).find(
      entry => entry.path === 'manifest.yaml'
    )!.seed!;
    const rows = flattenManifestRows(parse(seed));
    expect(rows[0].title).toBe("Ch. 1: A Hero's Start");
  });

  test('supports a Cyrillic first chapter title', () => {
    const seed = bookScaffoldEntries({ title: 'Моя книга', firstChapterTitle: 'Глава первая' }).find(
      entry => entry.path === 'manifest.yaml'
    )!.seed!;
    const rows = flattenManifestRows(parse(seed));
    expect(rows[0].title).toBe('Глава первая');
  });
});

describe('config seeds parse into the expected shapes', () => {
  test('sources/citations.yaml is an empty citation registry', () => {
    const seed = bookScaffoldEntries().find(entry => entry.path === 'sources/citations.yaml')!.seed!;
    expect(parse(seed)).toEqual({ version: 1, citations: [] });
  });

  test('ai/prompts/custom-modes.yaml is an empty mode registry', () => {
    const seed = bookScaffoldEntries().find(entry => entry.path === 'ai/prompts/custom-modes.yaml')!.seed!;
    expect(parse(seed)).toEqual({ version: 1, modes: [] });
  });

  test('content/chapter-01.md seeds the chapter markdown for the resolved title', () => {
    const seed = bookScaffoldEntries({ title: 'My Book', firstChapterTitle: 'Dawn' }).find(
      entry => entry.path === 'content/chapter-01.md'
    )!.seed!;
    expect(seed).toBe('# Dawn\n\n');
  });
});

describe('missingScaffoldEntries', () => {
  test('returns every entry when nothing exists', () => {
    const entries = bookScaffoldEntries();
    const missing = missingScaffoldEntries(entries, () => false);
    expect(missing).toEqual(entries);
  });

  test('returns nothing when everything exists', () => {
    const entries = bookScaffoldEntries();
    expect(missingScaffoldEntries(entries, () => true)).toEqual([]);
  });

  test('filters out only the paths that exist, preserving order', () => {
    const entries = bookScaffoldEntries();
    const present = new Set(['manifest.yaml', 'metadata.yaml', 'content', 'entities', 'entities/characters']);
    const missing = missingScaffoldEntries(entries, path => present.has(path));
    const missingPaths = missing.map(entry => entry.path);
    expect(missingPaths).not.toContain('manifest.yaml');
    expect(missingPaths).not.toContain('entities/characters');
    expect(missingPaths).toContain('sources');
    expect(missingPaths).toContain('content/chapter-01.md');
    // Order is a subsequence of the full ordered list.
    const fullOrder = entries.map(entry => entry.path);
    let cursor = -1;
    for (const path of missingPaths) {
      const at = fullOrder.indexOf(path);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test('models the doctor skipping the starter chapter when content/ has other files', () => {
    const entries = bookScaffoldEntries();
    // Everything present except we pretend content/chapter-01.md is absent but
    // content/ holds other chapters — the doctor filters new-book-only entries.
    const present = new Set(entries.map(entry => entry.path));
    present.delete('content/chapter-01.md');
    const missing = missingScaffoldEntries(entries, path => present.has(path)).filter(
      entry => !isNewBookOnlyEntry(entry)
    );
    expect(missing).toEqual([]);
  });
});

describe('isNewBookOnlyEntry', () => {
  test('true only for content/chapter-01.md', () => {
    const entries = bookScaffoldEntries();
    const flagged = entries.filter(isNewBookOnlyEntry).map(entry => entry.path);
    expect(flagged).toEqual(['content/chapter-01.md']);
  });

  test('false for an arbitrary non-scaffold entry', () => {
    const fake: BookScaffoldEntry = {
      path: 'content/chapter-02.md',
      kind: 'file',
      level: 'recommended',
      description: 'x'
    };
    expect(isNewBookOnlyEntry(fake)).toBe(false);
  });
});

describe('slugifyBookFolderName', () => {
  test('slugs an ASCII title to dash-separated lowercase', () => {
    expect(slugifyBookFolderName('My Great Book')).toBe('my-great-book');
  });

  test('transliterates a Cyrillic-only title instead of falling back to a hash', () => {
    expect(slugifyBookFolderName('Война и мир')).toBe('voina-i-mir');
  });

  test('falls back to a book-prefixed hash for a CJK-only title', () => {
    expect(slugifyBookFolderName('紅樓夢')).toMatch(/^book-[0-9a-z]+$/);
  });

  test('is deterministic for the same title', () => {
    expect(slugifyBookFolderName('Война и мир')).toBe(slugifyBookFolderName('Война и мир'));
  });
});

describe('buildChapterMarkdown', () => {
  test('renders an H1 title followed by a blank line', () => {
    expect(buildChapterMarkdown('Chapter One')).toBe('# Chapter One\n\n');
  });
});
