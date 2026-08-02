import { describe, expect, test } from 'bun:test';
import { insideNonProseToken, overlapsNonProseToken } from './token-guard';
import { LineSnapshot, TokenKind } from '../typography-types';

/**
 * The "never touch code" predicate every rule now shares (ISS-248). Before the
 * extraction this logic existed in seven copies, so these tests are the single
 * place the 1-based-column ↔ 0-based-index translation is pinned down.
 */

function line(text: string, tokens: LineSnapshot['tokens'] = []): LineSnapshot {
  return { lineNumber: 1, text, tokens, isCode: false };
}

//            0123456789...
// text:      call `a,b` now
// The inline span `a,b` occupies 0-based [5, 10) → 1-based [6, 11).
const INLINE = line('call `a,b` now', [
  { startColumn: 6, endColumn: 11, kind: TokenKind.InlineCode }
]);

describe('insideNonProseToken', () => {
  test('the character just before the span is prose', () => {
    expect(insideNonProseToken(INLINE, 4)).toBe(false);
  });

  test('the opening backtick itself is inside the span', () => {
    expect(insideNonProseToken(INLINE, 5)).toBe(true);
  });

  test('the closing backtick (last index of the span) is inside', () => {
    expect(insideNonProseToken(INLINE, 9)).toBe(true);
  });

  test('the character just after the span is prose again (end is exclusive)', () => {
    expect(insideNonProseToken(INLINE, 10)).toBe(false);
  });

  test('a Text-kind token is prose and never guards', () => {
    const prose = line('plain text', [{ startColumn: 1, endColumn: 6, kind: TokenKind.Text }]);
    expect(insideNonProseToken(prose, 0)).toBe(false);
  });

  test('a Comment token guards like code', () => {
    const commented = line('a <!-- x --> b', [{ startColumn: 3, endColumn: 13, kind: TokenKind.Comment }]);
    expect(insideNonProseToken(commented, 5)).toBe(true);
    expect(insideNonProseToken(commented, 13)).toBe(false);
  });

  test('a line with no tokens never guards', () => {
    expect(insideNonProseToken(line('nothing here'), 3)).toBe(false);
  });
});

describe('overlapsNonProseToken', () => {
  test('an interval entirely before the span does not overlap', () => {
    expect(overlapsNonProseToken(INLINE, 0, 5)).toBe(false);
  });

  test('an interval that only touches the span start overlaps', () => {
    expect(overlapsNonProseToken(INLINE, 4, 6)).toBe(true);
  });

  test('an interval starting exactly at the exclusive end does not overlap', () => {
    expect(overlapsNonProseToken(INLINE, 10, 14)).toBe(false);
  });

  test('an interval swallowing the whole span overlaps', () => {
    expect(overlapsNonProseToken(INLINE, 0, 14)).toBe(true);
  });

  test('a degenerate empty interval inside a span still guards (fail-safe)', () => {
    // No caller passes start === end (every rule works on a real character run),
    // but the half-open formula reports TRUE here, and that is the direction we
    // want documented: a degenerate interval inside code is treated as code.
    expect(overlapsNonProseToken(INLINE, 7, 7)).toBe(true);
    expect(overlapsNonProseToken(INLINE, 2, 2)).toBe(false);
  });

  test('the point form agrees with the interval form at every index', () => {
    // The invariant that lets insideNonProseToken delegate: they must never
    // disagree, or the seven former copies would be reintroduced as a bug.
    for (let col = 0; col < INLINE.text.length; col++) {
      expect(insideNonProseToken(INLINE, col)).toBe(overlapsNonProseToken(INLINE, col, col + 1));
    }
  });

  test('multiple spans are all honoured', () => {
    const two = line('`a` mid `b`', [
      { startColumn: 1, endColumn: 4, kind: TokenKind.InlineCode },
      { startColumn: 9, endColumn: 12, kind: TokenKind.InlineCode }
    ]);
    expect(overlapsNonProseToken(two, 0, 1)).toBe(true);
    expect(overlapsNonProseToken(two, 4, 8)).toBe(false);
    expect(overlapsNonProseToken(two, 9, 10)).toBe(true);
  });
});
