import { describe, expect, test } from 'bun:test';
import { fixDoubleCapitalAfterSpaceRule } from './fix-double-capital-after-space';
import {
  LineSnapshot,
  LineToken,
  TokenKind,
  TypographyContext,
  TypographyEdit
} from '../typography-types';

function context(lines: LineSnapshot[], locale = 'ru'): TypographyContext {
  return {
    lines,
    changedRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    cursor: { line: 1, column: 1 },
    locale,
    trigger: 'type'
  };
}

function line(lineNumber: number, text: string, opts: { isCode?: boolean; tokens?: LineToken[] } = {}): LineSnapshot {
  return { lineNumber, text, tokens: opts.tokens ?? [], isCode: opts.isCode ?? false };
}

function applyCol(text: string, edits: TypographyEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.range.start.column - a.range.start.column);
  let result = text;
  for (const edit of sorted) {
    result = result.slice(0, edit.range.start.column - 1) + edit.text + result.slice(edit.range.end.column - 1);
  }
  return result;
}

function once(text: string): string {
  return applyCol(text, fixDoubleCapitalAfterSpaceRule.apply(context([line(1, text)])) ?? []);
}

describe('fixDoubleCapitalAfterSpaceRule (#42)', () => {
  test('metadata is stable, on by default, locale-aware', () => {
    expect(fixDoubleCapitalAfterSpaceRule.id).toBe('fix-double-capital-after-space');
    expect(fixDoubleCapitalAfterSpaceRule.priority).toBe(45);
    expect(fixDoubleCapitalAfterSpaceRule.defaultEnabled).toBe(true);
    expect(fixDoubleCapitalAfterSpaceRule.localeAware).toBe(true);
  });

  test('golden: fixes a stutter double capital after a space', () => {
    expect(once('Он ПРишёл.')).toBe('Он Пришёл.');
    expect(once('Это БЫло давно.')).toBe('Это Было давно.');
  });

  test('negative: an all-caps acronym is preserved', () => {
    expect(fixDoubleCapitalAfterSpaceRule.apply(context([line(1, 'по ГОСТ 12345')]))).toBeNull();
    expect(fixDoubleCapitalAfterSpaceRule.apply(context([line(1, 'страна США сегодня')]))).toBeNull();
    expect(fixDoubleCapitalAfterSpaceRule.apply(context([line(1, 'из СССР родом')]))).toBeNull();
  });

  test('negative: a preserved two-caps unit (МПа) is untouched', () => {
    expect(fixDoubleCapitalAfterSpaceRule.apply(context([line(1, 'давление 10 МПа сейчас')]))).toBeNull();
  });

  test('negative: a normal single-capital proper noun is untouched', () => {
    expect(fixDoubleCapitalAfterSpaceRule.apply(context([line(1, 'пришёл Иван домой')]))).toBeNull();
  });

  test('negative: a code line and inline code are skipped', () => {
    expect(fixDoubleCapitalAfterSpaceRule.apply(context([line(1, 'x ABc', { isCode: true })]))).toBeNull();
    // `код ABc` all inside one inline-code span (columns 1..9): the space-preceded
    // `ABc` word sits inside the token, so the fix must not fire.
    const tokens: LineToken[] = [{ startColumn: 1, endColumn: 10, kind: TokenKind.InlineCode }];
    expect(fixDoubleCapitalAfterSpaceRule.apply(context([line(1, '`код ABc`', { tokens })]))).toBeNull();
  });

  test('idempotence: a second pass makes no further edits', () => {
    const first = once('Он ПРишёл.');
    expect(fixDoubleCapitalAfterSpaceRule.apply(context([line(1, first)]))).toBeNull();
  });
});
