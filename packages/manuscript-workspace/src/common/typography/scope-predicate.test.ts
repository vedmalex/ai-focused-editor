import { describe, expect, test } from 'bun:test';
import { flattenManifestRows } from '../book-config-forms';
import { isChapterProse, isMarkdownProse, manifestChapterBasenames } from './scope-predicate';

describe('isChapterProse (chapters scope)', () => {
  test('a content chapter with front-matter type: chapter is included', () => {
    expect(isChapterProse('/book/content/chapter-01.md', { frontMatterType: 'chapter' })).toBe(true);
  });

  test('a content note WITHOUT type: chapter is excluded (ISS-222 class)', () => {
    expect(isChapterProse('/book/content/notes.md', {})).toBe(false);
  });

  test('a manifest-listed basename is included even without front matter', () => {
    expect(isChapterProse('/book/content/intro.md', { manifestBasenames: ['intro.md', 'chapter-01.md'] })).toBe(true);
  });

  test('README.md with no chapter signal is excluded', () => {
    expect(isChapterProse('/book/README.md', {})).toBe(false);
  });

  test('an entity yaml is excluded (not markdown)', () => {
    expect(isChapterProse('/book/entities/characters/frodo.yaml', { frontMatterType: 'chapter' })).toBe(false);
  });

  test('a transcription raw.md is excluded even with a chapter type', () => {
    expect(isChapterProse('/book/transcription/talk-01/raw.md', { frontMatterType: 'chapter' })).toBe(false);
  });

  test('front-matter type is matched case-insensitively and trimmed', () => {
    expect(isChapterProse('/book/content/ch.md', { frontMatterType: '  Chapter ' })).toBe(true);
  });

  test('being under content/ is not by itself sufficient', () => {
    expect(isChapterProse('/book/content/scratch.md', {})).toBe(false);
  });
});

describe('manifestChapterBasenames (DEFECT-1: manifest membership resolution)', () => {
  test('extracts markdown basenames from flattened manifest paths, dropping folders', () => {
    const paths = [
      'content/chapter-01.md',
      'content/part-01',
      'content/part-01/chapter-02.md',
      'content/part-01/chapter-03.md',
      'content/notes-draft.md'
    ];
    expect(manifestChapterBasenames(paths).sort()).toEqual(
      ['chapter-01.md', 'chapter-02.md', 'chapter-03.md', 'notes-draft.md']
    );
  });

  test('non-markdown manifest entries are dropped', () => {
    expect(manifestChapterBasenames(['content/cover.png', 'content/chapter.md'])).toEqual(['chapter.md']);
  });

  test('.markdown extension is accepted', () => {
    expect(manifestChapterBasenames(['content/preface.markdown'])).toEqual(['preface.markdown']);
  });

  // The core DEFECT-1 regression: a manifest-listed chapter with NO
  // `type: chapter` front matter (the examples/sample-book layout) must still be
  // in the `chapters` scope once the manifest is resolved. Before the fix the
  // seam passed only `frontMatterType`, so a real chapter matched nothing.
  test('a manifest member without front matter resolves to a chapter (sample-book #38 blocker)', () => {
    const sampleBookManifest = {
      version: 1,
      content: [
        { path: 'content/chapter-01.md', title: 'Chapter 1 — The Field of Decision' },
        {
          path: 'content/part-01',
          title: 'Part One — The Dialogue',
          children: [
            { path: 'content/part-01/chapter-02.md', title: 'Chapter 2 — The Teaching Begins' },
            { path: 'content/part-01/chapter-03.md', title: 'Chapter 3 — The Bow Is Raised Again' }
          ]
        },
        { path: 'content/notes-draft.md', title: 'Draft Notes' }
      ]
    };
    const manifestBasenames = manifestChapterBasenames(
      flattenManifestRows(sampleBookManifest).map(row => row.path)
    );

    // chapter-01.md has NO front matter (starts with a plain `# ` heading).
    expect(isChapterProse('/book/content/chapter-01.md', { manifestBasenames })).toBe(true);
    expect(isChapterProse('/book/content/part-01/chapter-02.md', { manifestBasenames })).toBe(true);
    // A markdown file that is NOT in the manifest is still excluded.
    expect(isChapterProse('/book/content/stray.md', { manifestBasenames })).toBe(false);
  });
});

describe('isMarkdownProse (all-md scope)', () => {
  test('any markdown file is prose', () => {
    expect(isMarkdownProse('/book/content/notes.md')).toBe(true);
    expect(isMarkdownProse('/book/README.md')).toBe(true);
    expect(isMarkdownProse('/anywhere/draft.markdown')).toBe(true);
  });

  test('a non-markdown file is not prose', () => {
    expect(isMarkdownProse('/book/entities/x.yaml')).toBe(false);
    expect(isMarkdownProse('/book/cover.png')).toBe(false);
  });

  test('a transcription raw.md sidecar is excluded', () => {
    expect(isMarkdownProse('/book/transcription/talk-01/raw.md')).toBe(false);
  });
});
