import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EMPTY_EXCERPT_ROW,
  hasBlockingExcerptProblems,
  isKnownExcerptKey,
  parseExcerptsJsonl,
  serializeExcerptsJsonl,
  validateExcerpts,
  type ExcerptFormRow
} from './excerpt-forms';

const SAMPLE_PATH = join(
  import.meta.dir,
  '../../../../examples/sample-book/sources/excerpts.jsonl'
);

describe('parseExcerptsJsonl', () => {
  it('parses a well-formed record into typed fields', () => {
    const { rows, unparsed } = parseExcerptsJsonl(
      '{"id":"a","text":"hello","source":"c1","sourcePath":"sources/a.md","ref":"R","note":"n","targetPath":"content/ch1.md","targetAnchor":"anchor","targetLine":9}'
    );
    expect(unparsed).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'a',
      text: 'hello',
      source: 'c1',
      sourcePath: 'sources/a.md',
      ref: 'R',
      note: 'n',
      targetPath: 'content/ch1.md',
      targetAnchor: 'anchor',
      targetLine: 9
    });
    // No unknown keys → no `extra` property.
    expect(rows[0].extra).toBeUndefined();
  });

  it('skips blank and whitespace-only lines', () => {
    const { rows, unparsed } = parseExcerptsJsonl(
      '\n{"id":"a","text":"x"}\n   \n\t\n{"id":"b","text":"y"}\n'
    );
    expect(unparsed).toEqual([]);
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('keeps a line that is not valid JSON in unparsed, verbatim, with a 1-based line number', () => {
    const { rows, unparsed } = parseExcerptsJsonl(
      '{"id":"a","text":"x"}\nthis is not json\n{"id":"b","text":"y"}'
    );
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
    expect(unparsed).toEqual([{ line: 2, raw: 'this is not json' }]);
  });

  it('treats JSON that is not a plain object as unparsed (number, string, array, null)', () => {
    const { rows, unparsed } = parseExcerptsJsonl('123\n"str"\n[1,2]\nnull\n{"id":"ok","text":"t"}');
    expect(rows.map(r => r.id)).toEqual(['ok']);
    expect(unparsed.map(u => u.raw)).toEqual(['123', '"str"', '[1,2]', 'null']);
    expect(unparsed.map(u => u.line)).toEqual([1, 2, 3, 4]);
  });

  it('preserves unknown extra keys in original order via `extra`', () => {
    const { rows } = parseExcerptsJsonl('{"id":"a","zeta":1,"text":"t","alpha":{"k":"v"}}');
    expect(rows[0].extra).toEqual({ zeta: 1, alpha: { k: 'v' } });
    expect(Object.keys(rows[0].extra ?? {})).toEqual(['zeta', 'alpha']);
  });

  it('coerces non-string known scalar fields to strings', () => {
    const { rows } = parseExcerptsJsonl('{"id":42,"text":true,"note":7}');
    expect(rows[0].id).toBe('42');
    expect(rows[0].text).toBe('true');
    expect(rows[0].note).toBe('7');
  });

  it('preserves a non-numeric targetLine in extra rather than dropping it', () => {
    const { rows } = parseExcerptsJsonl('{"id":"a","text":"t","targetLine":"9"}');
    expect(rows[0].targetLine).toBeUndefined();
    expect(rows[0].extra).toEqual({ targetLine: '9' });
  });
});

describe('serializeExcerptsJsonl', () => {
  it('writes known keys in the canonical order and omits empty/undefined fields', () => {
    const row: ExcerptFormRow = {
      id: 'a',
      text: 'hello',
      note: 'n',
      source: 'c1',
      sourcePath: '',
      targetLine: 3,
      targetPath: 'content/ch1.md'
    };
    const out = serializeExcerptsJsonl([row]);
    expect(out).toBe(
      '{"id":"a","text":"hello","source":"c1","note":"n","targetPath":"content/ch1.md","targetLine":3}\n'
    );
  });

  it('writes targetLine only when it is a positive integer', () => {
    const base: ExcerptFormRow = { id: 'a', text: 't', targetPath: 'p.md' };
    expect(serializeExcerptsJsonl([{ ...base, targetLine: 5 }])).toContain('"targetLine":5');
    expect(serializeExcerptsJsonl([{ ...base, targetLine: 0 }])).not.toContain('targetLine');
    expect(serializeExcerptsJsonl([{ ...base, targetLine: -2 }])).not.toContain('targetLine');
    expect(serializeExcerptsJsonl([{ ...base, targetLine: 3.5 }])).not.toContain('targetLine');
  });

  it('appends extra keys after the known keys, in original order', () => {
    const row: ExcerptFormRow = { id: 'a', text: 't', extra: { zeta: 1, alpha: 2 } };
    expect(serializeExcerptsJsonl([row])).toBe('{"id":"a","text":"t","zeta":1,"alpha":2}\n');
  });

  it('re-emits unparsed raw lines at the end in original order', () => {
    const rows: ExcerptFormRow[] = [{ id: 'a', text: 't' }];
    const out = serializeExcerptsJsonl(rows, [
      { line: 9, raw: 'weird-1' },
      { line: 2, raw: 'weird-2' }
    ]);
    expect(out).toBe('{"id":"a","text":"t"}\nweird-1\nweird-2\n');
  });

  it('returns the empty string when there is nothing to write', () => {
    expect(serializeExcerptsJsonl([])).toBe('');
    expect(serializeExcerptsJsonl([], [])).toBe('');
  });
});

describe('round-trip', () => {
  it('round-trips the sample-book excerpts.jsonl byte-for-byte', () => {
    const original = readFileSync(SAMPLE_PATH, 'utf8');
    const { rows, unparsed } = parseExcerptsJsonl(original);
    expect(unparsed).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(serializeExcerptsJsonl(rows, unparsed)).toBe(original);
  });

  it('round-trips a file with an invalid line, preserving it (moved to the end)', () => {
    const input = '{"id":"a","text":"x"}\nBROKEN {not json}\n{"id":"b","text":"y"}\n';
    const { rows, unparsed } = parseExcerptsJsonl(input);
    const out = serializeExcerptsJsonl(rows, unparsed);
    expect(out).toBe('{"id":"a","text":"x"}\n{"id":"b","text":"y"}\nBROKEN {not json}\n');
    // The broken line survives a second round-trip too.
    const again = parseExcerptsJsonl(out);
    expect(again.unparsed.map(u => u.raw)).toEqual(['BROKEN {not json}']);
  });

  it('round-trips unknown extra keys', () => {
    const input = '{"id":"a","text":"t","futureField":["x","y"],"weight":0.5}\n';
    const { rows, unparsed } = parseExcerptsJsonl(input);
    expect(serializeExcerptsJsonl(rows, unparsed)).toBe(input);
  });
});

describe('validateExcerpts', () => {
  it('accepts well-formed rows with no problems', () => {
    const rows: ExcerptFormRow[] = [
      { id: 'a', text: 'x' },
      { id: 'b', text: 'y', targetPath: 'p.md', targetLine: 4 }
    ];
    expect(validateExcerpts(rows)).toEqual([]);
    expect(hasBlockingExcerptProblems(validateExcerpts(rows))).toBe(false);
  });

  it('flags an empty id as a blocking error', () => {
    const problems = validateExcerpts([{ id: '  ', text: 'x' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe('error');
    expect(hasBlockingExcerptProblems(problems)).toBe(true);
  });

  it('flags a duplicate id as a blocking error on the second occurrence', () => {
    const problems = validateExcerpts([
      { id: 'dup', text: 'x' },
      { id: 'dup', text: 'y' }
    ]);
    const dupes = problems.filter(p => p.message.includes('duplicate'));
    expect(dupes).toHaveLength(1);
    expect(dupes[0].index).toBe(1);
    expect(dupes[0].severity).toBe('error');
  });

  it('flags empty text as a blocking error', () => {
    const problems = validateExcerpts([{ id: 'a', text: '   ' }]);
    expect(problems.some(p => p.severity === 'error' && p.message.includes('text'))).toBe(true);
  });

  it('warns when targetLine is set without a targetPath', () => {
    const problems = validateExcerpts([{ id: 'a', text: 'x', targetLine: 5 }]);
    expect(problems).toEqual([
      {
        severity: 'warning',
        index: 0,
        message: 'Excerpt 1: targetLine is set without a targetPath, so there is no file to open.'
      }
    ]);
    expect(hasBlockingExcerptProblems(problems)).toBe(false);
  });

  it('warns on a non-integer or non-positive targetLine', () => {
    const negative = validateExcerpts([{ id: 'a', text: 'x', targetPath: 'p.md', targetLine: -1 }]);
    expect(negative.some(p => p.severity === 'warning' && p.message.includes('positive whole number'))).toBe(true);
    const fractional = validateExcerpts([{ id: 'a', text: 'x', targetPath: 'p.md', targetLine: 2.5 }]);
    expect(fractional.some(p => p.severity === 'warning' && p.message.includes('positive whole number'))).toBe(true);
  });
});

describe('helpers', () => {
  it('EMPTY_EXCERPT_ROW is a blank id/text row', () => {
    expect(EMPTY_EXCERPT_ROW).toEqual({ id: '', text: '' });
  });

  it('isKnownExcerptKey recognizes the canonical keys and rejects others', () => {
    for (const key of ['id', 'text', 'source', 'sourcePath', 'ref', 'note', 'targetPath', 'targetAnchor', 'targetLine']) {
      expect(isKnownExcerptKey(key)).toBe(true);
    }
    expect(isKnownExcerptKey('whatever')).toBe(false);
  });
});
