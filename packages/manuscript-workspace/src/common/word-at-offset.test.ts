import { describe, expect, test } from 'bun:test';
import { isWordChar, wordAtOffset } from './word-at-offset';

describe('wordAtOffset', () => {
  test('finds the word when the cursor is in the middle', () => {
    const line = 'the quick brown fox';
    // cursor inside "quick" (index 6 -> between 'u' and 'i')
    expect(wordAtOffset(line, 6)).toEqual({ word: 'quick', start: 4, end: 9 });
  });

  test('finds the word when the cursor is at its start', () => {
    const line = 'the quick brown fox';
    expect(wordAtOffset(line, 4)).toEqual({ word: 'quick', start: 4, end: 9 });
  });

  test('finds the word when the cursor is at its end', () => {
    const line = 'the quick brown fox';
    // index 9 is right after 'quick', before the space
    expect(wordAtOffset(line, 9)).toEqual({ word: 'quick', start: 4, end: 9 });
  });

  test('finds a word at the very start of the line (offset 0)', () => {
    const line = 'hello world';
    expect(wordAtOffset(line, 0)).toEqual({ word: 'hello', start: 0, end: 5 });
  });

  test('finds a word at the very end of the line (offset === length)', () => {
    const line = 'hello world';
    expect(wordAtOffset(line, line.length)).toEqual({ word: 'world', start: 6, end: 11 });
  });

  test('handles Cyrillic words', () => {
    const line = 'Главный Герой идёт';
    // cursor inside "Герой"
    expect(wordAtOffset(line, 10)).toEqual({ word: 'Герой', start: 8, end: 13 });
  });

  test('handles accented Unicode letters as part of a word', () => {
    const line = 'café déjà';
    expect(wordAtOffset(line, 2)).toEqual({ word: 'café', start: 0, end: 4 });
    expect(wordAtOffset(line, 7)).toEqual({ word: 'déjà', start: 5, end: 9 });
  });

  test('includes digits and underscore, stops at punctuation boundaries', () => {
    const line = 'call foo_bar2(x)';
    expect(wordAtOffset(line, 7)).toEqual({ word: 'foo_bar2', start: 5, end: 13 });
    // cursor after '(' before 'x'
    expect(wordAtOffset(line, 14)).toEqual({ word: 'x', start: 14, end: 15 });
  });

  test('returns undefined when the cursor sits between non-word characters', () => {
    const line = 'a -- b';
    // cursor between the two dashes (index 3)
    expect(wordAtOffset(line, 3)).toBeUndefined();
  });

  test('returns undefined inside leading whitespace', () => {
    const line = '   word';
    expect(wordAtOffset(line, 1)).toBeUndefined();
  });

  test('returns undefined for an empty line', () => {
    expect(wordAtOffset('', 0)).toBeUndefined();
  });

  test('clamps out-of-range offsets instead of throwing', () => {
    const line = 'edge';
    expect(wordAtOffset(line, 999)).toEqual({ word: 'edge', start: 0, end: 4 });
    expect(wordAtOffset(line, -5)).toEqual({ word: 'edge', start: 0, end: 4 });
    expect(wordAtOffset(line, Number.NaN)).toBeUndefined();
  });

  test('does not merge words separated by punctuation', () => {
    const line = 'foo.bar';
    expect(wordAtOffset(line, 2)).toEqual({ word: 'foo', start: 0, end: 3 });
    expect(wordAtOffset(line, 5)).toEqual({ word: 'bar', start: 4, end: 7 });
    // cursor exactly on the dot boundary (index 3) prefers the preceding word
    expect(wordAtOffset(line, 3)).toEqual({ word: 'foo', start: 0, end: 3 });
  });
});

describe('isWordChar', () => {
  test('classifies letters, digits and underscore as word characters', () => {
    for (const ch of ['a', 'Z', '9', '_', 'ё', 'Я', 'é']) {
      expect(isWordChar(ch)).toBe(true);
    }
  });

  test('classifies whitespace and punctuation as non-word characters', () => {
    for (const ch of [' ', '\t', '.', ',', '-', '(', undefined, '']) {
      expect(isWordChar(ch)).toBe(false);
    }
  });
});
