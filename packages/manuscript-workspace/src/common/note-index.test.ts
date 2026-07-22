import { describe, expect, test } from 'bun:test';
import { buildNoteIndex, extractNoteTitle, registerNoteTitle } from './note-index';
import { resolveNoteLink } from './link-navigation';

// Exactly what `@theia/file-search`'s `FileSearchService.find` returns:
// `FileUri.create(...).toString()` percent-encodes every non-ASCII byte and the
// space (ISS-148). Cyrillic `Замысел романа.md` -> the string below.
const ENC_ZAMYSEL = 'file:///Users/x/vault/Notes/%D0%97%D0%B0%D0%BC%D1%8B%D1%81%D0%B5%D0%BB%20%D1%80%D0%BE%D0%BC%D0%B0%D0%BD%D0%B0.md';
const ENC_DUP_A = 'file:///Users/x/vault/a/%D0%94%D1%83%D0%B1%D0%BB%D0%B8%D0%BA%D0%B0%D1%82.md'; // a/Дубликат.md
const ENC_DUP_B = 'file:///Users/x/vault/b/%D0%94%D1%83%D0%B1%D0%BB%D0%B8%D0%BA%D0%B0%D1%82.md'; // b/Дубликат.md

describe('buildNoteIndex — percent-encoded FileSearchService URIs (ISS-148)', () => {
  test('decodes the Cyrillic basename for BOTH the lookup key and the display basename', () => {
    const index = buildNoteIndex([ENC_ZAMYSEL]);
    // Display basename is human-readable (the autocomplete label), NOT `%D0%97...`.
    expect(index.entries[0]?.basename).toBe('Замысел романа');
    // Lookup key is the decoded, lowercased name the resolver searches by.
    expect(index.byBasename.has('замысел романа')).toBe(true);
    expect([...index.byBasename.keys()]).not.toContain('%d0%97%d0%b0%d0%bc%d1%8b%d1%81%d0%b5%d0%bb%20%d1%80%d0%be%d0%bc%d0%b0%d0%bd%d0%b0');
    // The stored path VALUE is left in its original (encoded) form — consumers
    // pass the equally-encoded `editor.uri.toString()`, keeping the tie-break
    // like-for-like.
    expect(index.byBasename.get('замысел романа')).toEqual([ENC_ZAMYSEL]);
  });

  test('resolveNoteLink finds a Cyrillic note by the name the author typed (the shipped-broken path)', () => {
    const index = buildNoteIndex([ENC_ZAMYSEL]);
    const documentUri = 'file:///Users/x/vault/chapters/ch1.md'; // encoded form, as editor.uri.toString()
    const resolved = resolveNoteLink('замысел романа', documentUri, index.byBasename, index.titleIndex);
    expect(resolved).toEqual({ path: ENC_ZAMYSEL });
  });

  test('tie-break over encoded duplicate paths still picks the closest (decoded key, encoded distance)', () => {
    const index = buildNoteIndex([ENC_DUP_A, ENC_DUP_B]);
    // A chapter under a/ resolves the duplicate to a/ (closest), not an ambiguity.
    const fromA = resolveNoteLink('Дубликат', 'file:///Users/x/vault/a/ch.md', index.byBasename, index.titleIndex);
    expect(fromA).toEqual({ path: ENC_DUP_A });
    const fromB = resolveNoteLink('дубликат', 'file:///Users/x/vault/b/ch.md', index.byBasename, index.titleIndex);
    expect(fromB).toEqual({ path: ENC_DUP_B });
  });

  test('ASCII notes keep working (encoding is a no-op) — regression guard', () => {
    const index = buildNoteIndex(['file:///Users/x/vault/notes/Ascii Note.md']);
    expect(index.entries[0]?.basename).toBe('Ascii Note');
    expect(resolveNoteLink('ascii note', 'file:///Users/x/vault/ch.md', index.byBasename)).toEqual({
      path: 'file:///Users/x/vault/notes/Ascii Note.md'
    });
  });

  test('a basename with a literal `%` that is not valid percent-encoding is left verbatim (no throw)', () => {
    const index = buildNoteIndex(['file:///vault/100%25 done.md', 'file:///vault/bad%ZZname.md']);
    // `%25` is valid -> decodes to `%`; `%ZZ` is malformed -> kept verbatim.
    expect(index.entries.map(e => e.basename)).toEqual(['100% done', 'bad%ZZname']);
  });
});

describe('buildNoteIndex', () => {
  test('indexes markdown files, lowercasing the basename key', () => {
    const index = buildNoteIndex(['file:///vault/Notes/My Note.md']);
    expect(index.entries).toEqual([{ path: 'file:///vault/Notes/My Note.md', basename: 'My Note' }]);
    expect(index.byBasename.get('my note')).toEqual(['file:///vault/Notes/My Note.md']);
    // The exact-case key is never populated — only the lowercased one.
    expect(index.byBasename.has('My Note')).toBe(false);
  });

  test('a basename shared by two files collects both paths, in encounter order', () => {
    const index = buildNoteIndex([
      'file:///vault/a/Duplicate.md',
      'file:///vault/b/duplicate.md'
    ]);
    expect(index.byBasename.get('duplicate')).toEqual([
      'file:///vault/a/Duplicate.md',
      'file:///vault/b/duplicate.md'
    ]);
    expect(index.entries).toHaveLength(2);
  });

  test('non-markdown and blank entries are filtered out', () => {
    const index = buildNoteIndex([
      'file:///vault/image.png',
      '',
      '   ',
      'file:///vault/notes/Real Note.md'
    ]);
    expect(index.entries).toEqual([{ path: 'file:///vault/notes/Real Note.md', basename: 'Real Note' }]);
  });

  test('non-string entries are ignored defensively', () => {
    const index = buildNoteIndex([undefined as unknown as string, 'file:///vault/Note.md']);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.basename).toBe('Note');
  });

  test('handles backslash path separators the same as forward slashes', () => {
    const index = buildNoteIndex(['file:///C:\\vault\\Chapter One.md']);
    expect(index.entries[0]?.basename).toBe('Chapter One');
  });

  test('an empty uri list yields an empty index with a fresh empty titleIndex', () => {
    const index = buildNoteIndex([]);
    expect(index.entries).toEqual([]);
    expect(index.byBasename.size).toBe(0);
    expect(index.titleIndex.size).toBe(0);
  });
});

describe('registerNoteTitle', () => {
  test('registers a lowercased title key pointing at a single-element path array', () => {
    const index = buildNoteIndex([]);
    registerNoteTitle(index, 'My Great Chapter', 'file:///vault/chapter-1.md');
    expect(index.titleIndex.get('my great chapter')).toEqual(['file:///vault/chapter-1.md']);
  });

  test('a blank/whitespace-only title is a no-op', () => {
    const index = buildNoteIndex([]);
    registerNoteTitle(index, '   ', 'file:///vault/chapter-1.md');
    expect(index.titleIndex.size).toBe(0);
  });

  test('a second registration for the same title key accumulates, in encounter order (duplicate titles are legal)', () => {
    const index = buildNoteIndex([]);
    registerNoteTitle(index, 'Same Title', 'file:///vault/first.md');
    registerNoteTitle(index, 'same title', 'file:///vault/second.md');
    expect(index.titleIndex.get('same title')).toEqual([
      'file:///vault/first.md',
      'file:///vault/second.md'
    ]);
  });
});

describe('extractNoteTitle', () => {
  test('prefers the front-matter title field over an H1', () => {
    const markdown = [
      '---',
      'title: FM Title',
      '---',
      '',
      '# H1 Title',
      ''
    ].join('\n');
    expect(extractNoteTitle(markdown)).toBe('FM Title');
  });

  test('falls back to the first H1 when there is no front matter', () => {
    const markdown = '# Первый заголовок\n\nBody text.\n';
    expect(extractNoteTitle(markdown)).toBe('Первый заголовок');
  });

  test('falls back to the first H1 when front matter has no title field', () => {
    const markdown = [
      '---',
      'slug: my-note',
      '---',
      '',
      '# Fallback Heading',
      ''
    ].join('\n');
    expect(extractNoteTitle(markdown)).toBe('Fallback Heading');
  });

  test('a blank front-matter title field falls back to the H1', () => {
    const markdown = [
      '---',
      'title: ""',
      '---',
      '',
      '# Real Title',
      ''
    ].join('\n');
    expect(extractNoteTitle(markdown)).toBe('Real Title');
  });

  test('returns undefined when neither a title field nor an H1 is present', () => {
    const markdown = 'Just a paragraph, no heading.\n';
    expect(extractNoteTitle(markdown)).toBeUndefined();
  });

  test('ignores a heading that is not H1 (## does not count)', () => {
    const markdown = '## Not an H1\n\nBody.\n';
    expect(extractNoteTitle(markdown)).toBeUndefined();
  });

  test('picks the FIRST H1 when the body has more than one', () => {
    const markdown = '# First\n\nBody.\n\n# Second\n';
    expect(extractNoteTitle(markdown)).toBe('First');
  });
});
