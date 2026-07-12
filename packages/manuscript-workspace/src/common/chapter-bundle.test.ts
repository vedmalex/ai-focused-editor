import { describe, expect, test } from 'bun:test';
import { buildChapterBundle } from './chapter-bundle';
import type { CitationEntry, SourceExcerpt } from './source-library-protocol';

describe('buildChapterBundle', () => {
  test('always puts the chapter first with a base-name label fallback', () => {
    const items = buildChapterBundle('plain prose, no tags', { chapterPath: 'content/chapter-01.md' });
    expect(items).toEqual([
      { variable: 'chapter', arg: 'content/chapter-01.md', label: 'chapter-01.md', detail: 'content/chapter-01.md' }
    ]);
  });

  test('uses the provided chapter label when given', () => {
    const [chapter] = buildChapterBundle('', { chapterPath: 'content/ch1.md', chapterLabel: 'Chapter One' });
    expect(chapter).toEqual({ variable: 'chapter', arg: 'content/ch1.md', label: 'Chapter One', detail: 'content/ch1.md' });
  });

  test('collects entities from labeled and bare semantic tags, unique by kind+id, in order', () => {
    const text = 'On the field [[char:krishna|Krishna]] speaks of [[term:dharma]] and [[gandiva]]. Again [[char:krishna|Govinda]].';
    const items = buildChapterBundle(text, { chapterPath: 'c.md' });
    const entities = items.filter(item => item.variable === 'entity');
    expect(entities).toEqual([
      { variable: 'entity', arg: 'krishna', label: 'Krishna', detail: 'character:krishna' },
      { variable: 'entity', arg: 'dharma', label: 'dharma', detail: 'term:dharma' },
      { variable: 'entity', arg: 'gandiva', label: 'gandiva', detail: 'gandiva' }
    ]);
  });

  test('collects citations from [@cite:id], labeling from the citation index', () => {
    const citations: CitationEntry[] = [
      { id: 'smith2020', title: 'Smith 2020', source: 'sources/smith.pdf', path: 'sources/smith.pdf' }
    ];
    const text = 'As shown [@cite:smith2020] and again [@cite:smith2020], plus [@cite:unknown99].';
    const items = buildChapterBundle(text, { chapterPath: 'c.md', citations });
    const citationItems = items.filter(item => item.variable === 'citation');
    expect(citationItems).toEqual([
      { variable: 'citation', arg: 'smith2020', label: 'Smith 2020', detail: 'smith2020' },
      { variable: 'citation', arg: 'unknown99', label: 'unknown99', detail: 'unknown99' }
    ]);
  });

  test('derives sources from matched citation paths, tied excerpts, and direct references', () => {
    const citations: CitationEntry[] = [
      { id: 'smith2020', title: 'Smith', path: 'sources/smith.pdf' }
    ];
    const excerpts: SourceExcerpt[] = [
      { id: 'ex-1', sourceId: 'smith2020', sourcePath: 'sources/smith-notes.md', text: 'quote' },
      { id: 'ex-2', sourceId: 'other', sourcePath: 'sources/other.md', text: 'unrelated' }
    ];
    const text = 'See [@cite:smith2020]. Also refer to [the paper](sources/extra/paper.docx) directly.';
    const items = buildChapterBundle(text, { chapterPath: 'c.md', citations, excerpts });
    const sources = items.filter(item => item.variable === 'source').map(item => item.arg);
    expect(sources).toEqual(['sources/smith.pdf', 'sources/smith-notes.md', 'sources/extra/paper.docx']);
  });

  test('de-duplicates a source referenced multiple ways and strips a leading ./', () => {
    const citations: CitationEntry[] = [{ id: 'c1', title: 't', path: 'sources/a.pdf' }];
    const text = '[@cite:c1] and a link [x](./sources/a.pdf) again.';
    const items = buildChapterBundle(text, { chapterPath: 'c.md', citations });
    const sources = items.filter(item => item.variable === 'source');
    expect(sources).toEqual([{ variable: 'source', arg: 'sources/a.pdf', label: 'a.pdf', detail: 'sources/a.pdf' }]);
  });

  test('ignores bare sources/ folder mentions without a file extension', () => {
    const items = buildChapterBundle('Everything lives under sources/ somewhere.', { chapterPath: 'c.md' });
    expect(items.filter(item => item.variable === 'source')).toEqual([]);
  });

  test('keeps a stable overall order: chapter, entities, citations, sources', () => {
    const citations: CitationEntry[] = [{ id: 'c1', title: 'C1', path: 'sources/c1.pdf' }];
    const text = '[[char:hero|Hero]] cites [@cite:c1].';
    const kinds = buildChapterBundle(text, { chapterPath: 'c.md', citations }).map(item => item.variable);
    expect(kinds).toEqual(['chapter', 'entity', 'citation', 'source']);
  });
});
