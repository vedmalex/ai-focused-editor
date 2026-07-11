import { describe, expect, test } from 'bun:test';
import {
  basenameFromPath,
  buildBookCatalog,
  buildBookCatalogEntry,
  extractBookMeta,
  type RawBookCandidate
} from './book-catalog';

describe('extractBookMeta', () => {
  test('reads title and author from a record', () => {
    expect(extractBookMeta({ title: 'My Book', author: 'Jane Doe' })).toEqual({
      title: 'My Book',
      author: 'Jane Doe'
    });
  });

  test('trims whitespace and drops blank strings', () => {
    expect(extractBookMeta({ title: '  Spaced  ', author: '   ' })).toEqual({
      title: 'Spaced',
      author: undefined
    });
  });

  test('ignores non-string fields', () => {
    expect(extractBookMeta({ title: 42, author: ['x'] })).toEqual({
      title: undefined,
      author: undefined
    });
  });

  test('tolerates non-object metadata', () => {
    expect(extractBookMeta(undefined)).toEqual({});
    expect(extractBookMeta(null)).toEqual({});
    expect(extractBookMeta('a string')).toEqual({});
    expect(extractBookMeta(['a', 'list'])).toEqual({});
  });
});

describe('basenameFromPath', () => {
  test('returns the last segment', () => {
    expect(basenameFromPath('file:///Users/x/library/my-book')).toBe('my-book');
  });

  test('percent-decodes spaces', () => {
    expect(basenameFromPath('file:///lib/My%20Great%20Book')).toBe('My Great Book');
  });

  test('ignores trailing slashes', () => {
    expect(basenameFromPath('file:///lib/book///')).toBe('book');
  });

  test('strips a query or fragment', () => {
    expect(basenameFromPath('file:///lib/book?x=1#frag')).toBe('book');
  });

  test('falls back to the raw input when there is no segment', () => {
    expect(basenameFromPath('/')).toBe('/');
  });

  test('survives malformed percent-encoding', () => {
    expect(basenameFromPath('file:///lib/bad%zz')).toBe('bad%zz');
  });
});

describe('buildBookCatalogEntry', () => {
  test('uses the metadata title when present', () => {
    const entry = buildBookCatalogEntry({
      path: 'file:///lib/folder-name',
      metadata: { title: 'The Real Title', author: 'A. Writer' }
    });
    expect(entry).toEqual({
      path: 'file:///lib/folder-name',
      title: 'The Real Title',
      author: 'A. Writer'
    });
  });

  test('falls back to the folder basename when metadata lacks a title', () => {
    const entry = buildBookCatalogEntry({ path: 'file:///lib/folder-name', metadata: {} });
    expect(entry.title).toBe('folder-name');
    expect(entry.author).toBeUndefined();
  });

  test('falls back when metadata is missing entirely', () => {
    const entry = buildBookCatalogEntry({ path: 'file:///lib/untitled' });
    expect(entry).toEqual({ path: 'file:///lib/untitled', title: 'untitled' });
  });

  test('carries a cover URI through untouched', () => {
    const entry = buildBookCatalogEntry({
      path: 'file:///lib/b',
      metadata: { title: 'B' },
      coverUri: 'data:image/png;base64,AAAA'
    });
    expect(entry.coverUri).toBe('data:image/png;base64,AAAA');
  });

  test('omits an empty cover URI', () => {
    const entry = buildBookCatalogEntry({ path: 'file:///lib/b', metadata: { title: 'B' }, coverUri: '' });
    expect('coverUri' in entry).toBe(false);
  });
});

describe('buildBookCatalog', () => {
  test('sorts entries by title, case- and accent-insensitively', () => {
    const candidates: RawBookCandidate[] = [
      { path: 'file:///lib/z', metadata: { title: 'Zebra' } },
      { path: 'file:///lib/a', metadata: { title: 'apple' } },
      { path: 'file:///lib/m', metadata: { title: 'Émigré' } }
    ];
    expect(buildBookCatalog(candidates).map(e => e.title)).toEqual(['apple', 'Émigré', 'Zebra']);
  });

  test('orders numeric titles naturally', () => {
    const candidates: RawBookCandidate[] = [
      { path: 'file:///lib/10', metadata: { title: 'Book 10' } },
      { path: 'file:///lib/2', metadata: { title: 'Book 2' } }
    ];
    expect(buildBookCatalog(candidates).map(e => e.title)).toEqual(['Book 2', 'Book 10']);
  });

  test('breaks title ties by path for a stable order', () => {
    const candidates: RawBookCandidate[] = [
      { path: 'file:///lib/second', metadata: { title: 'Same' } },
      { path: 'file:///lib/first', metadata: { title: 'Same' } }
    ];
    expect(buildBookCatalog(candidates).map(e => e.path)).toEqual([
      'file:///lib/first',
      'file:///lib/second'
    ]);
  });

  test('mixes metadata titles and basename fallbacks in one sort', () => {
    const candidates: RawBookCandidate[] = [
      { path: 'file:///lib/charlie' },
      { path: 'file:///lib/x', metadata: { title: 'Alpha' } }
    ];
    expect(buildBookCatalog(candidates).map(e => e.title)).toEqual(['Alpha', 'charlie']);
  });

  test('returns an empty list for no candidates', () => {
    expect(buildBookCatalog([])).toEqual([]);
  });
});
