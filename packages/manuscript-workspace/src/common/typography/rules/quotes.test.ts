import { describe, expect, test } from 'bun:test';
import { openingQuoteToGuillemetRule } from './opening-quote-to-guillemet';
import { closingQuoteToGuillemetRule } from './closing-quote-to-guillemet';
import {
  LineSnapshot,
  TokenKind,
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';

function context(text: string, locale: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): TypographyContext {
  return {
    lines: [{ lineNumber: 1, text, tokens: opts.tokens ?? [], isCode: opts.isCode ?? false }],
    changedRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    cursor: { line: 1, column: 1 },
    locale,
    trigger: 'type'
  };
}

function spliceEdits(text: string, edits: TypographyEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.range.start.column - a.range.start.column);
  let result = text;
  for (const edit of sorted) {
    result = result.slice(0, edit.range.start.column - 1) + edit.text + result.slice(edit.range.end.column - 1);
  }
  return result;
}

/** Apply both quote rules (as the engine would, non-overlapping) over one line. */
function applyBoth(text: string, locale: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): string {
  const ctx = context(text, locale, opts);
  const edits = [
    ...(openingQuoteToGuillemetRule.apply(ctx) ?? []),
    ...(closingQuoteToGuillemetRule.apply(ctx) ?? [])
  ];
  return spliceEdits(text, edits);
}

function applyOne(rule: TypographyRule, text: string, locale: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): string {
  const edits = rule.apply(context(text, locale, opts)) ?? [];
  return spliceEdits(text, edits);
}

describe('quote rules #34 / #35', () => {
  test('metadata is stable and locale-aware', () => {
    expect(openingQuoteToGuillemetRule.id).toBe('opening-quote-to-guillemet');
    expect(closingQuoteToGuillemetRule.id).toBe('closing-quote-to-guillemet');
    expect(openingQuoteToGuillemetRule.priority).toBe(40);
    expect(closingQuoteToGuillemetRule.priority).toBe(40);
    expect(openingQuoteToGuillemetRule.localeAware).toBe(true);
    expect(closingQuoteToGuillemetRule.localeAware).toBe(true);
    expect(openingQuoteToGuillemetRule.defaultEnabled).toBe(true);
    expect(closingQuoteToGuillemetRule.defaultEnabled).toBe(true);
  });

  test('golden ru: "привет" → «привет»', () => {
    expect(applyBoth('"привет"', 'ru')).toBe('«привет»');
  });

  test('golden ru: closing after a guillemet — «Привет" → «Привет»', () => {
    expect(applyOne(closingQuoteToGuillemetRule, '«Привет"', 'ru')).toBe('«Привет»');
  });

  test('golden en: "hello" → “hello”', () => {
    expect(applyBoth('"hello"', 'en')).toBe('“hello”');
  });

  test('opening vs closing classification is mutually exclusive', () => {
    // Opening rule only touches the first quote, closing only the second.
    expect(applyOne(openingQuoteToGuillemetRule, '"привет"', 'ru')).toBe('«привет"');
    expect(applyOne(closingQuoteToGuillemetRule, '"привет"', 'ru')).toBe('"привет»');
  });

  test('negative: a quote inside inline code is preserved', () => {
    // "x `"y"` z" — inline span covers columns 3..8 (1-based, endColumn exclusive).
    const tokens = [{ startColumn: 3, endColumn: 8, kind: TokenKind.InlineCode }];
    expect(applyBoth('x `"y"` z', 'ru', { tokens })).toBe('x `"y"` z');
  });

  test('negative: a code line is skipped', () => {
    expect(applyBoth('const s = "x"', 'ru', { isCode: true })).toBe('const s = "x"');
  });

  test('idempotence: a second application makes no further edits (ru)', () => {
    const once = applyBoth('"привет"', 'ru');
    expect(once).toBe('«привет»');
    const ctx = context(once, 'ru');
    expect(openingQuoteToGuillemetRule.apply(ctx)).toBeNull();
    expect(closingQuoteToGuillemetRule.apply(ctx)).toBeNull();
  });
});
