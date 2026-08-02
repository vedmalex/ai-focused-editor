import { describe, expect, test } from 'bun:test';
import { sentenceStartCapitalRule } from './sentence-start-capital';
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
  return applyCol(text, sentenceStartCapitalRule.apply(context([line(1, text)])) ?? []);
}

describe('sentenceStartCapitalRule (#39)', () => {
  test('metadata is stable, on by default, locale-aware', () => {
    expect(sentenceStartCapitalRule.id).toBe('sentence-start-capital');
    expect(sentenceStartCapitalRule.priority).toBe(50);
    expect(sentenceStartCapitalRule.defaultEnabled).toBe(true);
    expect(sentenceStartCapitalRule.localeAware).toBe(true);
  });

  test('golden: capitalize after a period', () => {
    expect(once('Привет. мир.')).toBe('Привет. Мир.');
  });

  test('golden: capitalize after a question mark', () => {
    expect(once('Ты пришёл? да.')).toBe('Ты пришёл? Да.');
  });

  test('golden: capitalize after an exclamation mark and an ellipsis', () => {
    expect(once('Вот это да! невероятно.')).toBe('Вот это да! Невероятно.');
    expect(once('И вот… наконец.')).toBe('И вот… Наконец.');
  });

  test('negative: known abbreviation "т.е." (no spaces) is untouched', () => {
    expect(sentenceStartCapitalRule.apply(context([line(1, 'это т.е. пример')]))).toBeNull();
  });

  test('negative: spaced abbreviations and initials are untouched', () => {
    expect(sentenceStartCapitalRule.apply(context([line(1, 'см. рис ниже')]))).toBeNull();
    expect(sentenceStartCapitalRule.apply(context([line(1, 'и. о. директора')]))).toBeNull();
    expect(sentenceStartCapitalRule.apply(context([line(1, 'И. петров пришёл')]))).toBeNull();
  });

  test('negative: numbers are not sentence boundaries', () => {
    expect(sentenceStartCapitalRule.apply(context([line(1, 'число 3.14 тут')]))).toBeNull();
    expect(sentenceStartCapitalRule.apply(context([line(1, 'стр. 5 далее')]))).toBeNull();
  });

  test('negative: no space between mark and letter (т.е.-like) is untouched', () => {
    expect(sentenceStartCapitalRule.apply(context([line(1, 'слово.дальше')]))).toBeNull();
  });

  test('negative: an already-capital letter is a no-op', () => {
    expect(sentenceStartCapitalRule.apply(context([line(1, 'Привет. Мир.')]))).toBeNull();
  });

  test('negative: a code line and an inline-code span are skipped', () => {
    expect(sentenceStartCapitalRule.apply(context([line(1, 'a. b', { isCode: true })]))).toBeNull();
    const tokens: LineToken[] = [{ startColumn: 1, endColumn: 13, kind: TokenKind.InlineCode }];
    // `код. текст` entirely inside one inline-code span (columns 1..12).
    expect(sentenceStartCapitalRule.apply(context([line(1, '`код. текст`', { tokens })]))).toBeNull();
  });

  test('idempotence: a second pass makes no further edits', () => {
    const first = once('Привет. мир.');
    expect(sentenceStartCapitalRule.apply(context([line(1, first)]))).toBeNull();
  });

  /**
   * The rule declares `localeAware: true` and capitalizes through
   * `toLocaleUpperCase(locale)` — yet every case above pins `ru` (QA/ISS-257),
   * so the en branch of the Unicode case handling (UR-005) was never executed.
   */
  describe('en locale (UR-005 Unicode/locale branch)', () => {
    const enOnce = (text: string): string =>
      applyCol(text, sentenceStartCapitalRule.apply(context([line(1, text)], 'en')) ?? []);

    test('golden: capitalize after a period, a question mark and an exclamation mark', () => {
      expect(enOnce('Hello. world.')).toBe('Hello. World.');
      expect(enOnce('Are you there? yes.')).toBe('Are you there? Yes.');
      expect(enOnce('Wow! amazing.')).toBe('Wow! Amazing.');
    });

    test('negative: an English abbreviation ("etc. ") is not a sentence boundary', () => {
      expect(sentenceStartCapitalRule.apply(context([line(1, 'apples, pears, etc. and more')], 'en'))).toBeNull();
    });

    test('negative: an English initial is not a sentence boundary', () => {
      expect(sentenceStartCapitalRule.apply(context([line(1, 'J. smith arrived')], 'en'))).toBeNull();
    });

    test('negative: a decimal number is not a sentence boundary', () => {
      expect(sentenceStartCapitalRule.apply(context([line(1, 'about 3.14 or so')], 'en'))).toBeNull();
    });

    test('negative: an already-capital English letter is a no-op', () => {
      expect(sentenceStartCapitalRule.apply(context([line(1, 'Hello. World.')], 'en'))).toBeNull();
    });
  });
});
