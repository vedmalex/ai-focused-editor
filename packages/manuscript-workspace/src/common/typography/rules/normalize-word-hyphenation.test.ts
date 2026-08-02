import { describe, expect, test } from 'bun:test';
import { normalizeWordHyphenationRule } from './normalize-word-hyphenation';
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
  const edits = normalizeWordHyphenationRule.apply(context([line(1, text, opts)])) ?? [];
  return spliceEdits(text, edits);
}

describe('normalizeWordHyphenationRule (#33)', () => {
  test('metadata is stable and off by default', () => {
    expect(normalizeWordHyphenationRule.id).toBe('normalize-word-hyphenation');
    expect(normalizeWordHyphenationRule.priority).toBe(25);
    expect(normalizeWordHyphenationRule.defaultEnabled).toBe(false);
  });

  test('golden: dictionary preposition из за → из-за', () => {
    expect(applyToLine('вышел из за угла')).toBe('вышел из-за угла');
  });

  test('golden: pronoun+particle кто то → кто-то', () => {
    expect(applyToLine('там кто то был')).toBe('там кто-то был');
  });

  test('golden: original casing is preserved (Из за → Из-за)', () => {
    expect(applyToLine('Из за дождя')).toBe('Из-за дождя');
  });

  test('negative: a word pair NOT in the dictionary is untouched', () => {
    expect(normalizeWordHyphenationRule.apply(context([line(1, 'красный шар')]))).toBeNull();
  });

  test('negative: no substring match (изба за not touched)', () => {
    // "изба за" — left word is "изба", not the dictionary "из".
    expect(normalizeWordHyphenationRule.apply(context([line(1, 'изба за домом')]))).toBeNull();
  });

  test('negative: a wider gap (2 spaces) is left for #38 to collapse first', () => {
    expect(normalizeWordHyphenationRule.apply(context([line(1, 'из  за')]))).toBeNull();
  });

  test('negative: a code line is skipped', () => {
    expect(applyToLine('из за', { isCode: true })).toBe('из за');
  });

  test('idempotence: a second application makes no further edits', () => {
    const once = applyToLine('вышел из за угла');
    expect(once).toBe('вышел из-за угла');
    expect(normalizeWordHyphenationRule.apply(context([line(1, once)]))).toBeNull();
  });
});
