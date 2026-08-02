import { describe, expect, test } from 'bun:test';
import { collapseMultipleSpacesRule } from './collapse-multiple-spaces';
import {
  LineSnapshot,
  TextRange,
  TokenKind,
  TypographyContext,
  TypographyEdit
} from '../typography-types';

function context(lines: LineSnapshot[]): TypographyContext {
  return {
    lines,
    changedRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    cursor: { line: 1, column: 1 },
    locale: 'en',
    trigger: 'type'
  };
}

function line(lineNumber: number, text: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): LineSnapshot {
  return { lineNumber, text, tokens: opts.tokens ?? [], isCode: opts.isCode ?? false };
}

/** Apply the rule and materialise the resulting text of a single-line context. */
function applyToLine(text: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): string {
  const ctx = context([line(1, text, opts)]);
  const edits = collapseMultipleSpacesRule.apply(ctx) ?? [];
  return spliceEdits(text, edits);
}

/** Splice single-line edits (right-to-left) into `text` for golden assertions. */
function spliceEdits(text: string, edits: TypographyEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.range.start.column - a.range.start.column);
  let result = text;
  for (const edit of sorted) {
    const start = edit.range.start.column - 1;
    const end = edit.range.end.column - 1;
    result = result.slice(0, start) + edit.text + result.slice(end);
  }
  return result;
}

describe('collapseMultipleSpacesRule (#38)', () => {
  test('metadata is stable and correct', () => {
    expect(collapseMultipleSpacesRule.id).toBe('collapse-multiple-spaces');
    expect(collapseMultipleSpacesRule.priority).toBe(10);
    expect(collapseMultipleSpacesRule.defaultEnabled).toBe(true);
  });

  test('golden: a double space between words collapses to one', () => {
    expect(applyToLine('foo  bar')).toBe('foo bar');
  });

  test('golden: several runs on one line all collapse', () => {
    expect(applyToLine('a   b    c')).toBe('a b c');
  });

  test('golden: a single space is left untouched (no edit)', () => {
    const ctx = context([line(1, 'foo bar')]);
    expect(collapseMultipleSpacesRule.apply(ctx)).toBeNull();
  });

  test('negative: leading indentation is NEVER collapsed', () => {
    expect(applyToLine('    indented prose')).toBe('    indented prose');
  });

  test('negative: leading indentation preserved but interior run still collapses', () => {
    expect(applyToLine('   foo  bar')).toBe('   foo bar');
  });

  test('negative: a code line is skipped wholesale', () => {
    expect(applyToLine('let  x  =  1', { isCode: true })).toBe('let  x  =  1');
  });

  test('negative: spaces inside an inline-code token are not collapsed', () => {
    // "a `x  y` z" — the inline span covers columns 3..8 (1-based, endColumn exclusive).
    const tokens = [{ startColumn: 3, endColumn: 9, kind: TokenKind.InlineCode }];
    expect(applyToLine('a `x  y` z', { tokens })).toBe('a `x  y` z');
  });

  test('prose spaces BEFORE an inline-code span still collapse (only the span is protected)', () => {
    const tokens = [{ startColumn: 5, endColumn: 11, kind: TokenKind.InlineCode }];
    // Columns 3-4 are a plain-prose double space; the token starts at column 5.
    expect(applyToLine('ab  `code`', { tokens })).toBe('ab `code`');
  });

  test('negative: a space run that overlaps an inline-code token is left alone', () => {
    // The run at columns 3-4 sits inside the token [3, 9) -> protected.
    const tokens = [{ startColumn: 3, endColumn: 9, kind: TokenKind.InlineCode }];
    expect(applyToLine('a `x  y` z', { tokens })).toBe('a `x  y` z');
  });

  test('idempotence: a second application makes no further edits', () => {
    const once = applyToLine('foo   bar    baz');
    expect(once).toBe('foo bar baz');
    const ctx = context([line(1, once)]);
    expect(collapseMultipleSpacesRule.apply(ctx)).toBeNull();
  });

  test('edit range is exact: replaces the whole run with one space', () => {
    const ctx = context([line(1, 'foo   bar')]);
    const edits = collapseMultipleSpacesRule.apply(ctx) ?? [];
    expect(edits).toHaveLength(1);
    const range: TextRange = edits[0].range;
    expect(range.start.column).toBe(4);
    expect(range.end.column).toBe(7);
    expect(edits[0].text).toBe(' ');
  });
});
