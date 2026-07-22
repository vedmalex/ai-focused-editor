import { describe, expect, test } from 'bun:test';
import {
  DocsContentProvider,
  DocsLang,
  DocsManifest,
  DocsPage
} from './docs-contract';
import {
  DOCS_LANGS,
  resolveDocsLang,
  resolveDocsManifest,
  resolveDocsPage,
  sortDocsManifestEntries
} from './docs-lang';

/**
 * Language-resolution tests (tech_spec §F.6 / §E.2).
 *
 * TWO NAMED PROVIDERS, one file, because the requirements are mutually
 * exclusive: the page-fallback rows need an `en` set that HAS `start`, and the
 * manifest-merge degenerate rows need an `en` manifest that is EMPTY.
 *
 * Both are standalone implementations of `DocsContentProvider` — which is also
 * the second proof of readiness criterion 8: the content source can be swapped
 * without touching a single `.md`.
 *
 * NOTE ON FIXTURES: plain quoted strings only — NEVER `String.raw`, which under
 * Bun replaces Cyrillic with escape sequences.
 */

function makePage(lang: DocsLang, id: string, title: string, order: number, section?: string): DocsPage {
  return { id, lang, title, order, section, markdown: `# ${title}\n`, covers: [] };
}

const ruPages: readonly DocsPage[] = [
  makePage('ru', 'home', 'Путеводитель', 0),
  makePage('ru', 'start', 'С чего начать', 10),
  makePage('ru', 'book/export', 'Экспорт книги', 20, 'Книга')
];

const enPages: readonly DocsPage[] = [makePage('en', 'start', 'Getting started', 10)];

function manifestOf(lang: DocsLang, pages: readonly DocsPage[]): DocsManifest {
  return {
    lang,
    entries: sortDocsManifestEntries(
      pages.map(page => ({ id: page.id, title: page.title, order: page.order, section: page.section }))
    )
  };
}

function providerOf(en: readonly DocsPage[]): DocsContentProvider {
  const byLang: Record<DocsLang, readonly DocsPage[]> = { ru: ruPages, en };
  return {
    getPage: (lang, id) => byLang[lang].find(page => page.id === id),
    getManifest: lang => manifestOf(lang, byLang[lang])
  };
}

/** ru: {home, start, book/export}; en: {start} — a partially translated set. */
const partialEnProvider: DocsContentProvider = providerOf(enPages);

/** ru: the same three; en: nothing at all — today's production state. */
const emptyEnProvider: DocsContentProvider = providerOf([]);

describe('resolveDocsLang', () => {
  test('trims the region and lowercases, for both separators', () => {
    expect(resolveDocsLang('en-US', DOCS_LANGS)).toBe('en');
    expect(resolveDocsLang('EN_us', DOCS_LANGS)).toBe('en');
    expect(resolveDocsLang('  ru-RU  ', DOCS_LANGS)).toBe('ru');
  });

  test('an unknown, empty or absent locale falls back to the default language', () => {
    expect(resolveDocsLang('de', DOCS_LANGS)).toBe('ru');
    expect(resolveDocsLang('', DOCS_LANGS)).toBe('ru');
    expect(resolveDocsLang(undefined, DOCS_LANGS)).toBe('ru');
  });
});

describe('resolveDocsPage — §E.2 rows 1-7', () => {
  test('1. an exact hit after region trimming returns the en page', () => {
    expect(resolveDocsPage(partialEnProvider, 'en-US', 'start')?.lang).toBe('en');
    expect(resolveDocsPage(partialEnProvider, 'en-US', 'start')?.title).toBe('Getting started');
  });

  test('2. a page missing in en falls back to the ru page (the heart of UR-007)', () => {
    const page = resolveDocsPage(partialEnProvider, 'en-US', 'book/export');
    expect(page?.lang).toBe('ru');
    expect(page?.title).toBe('Экспорт книги');
  });

  test('3. region trimming applies to the default language too', () => {
    expect(resolveDocsPage(partialEnProvider, 'ru-RU', 'start')?.lang).toBe('ru');
  });

  test('4. an unknown language resolves to the default set', () => {
    expect(resolveDocsPage(partialEnProvider, 'de', 'start')?.lang).toBe('ru');
  });

  test('5. an absent locale (the default English user) resolves to the default set', () => {
    expect(resolveDocsPage(partialEnProvider, undefined, 'start')?.lang).toBe('ru');
  });

  test('6. case and the underscore separator are handled', () => {
    expect(resolveDocsPage(partialEnProvider, 'EN_us', 'start')?.lang).toBe('en');
  });

  test('7. a page that exists in neither language is undefined, never a stub', () => {
    expect(resolveDocsPage(partialEnProvider, 'en', 'ghost')).toBeUndefined();
    expect(resolveDocsPage(partialEnProvider, 'ru', 'ghost')).toBeUndefined();
  });
});

describe('resolveDocsManifest — §E.2 rows 8-10 (per-entry merge)', () => {
  test('8. explicit English with an EMPTY en manifest yields all three ru entries', () => {
    const manifest = resolveDocsManifest(emptyEnProvider, 'en');
    expect(manifest.entries.map(entry => entry.id)).toEqual(['home', 'start', 'book/export']);
    expect(manifest.entries.map(entry => entry.title))
      .toEqual(['Путеводитель', 'С чего начать', 'Экспорт книги']);
  });

  test('9. paired positive: ru also yields all three (the rule, not "always ru")', () => {
    const manifest = resolveDocsManifest(emptyEnProvider, 'ru');
    expect(manifest.entries.map(entry => entry.id)).toEqual(['home', 'start', 'book/export']);
  });

  test('10. a PARTIAL en merges per id: three entries, only start localized', () => {
    const manifest = resolveDocsManifest(partialEnProvider, 'en');
    expect(manifest.entries).toHaveLength(3);
    expect(manifest.entries.map(entry => entry.title))
      .toEqual(['Путеводитель', 'Getting started', 'Экспорт книги']);
  });

  test('a partial en does NOT collapse the navigation to the translated page alone', () => {
    const manifest = resolveDocsManifest(partialEnProvider, 'en');
    expect(manifest.entries.length).toBeGreaterThan(partialEnProvider.getManifest('en').entries.length);
  });

  test('a localized entry may move: the merged manifest is re-sorted by §B.3', () => {
    const moved: DocsContentProvider = {
      getPage: partialEnProvider.getPage,
      getManifest: lang => lang === 'ru'
        ? partialEnProvider.getManifest('ru')
        : { lang: 'en', entries: [{ id: 'start', title: 'Getting started', order: 30, section: 'Книга' }] }
    };
    const manifest = resolveDocsManifest(moved, 'en');
    // `start` now belongs to the "Книга" group with order 30, so it sorts after
    // `book/export` (order 20) instead of ahead of it.
    expect(manifest.entries.map(entry => entry.id)).toEqual(['home', 'book/export', 'start']);
  });
});

describe('sortDocsManifestEntries — the §B.3 order', () => {
  test('the section-less group comes first regardless of its orders', () => {
    const sorted = sortDocsManifestEntries([
      { id: 'b/one', title: 'B1', order: 1, section: 'Книга' },
      { id: 'loose', title: 'L', order: 99 }
    ]);
    expect(sorted.map(entry => entry.id)).toEqual(['loose', 'b/one']);
  });

  test('groups sort by their minimum order, entries by order then id', () => {
    const sorted = sortDocsManifestEntries([
      { id: 'w/late', title: 'WL', order: 40, section: 'Письмо' },
      { id: 'b/second', title: 'B2', order: 20, section: 'Книга' },
      { id: 'w/early', title: 'WE', order: 30, section: 'Письмо' },
      { id: 'b/also', title: 'BA', order: 20, section: 'Книга' },
      { id: 'b/first', title: 'B1', order: 10, section: 'Книга' }
    ]);
    expect(sorted.map(entry => entry.id))
      .toEqual(['b/first', 'b/also', 'b/second', 'w/early', 'w/late']);
  });
});
