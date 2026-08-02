import { describe, expect, test } from 'bun:test';
import { noSpaceBeforePunctuationRule } from './no-space-before-punctuation';
import {
  LineSnapshot,
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

function applyToLine(text: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): string {
  const ctx = context([line(1, text, opts)]);
  const edits = noSpaceBeforePunctuationRule.apply(ctx) ?? [];
  return spliceEdits(text, edits);
}

describe('noSpaceBeforePunctuationRule (#36)', () => {
  test('metadata is stable and correct', () => {
    expect(noSpaceBeforePunctuationRule.id).toBe('no-space-before-punctuation');
    expect(noSpaceBeforePunctuationRule.priority).toBe(20);
    expect(noSpaceBeforePunctuationRule.defaultEnabled).toBe(true);
  });

  test('golden: one space before a comma is removed', () => {
    expect(applyToLine('word ,')).toBe('word,');
  });

  test('golden: several spaces before punctuation are all removed', () => {
    expect(applyToLine('word  ;')).toBe('word;');
  });

  test('golden: every sentence mark is handled', () => {
    expect(applyToLine('a . b , c ; d : e ! f ? g …')).toBe('a. b, c; d: e! f? g…');
  });

  test('negative: correct text (no space before mark) is untouched', () => {
    const ctx = context([line(1, 'word, next.')]);
    expect(noSpaceBeforePunctuationRule.apply(ctx)).toBeNull();
  });

  test('negative: a normal inter-word space is left alone', () => {
    expect(applyToLine('one two three')).toBe('one two three');
  });

  test('negative: leading indentation is never touched', () => {
    // The only whitespace is the leading indent before a mark — not a word gap.
    const ctx = context([line(1, '    .hidden')]);
    expect(noSpaceBeforePunctuationRule.apply(ctx)).toBeNull();
  });

  test('negative: a code line is skipped wholesale', () => {
    expect(applyToLine('a = b ;', { isCode: true })).toBe('a = b ;');
  });

  test('negative: a space before a mark inside inline code is preserved', () => {
    // "a `x ,y` z" — inline span covers columns 3..9 (1-based, endColumn exclusive).
    const tokens = [{ startColumn: 3, endColumn: 9, kind: TokenKind.InlineCode }];
    expect(applyToLine('a `x ,y` z', { tokens })).toBe('a `x ,y` z');
  });

  test('idempotence: a second application makes no further edits', () => {
    // #36 only removes the space BEFORE a mark; it does not touch other gaps.
    const once = applyToLine('word ,and .');
    expect(once).toBe('word,and.');
    const ctx = context([line(1, once)]);
    expect(noSpaceBeforePunctuationRule.apply(ctx)).toBeNull();
  });

  test('deletion range is exact', () => {
    const ctx = context([line(1, 'ab  .')]);
    const edits = noSpaceBeforePunctuationRule.apply(ctx) ?? [];
    expect(edits).toHaveLength(1);
    // The two spaces occupy columns 3-4; delete [3, 5).
    expect(edits[0].range.start.column).toBe(3);
    expect(edits[0].range.end.column).toBe(5);
    expect(edits[0].text).toBe('');
  });
});
