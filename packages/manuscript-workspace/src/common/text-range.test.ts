import { describe, expect, test } from 'bun:test';
import { comparePositions, normalizeRange } from './text-range';

describe('normalizeRange', () => {
  test('keeps an already-ordered (ltr) range and deep-copies it', () => {
    const source = { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } };
    const result = normalizeRange(source);
    expect(result).toEqual(source);
    expect(result.start).not.toBe(source.start);
    expect(result.end).not.toBe(source.end);
  });

  test('swaps an upward (rtl) multi-line selection into document order', () => {
    // Theia maps start=anchor, end=cursor: selecting from line 24 up to 19
    // arrives as start(24) > end(19).
    const result = normalizeRange({ start: { line: 24, character: 70 }, end: { line: 19, character: 0 } });
    expect(result).toEqual({ start: { line: 19, character: 0 }, end: { line: 24, character: 70 } });
  });

  test('swaps a same-line rtl selection by character', () => {
    const result = normalizeRange({ start: { line: 5, character: 30 }, end: { line: 5, character: 10 } });
    expect(result).toEqual({ start: { line: 5, character: 10 }, end: { line: 5, character: 30 } });
  });

  test('leaves an empty (caret) range untouched', () => {
    const caret = { start: { line: 7, character: 3 }, end: { line: 7, character: 3 } };
    expect(normalizeRange(caret)).toEqual(caret);
  });
});

describe('comparePositions', () => {
  test('orders by line first, then character', () => {
    expect(comparePositions({ line: 1, character: 9 }, { line: 2, character: 0 })).toBeLessThan(0);
    expect(comparePositions({ line: 2, character: 1 }, { line: 2, character: 0 })).toBeGreaterThan(0);
    expect(comparePositions({ line: 2, character: 5 }, { line: 2, character: 5 })).toBe(0);
  });
});
