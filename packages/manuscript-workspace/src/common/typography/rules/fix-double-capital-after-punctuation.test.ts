import { describe, expect, test } from 'bun:test';
import { fixDoubleCapitalAfterPunctuationRule } from './fix-double-capital-after-punctuation';
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
  return applyCol(text, fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, text)])) ?? []);
}

describe('fixDoubleCapitalAfterPunctuationRule (#43)', () => {
  test('metadata is stable, on by default, locale-aware', () => {
    expect(fixDoubleCapitalAfterPunctuationRule.id).toBe('fix-double-capital-after-punctuation');
    expect(fixDoubleCapitalAfterPunctuationRule.priority).toBe(45);
    expect(fixDoubleCapitalAfterPunctuationRule.defaultEnabled).toBe(true);
    expect(fixDoubleCapitalAfterPunctuationRule.localeAware).toBe(true);
  });

  test('golden: fixes a stutter double capital after sentence punctuation', () => {
    expect(once('Привет. КАк дела?')).toBe('Привет. Как дела?');
    expect(once('Готово! МОжно продолжать.')).toBe('Готово! Можно продолжать.');
  });

  test('negative: a double capital NOT after punctuation is left to #42', () => {
    // Only a space precedes `БЫло` here (no sentence mark), so #43 must not fire.
    expect(fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, 'Это БЫло давно.')]))).toBeNull();
  });

  test('negative: an all-caps acronym after punctuation is preserved', () => {
    expect(fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, 'Смотри. ГОСТ 12345 тут')]))).toBeNull();
    expect(fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, 'Итог! США победили')]))).toBeNull();
  });

  test('negative: a preserved two-caps unit after punctuation is untouched', () => {
    expect(fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, 'Итог. МПа держится')]))).toBeNull();
  });

  test('negative: a normal single capital after punctuation is untouched', () => {
    expect(fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, 'Привет. Как дела?')]))).toBeNull();
  });

  test('negative: a code line and an inline-code span are skipped', () => {
    expect(fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, 'a. BCd', { isCode: true })]))).toBeNull();
    // SYMMETRY with #42 (QA/ISS-257): the sibling rule covered both `isCode` AND
    // an inline-code token, this one only `isCode`. Both rules reach the shared
    // `doubleCapitalFixEdit` token guard, so an inline-code regression here was
    // detectable only through #42's test — a one-rule-wide hole in the "never
    // rewrite literal source" invariant.
    // `` `код. ABc` `` entirely inside one inline-code span (columns 1..10).
    const tokens: LineToken[] = [{ startColumn: 1, endColumn: 11, kind: TokenKind.InlineCode }];
    expect(fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, '`код. ABc`', { tokens })]))).toBeNull();
  });

  test('ANTI-TAUTOLOGY: the SAME text outside an inline-code span IS fixed', () => {
    // Proves the negative above is carried by the token guard, not by the text
    // simply failing to match the stutter pattern.
    expect(once('`код. ABc`')).toBe('`код. Abc`');
  });

  test('en locale: the stutter fix works in a Latin document too', () => {
    // The rule is `localeAware` and its whole case decision runs through
    // `toLocaleLowerCase(locale)` / `\p{Ll}` — but every case above pinned `ru`
    // only (QA/ISS-257), so the en branch was never executed.
    const enOnce = (text: string): string =>
      applyCol(text, fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, text)], 'en')) ?? []);
    expect(enOnce('Hello. WOrld is wide.')).toBe('Hello. World is wide.');
    // …and the en negatives still hold: an acronym after punctuation survives.
    expect(fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, 'Look. NASA launched it')], 'en'))).toBeNull();
  });

  test('idempotence: a second pass makes no further edits', () => {
    const first = once('Привет. КАк дела?');
    expect(fixDoubleCapitalAfterPunctuationRule.apply(context([line(1, first)]))).toBeNull();
  });
});
