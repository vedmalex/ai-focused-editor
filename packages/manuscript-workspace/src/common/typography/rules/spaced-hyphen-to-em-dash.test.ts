import { describe, expect, test } from 'bun:test';
import { spacedHyphenToEmDashRule } from './spaced-hyphen-to-em-dash';
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
    locale: 'ru',
    trigger: 'type'
  };
}

function line(lineNumber: number, text: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): LineSnapshot {
  return { lineNumber, text, tokens: opts.tokens ?? [], isCode: opts.isCode ?? false };
}

function spliceEdits(text: string, edits: TypographyEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.range.start.column - a.range.start.column);
  let result = text;
  for (const edit of sorted) {
    result = result.slice(0, edit.range.start.column - 1) + edit.text + result.slice(edit.range.end.column - 1);
  }
  return result;
}

function applyToLine(text: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): string {
  const edits = spacedHyphenToEmDashRule.apply(context([line(1, text, opts)])) ?? [];
  return spliceEdits(text, edits);
}

describe('spacedHyphenToEmDashRule (#32)', () => {
  test('metadata is stable', () => {
    expect(spacedHyphenToEmDashRule.id).toBe('spaced-hyphen-to-em-dash');
    expect(spacedHyphenToEmDashRule.priority).toBe(30);
    expect(spacedHyphenToEmDashRule.defaultEnabled).toBe(true);
  });

  test('golden: a spaced hyphen becomes an em dash, spaces kept', () => {
    expect(applyToLine('Привет - мир')).toBe('Привет — мир');
  });

  test('golden: two spaced hyphens both convert', () => {
    expect(applyToLine('Это было - как обычно - неожиданно.')).toBe('Это было — как обычно — неожиданно.');
  });

  test('negative: a compound-word hyphen (no spaces) is untouched', () => {
    expect(spacedHyphenToEmDashRule.apply(context([line(1, 'из-за кто-то well-known')]))).toBeNull();
  });

  test('negative: a double/triple hyphen is not a dash', () => {
    expect(spacedHyphenToEmDashRule.apply(context([line(1, 'a -- b')]))).toBeNull();
  });

  test('negative: a leading-of-line hyphen is left to #40', () => {
    expect(spacedHyphenToEmDashRule.apply(context([line(1, '- реплика')]))).toBeNull();
  });

  test('negative: a code line is skipped', () => {
    expect(applyToLine('a - b', { isCode: true })).toBe('a - b');
  });

  test('negative: a hyphen inside inline code is preserved', () => {
    // "x `a - b` y" — inline span covers columns 3..9 (1-based, endColumn exclusive).
    const tokens = [{ startColumn: 3, endColumn: 9, kind: TokenKind.InlineCode }];
    expect(applyToLine('x `a - b` y', { tokens })).toBe('x `a - b` y');
  });

  test('idempotence: a second application makes no further edits', () => {
    const once = applyToLine('Привет - мир');
    expect(spacedHyphenToEmDashRule.apply(context([line(1, once)]))).toBeNull();
  });
});
