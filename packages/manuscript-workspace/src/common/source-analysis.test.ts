import { describe, expect, test } from 'bun:test';
import {
  buildExcerptRecords,
  buildSelectionExcerptRecord,
  citationSlugFromText,
  citationTitleFromText,
  coerceSourceAnalysis,
  countSlugOccurrences,
  dedupeCitationId,
  dedupeCitations,
  normalizeCitations,
  normalizeExcerpts
} from './source-analysis';

describe('coerceSourceAnalysis', () => {
  test('valid payload -> both arrays normalized', () => {
    const text = JSON.stringify({
      excerpts: [
        { text: 'A quotable line.', note: 'Why it matters.' },
        { text: 'Another passage.', ref: 'Bhagavad-gita 2.47' }
      ],
      citations: [
        { id: 'bg-2-47', title: 'Bhagavad-gita 2.47', source: 'documents/gita.md', note: 'Duty.' }
      ]
    });
    const analysis = coerceSourceAnalysis(text);
    expect(analysis.excerpts).toEqual([
      { text: 'A quotable line.', note: 'Why it matters.' },
      { text: 'Another passage.', ref: 'Bhagavad-gita 2.47' }
    ]);
    expect(analysis.citations).toEqual([
      { id: 'bg-2-47', title: 'Bhagavad-gita 2.47', source: 'documents/gita.md', note: 'Duty.' }
    ]);
  });

  test('fenced JSON wrapped in prose parses', () => {
    const text = 'Sure! Here is the analysis:\n\n```json\n' +
      '{"excerpts":[{"text":"Fenced excerpt."}],"citations":[{"id":"c1","title":"Fenced"}]}' +
      '\n```\nHope that helps.';
    const analysis = coerceSourceAnalysis(text);
    expect(analysis.excerpts).toEqual([{ text: 'Fenced excerpt.' }]);
    expect(analysis.citations).toEqual([{ id: 'c1', title: 'Fenced' }]);
  });

  test('missing arrays coerce to empty lists', () => {
    expect(coerceSourceAnalysis('{"excerpts":[{"text":"only excerpts"}]}')).toEqual({
      excerpts: [{ text: 'only excerpts' }],
      citations: []
    });
    expect(coerceSourceAnalysis('{}')).toEqual({ excerpts: [], citations: [] });
  });

  test('unparseable text -> empty analysis', () => {
    expect(coerceSourceAnalysis('no json here at all')).toEqual({ excerpts: [], citations: [] });
  });
});

describe('normalizeExcerpts', () => {
  test('drops blank/invalid entries and folds string entries', () => {
    const value = {
      excerpts: [
        { text: '  Trimmed.  ', note: '  keep  ' },
        'bare string excerpt',
        { text: '   ' },
        { note: 'no text' },
        42
      ]
    };
    expect(normalizeExcerpts(value)).toEqual([
      { text: 'Trimmed.', note: 'keep' },
      { text: 'bare string excerpt' }
    ]);
  });

  test('accepts a bare array', () => {
    expect(normalizeExcerpts([{ text: 'x' }])).toEqual([{ text: 'x' }]);
  });

  test('missing key -> empty', () => {
    expect(normalizeExcerpts({})).toEqual([]);
    expect(normalizeExcerpts(undefined)).toEqual([]);
  });
});

describe('normalizeCitations', () => {
  test('requires id and keeps optional fields', () => {
    const value = {
      citations: [
        { id: 'a', title: 'Title A', source: 'documents/a.md', note: 'note' },
        { title: 'no id' },
        { id: '   ' },
        { id: 'b' }
      ]
    };
    expect(normalizeCitations(value)).toEqual([
      { id: 'a', title: 'Title A', source: 'documents/a.md', note: 'note' },
      { id: 'b' }
    ]);
  });
});

describe('buildExcerptRecords', () => {
  test('generates ids continuing from existing count', () => {
    const records = buildExcerptRecords(
      [
        { text: 'One', note: 'first' },
        { text: 'Two', ref: 'BG 2.47' },
        { text: 'Three' }
      ],
      { sourceSlug: 'gita-notes', sourcePath: 'sources/documents/gita-notes.md', startIndex: 3 }
    );
    expect(records).toEqual([
      { id: 'gita-notes-4', sourcePath: 'sources/documents/gita-notes.md', text: 'One', note: 'first' },
      { id: 'gita-notes-5', sourcePath: 'sources/documents/gita-notes.md', text: 'Two', note: 'BG 2.47' },
      { id: 'gita-notes-6', sourcePath: 'sources/documents/gita-notes.md', text: 'Three' }
    ]);
  });

  test('starts at 1 for a fresh source and falls back on empty slug', () => {
    const records = buildExcerptRecords(
      [{ text: 'First' }],
      { sourceSlug: '', sourcePath: 'sources/a.md', startIndex: 0 }
    );
    expect(records).toEqual([
      { id: 'source-1', sourcePath: 'sources/a.md', text: 'First' }
    ]);
  });
});

describe('countSlugOccurrences', () => {
  test('counts only ids sharing the slug prefix', () => {
    const ids = ['gita-notes-1', 'gita-notes-2', 'other-1', 'dharma-context'];
    expect(countSlugOccurrences(ids, 'gita-notes')).toBe(2);
    expect(countSlugOccurrences(ids, 'other')).toBe(1);
    expect(countSlugOccurrences(ids, 'missing')).toBe(0);
  });
});

describe('citationSlugFromText', () => {
  test('slugifies the first words of a selection', () => {
    expect(citationSlugFromText('Duty that does not bend to grief; action that clings.'))
      .toBe('duty-that-does-not-bend-to');
  });

  test('honours a custom word count', () => {
    expect(citationSlugFromText('The field of decision and its consequences', 3))
      .toBe('the-field-of');
  });

  test('keeps unicode letters (Cyrillic)', () => {
    expect(citationSlugFromText('Глава первая начало пути', 2)).toBe('глава-первая');
  });

  test('falls back to citation when nothing usable remains', () => {
    expect(citationSlugFromText('   ***  ')).toBe('citation');
    expect(citationSlugFromText('')).toBe('citation');
  });
});

describe('citationTitleFromText', () => {
  test('collapses whitespace and keeps short text intact', () => {
    expect(citationTitleFromText('  A short\n  quotable line.  ')).toBe('A short quotable line.');
  });

  test('truncates long text with an ellipsis', () => {
    const title = citationTitleFromText('x'.repeat(80), 60);
    expect(title.length).toBe(60);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('dedupeCitationId', () => {
  test('returns the candidate unchanged when free', () => {
    expect(dedupeCitationId('duty-that-does-not-bend', ['other'])).toBe('duty-that-does-not-bend');
  });

  test('appends an incrementing suffix on collision', () => {
    expect(dedupeCitationId('duty', ['duty'])).toBe('duty-2');
    expect(dedupeCitationId('duty', ['duty', 'duty-2', 'duty-3'])).toBe('duty-4');
  });

  test('falls back to citation for an empty candidate', () => {
    expect(dedupeCitationId('', [])).toBe('citation');
  });
});

describe('buildSelectionExcerptRecord', () => {
  test('derives the excerpt id and links the manuscript line', () => {
    expect(buildSelectionExcerptRecord({
      citationId: 'duty-that-does-not-bend',
      sourcePath: 'content/chapter-01.md',
      text: 'Duty that does not bend to grief.',
      note: '  from the battlefield  ',
      targetLine: 9
    })).toEqual({
      id: 'duty-that-does-not-bend-excerpt',
      sourcePath: 'content/chapter-01.md',
      text: 'Duty that does not bend to grief.',
      targetPath: 'content/chapter-01.md',
      note: 'from the battlefield',
      targetLine: 9
    });
  });

  test('omits the note and target line when absent or non-positive', () => {
    expect(buildSelectionExcerptRecord({
      citationId: 'c1',
      sourcePath: 'content/a.md',
      text: 'Line.',
      targetLine: 0
    })).toEqual({
      id: 'c1-excerpt',
      sourcePath: 'content/a.md',
      text: 'Line.',
      targetPath: 'content/a.md'
    });
  });
});

describe('dedupeCitations', () => {
  test('skips ids already present on disk', () => {
    const result = dedupeCitations(
      [
        { id: 'bg-2-47', title: 'Bhagavad-gita 2.47' },
        { id: 'new-1', title: 'New citation' }
      ],
      ['bg-2-47', 'glossary-dharma']
    );
    expect(result.added).toEqual([{ id: 'new-1', title: 'New citation' }]);
    expect(result.skipped).toEqual(['bg-2-47']);
  });

  test('skips ids repeated within the incoming batch', () => {
    const result = dedupeCitations(
      [
        { id: 'dup', title: 'First' },
        { id: 'dup', title: 'Second' },
        { id: 'unique', title: 'Kept' }
      ],
      []
    );
    expect(result.added).toEqual([
      { id: 'dup', title: 'First' },
      { id: 'unique', title: 'Kept' }
    ]);
    expect(result.skipped).toEqual(['dup']);
  });
});
