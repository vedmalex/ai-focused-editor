import { describe, expect, test } from 'bun:test';
import {
  parseCitations,
  parseExcerpts,
  activeCiteContext,
  rankCitations,
  citeInsertion,
  buildExcerptBlockquote,
  type Citation,
  type Excerpt
} from './citations';

describe('parseCitations', () => {
  test('parses the { citations: [...] } document shape', () => {
    const yaml = [
      'citations:',
      '  - id: smith2020',
      '    title: On Rivers',
      '    source: sources/smith.pdf',
      '    note: chapter 3',
      ''
    ].join('\n');
    expect(parseCitations(yaml)).toEqual([
      { id: 'smith2020', title: 'On Rivers', source: 'sources/smith.pdf', note: 'chapter 3' }
    ]);
  });

  test('accepts a bare top-level list', () => {
    const yaml = '- id: a\n  title: A\n- id: b\n  title: B\n';
    expect(parseCitations(yaml).map(c => c.id)).toEqual(['a', 'b']);
  });

  test('drops entries missing id or title', () => {
    const yaml = 'citations:\n  - id: ok\n    title: Fine\n  - id: noTitle\n  - title: noId\n';
    expect(parseCitations(yaml).map(c => c.id)).toEqual(['ok']);
  });

  test('empty / malformed input yields an empty list, never throws', () => {
    expect(parseCitations(undefined)).toEqual([]);
    expect(parseCitations('')).toEqual([]);
    expect(parseCitations('citations: 42')).toEqual([]);
    expect(parseCitations(': : :\n  broken')).toEqual([]);
  });
});

describe('parseExcerpts', () => {
  test('parses one JSON object per line', () => {
    const jsonl = [
      JSON.stringify({ id: 'ex-1', text: 'A quote', source: 'smith2020', note: 'p.5' }),
      '',
      JSON.stringify({ text: 'No id here', sourcePath: 'sources/x.md' })
    ].join('\n');
    const excerpts = parseExcerpts(jsonl);
    expect(excerpts).toEqual([
      { id: 'ex-1', sourceId: 'smith2020', text: 'A quote', note: 'p.5' },
      { id: 'excerpt-3', sourcePath: 'sources/x.md', text: 'No id here' }
    ]);
  });

  test('a path-shaped source doubles as sourcePath', () => {
    const jsonl = JSON.stringify({ id: 'ex', text: 't', source: 'sources/a.pdf' });
    expect(parseExcerpts(jsonl)[0]).toEqual({
      id: 'ex',
      sourceId: 'sources/a.pdf',
      sourcePath: 'sources/a.pdf',
      text: 't'
    });
  });

  test('skips blank, non-JSON, and text-less lines', () => {
    const jsonl = ['  ', 'not json', JSON.stringify({ id: 'x' }), JSON.stringify({ id: 'y', text: 'ok' })].join('\n');
    expect(parseExcerpts(jsonl).map(e => e.id)).toEqual(['y']);
  });

  test('folds ref into note when note is absent', () => {
    const jsonl = JSON.stringify({ id: 'ex', text: 't', ref: 'foot-3' });
    expect(parseExcerpts(jsonl)[0].note).toBe('foot-3');
  });
});

describe('activeCiteContext', () => {
  test('fires on [@prefix and reports the token start + query', () => {
    const line = 'see [@smi more';
    expect(activeCiteContext(line, 9)).toEqual({ tokenStart: 4, query: 'smi' });
  });

  test('strips a leading cite:', () => {
    expect(activeCiteContext('[@cite:smi', 10)).toEqual({ tokenStart: 0, query: 'smi' });
  });

  test('empty query right after [@', () => {
    expect(activeCiteContext('[@', 2)).toEqual({ tokenStart: 0, query: '' });
  });

  test('does not fire without [@, or across a space / bracket / close', () => {
    expect(activeCiteContext('plain text', 5)).toBeNull();
    expect(activeCiteContext('[@smith 2020', 12)).toBeNull();
    expect(activeCiteContext('[@smith]', 8)).toBeNull();
    expect(activeCiteContext('[@a[b', 5)).toBeNull();
  });

  test('uses the nearest [@ before the cursor', () => {
    const line = '[@one] and [@tw';
    expect(activeCiteContext(line, 15)).toEqual({ tokenStart: 11, query: 'tw' });
  });
});

describe('rankCitations', () => {
  const citations: Citation[] = [
    { id: 'smith2020', title: 'On Rivers' },
    { id: 'jones2019', title: 'Smithing Steel', source: 'jones.pdf' },
    { id: 'lee2021', title: 'Deltas', source: 'about-smith.pdf' }
  ];

  test('empty query keeps source order', () => {
    expect(rankCitations(citations, '').map(c => c.id)).toEqual(['smith2020', 'jones2019', 'lee2021']);
  });

  test('id-prefix outranks id-substring outranks title outranks source', () => {
    expect(rankCitations(citations, 'smith').map(c => c.id)).toEqual(['smith2020', 'jones2019', 'lee2021']);
  });

  test('non-matches drop out', () => {
    expect(rankCitations(citations, 'zzz')).toEqual([]);
  });
});

describe('citeInsertion + buildExcerptBlockquote', () => {
  test('citeInsertion wraps the id', () => {
    expect(citeInsertion('smith2020')).toBe('[@cite:smith2020]');
  });

  test('blockquote prefixes every line and appends the sourceId ref', () => {
    const excerpt: Excerpt = { id: 'ex-1', sourceId: 'smith2020', text: 'Line one\nLine two' };
    expect(buildExcerptBlockquote(excerpt)).toBe('> Line one\n> Line two\n>\n> [@cite:smith2020]');
  });

  test('falls back to the excerpt id when no sourceId', () => {
    const excerpt: Excerpt = { id: 'ex-9', text: 'Solo' };
    expect(buildExcerptBlockquote(excerpt)).toBe('> Solo\n>\n> [@cite:ex-9]');
  });
});
