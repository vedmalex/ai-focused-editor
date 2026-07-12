import { describe, expect, test } from 'bun:test';
import {
  findContextSet,
  hasBlockingProblems,
  isContextSetId,
  parseContextSets,
  slugifyContextSetId,
  upsertContextSetInYaml,
  validateContextSet,
  type ContextSet
} from './context-sets';

describe('parseContextSets', () => {
  test('returns an empty document for empty/undefined input', () => {
    expect(parseContextSets('')).toEqual({ version: 1, sets: [] });
    expect(parseContextSets(undefined)).toEqual({ version: 1, sets: [] });
  });

  test('parses a well-formed file with items and arg-less members', () => {
    const text = [
      'version: 1',
      'sets:',
      '  - id: ch3',
      '    label: Chapter 3 research',
      '    items:',
      '      - variable: chapter',
      '        arg: content/chapter-03.md',
      '      - variable: entities'
    ].join('\n');
    expect(parseContextSets(text)).toEqual({
      version: 1,
      sets: [
        {
          id: 'ch3',
          label: 'Chapter 3 research',
          items: [
            { variable: 'chapter', arg: 'content/chapter-03.md' },
            { variable: 'entities' }
          ]
        }
      ]
    });
  });

  test('tolerantly skips invalid sets and items, defaults a missing label to the id', () => {
    const text = [
      'sets:',
      '  - label: no id, skipped',
      '  - id: ok',
      '    items:',
      '      - arg: orphan-without-variable',
      '      - variable: chapter'
    ].join('\n');
    const parsed = parseContextSets(text);
    expect(parsed.sets).toEqual([
      { id: 'ok', label: 'ok', items: [{ variable: 'chapter' }] }
    ]);
  });

  test('never throws on unparseable YAML', () => {
    expect(parseContextSets(': : : not : yaml :').sets).toEqual([]);
  });
});

describe('slugifyContextSetId', () => {
  test('kebab-cases a label', () => {
    expect(slugifyContextSetId('Chapter 3 — Research!')).toBe('chapter-3-research');
  });
  test('falls back to "set" for empty slugs', () => {
    expect(slugifyContextSetId('   ')).toBe('set');
    expect(slugifyContextSetId('!!!')).toBe('set');
  });
  test('produced ids pass the id check', () => {
    expect(isContextSetId(slugifyContextSetId('My Working Set'))).toBe(true);
  });
});

describe('validateContextSet', () => {
  const known = ['chapter', 'entity', 'entities', 'citation', 'source'];

  test('accepts a valid set', () => {
    const set: ContextSet = { id: 'ch3', label: 'Ch3', items: [{ variable: 'chapter', arg: 'a.md' }] };
    const problems = validateContextSet(set, known);
    expect(hasBlockingProblems(problems)).toBe(false);
    expect(problems).toEqual([]);
  });

  test('flags a missing id and empty items as errors', () => {
    const problems = validateContextSet({ id: '', label: '', items: [] }, known);
    expect(problems.map(p => p.code).sort()).toEqual(['id-required', 'no-items']);
    expect(hasBlockingProblems(problems)).toBe(true);
  });

  test('flags a duplicate id against existing ids', () => {
    const set: ContextSet = { id: 'ch3', label: 'Ch3', items: [{ variable: 'chapter' }] };
    const problems = validateContextSet(set, known, ['ch3', 'other']);
    expect(problems.some(p => p.code === 'duplicate-id')).toBe(true);
  });

  test('does not flag a re-save over the same id (excluded from existing ids)', () => {
    const set: ContextSet = { id: 'ch3', label: 'Ch3', items: [{ variable: 'chapter' }] };
    const problems = validateContextSet(set, known, ['other']);
    expect(problems.some(p => p.code === 'duplicate-id')).toBe(false);
  });

  test('warns on an unknown variable but does not block', () => {
    const set: ContextSet = { id: 'ch3', label: 'Ch3', items: [{ variable: 'made-up' }] };
    const problems = validateContextSet(set, known);
    expect(problems.some(p => p.code === 'unknown-variable')).toBe(true);
    expect(hasBlockingProblems(problems)).toBe(false);
  });
});

describe('upsertContextSetInYaml', () => {
  test('creates a fresh file with version and the set', () => {
    const text = upsertContextSetInYaml(undefined, {
      id: 'ch3',
      label: 'Chapter 3',
      items: [{ variable: 'chapter', arg: 'content/ch3.md' }, { variable: 'entities' }]
    });
    const parsed = parseContextSets(text);
    expect(parsed.version).toBe(1);
    expect(findContextSet(parsed, 'ch3')).toEqual({
      id: 'ch3',
      label: 'Chapter 3',
      items: [{ variable: 'chapter', arg: 'content/ch3.md' }, { variable: 'entities' }]
    });
  });

  test('appends a new set while preserving existing sets and comments', () => {
    const existing = [
      '# my context sets',
      'version: 1',
      'sets:',
      '  - id: first',
      '    label: First',
      '    items:',
      '      - variable: manuscript'
    ].join('\n');
    const text = upsertContextSetInYaml(existing, { id: 'second', label: 'Second', items: [{ variable: 'entities' }] });
    expect(text).toContain('# my context sets');
    const parsed = parseContextSets(text);
    expect(parsed.sets.map(s => s.id)).toEqual(['first', 'second']);
  });

  test('replaces a set in place when the id already exists', () => {
    const existing = upsertContextSetInYaml(undefined, { id: 'ch3', label: 'Old', items: [{ variable: 'manuscript' }] });
    const updated = upsertContextSetInYaml(existing, {
      id: 'ch3',
      label: 'New',
      items: [{ variable: 'chapter', arg: 'a.md' }]
    });
    const parsed = parseContextSets(updated);
    expect(parsed.sets).toHaveLength(1);
    expect(findContextSet(parsed, 'ch3')).toEqual({ id: 'ch3', label: 'New', items: [{ variable: 'chapter', arg: 'a.md' }] });
  });
});
