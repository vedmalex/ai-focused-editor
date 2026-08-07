import { describe, expect, test } from 'bun:test';
import { computeLineStarts, countLineBreaks, offsetToPosition, shiftPositionByLines } from './text-position';

describe('computeLineStarts', () => {
  test('an empty string is one line', () => {
    expect(computeLineStarts('')).toEqual([0]);
  });

  test('a line start follows every newline', () => {
    expect(computeLineStarts('ab\ncd\n\nef')).toEqual([0, 3, 6, 7]);
  });

  test('a lone carriage return does NOT start a line', () => {
    // `\r` stays part of the preceding line — the same rule the semantic-tag
    // parser applies, and the reason a CRLF file reports the columns an editor
    // shows rather than columns off by one.
    expect(computeLineStarts('ab\r\ncd')).toEqual([0, 4]);
  });
});

describe('offsetToPosition', () => {
  const text = 'alpha\nbeta\ngamma';
  const starts = computeLineStarts(text);

  test('maps an offset to its line and column', () => {
    expect(offsetToPosition(starts, 0)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(starts, 4)).toEqual({ line: 0, character: 4 });
    expect(offsetToPosition(starts, 6)).toEqual({ line: 1, character: 0 });
    expect(offsetToPosition(starts, 13)).toEqual({ line: 2, character: 2 });
  });

  test('the newline itself belongs to the line it ends', () => {
    expect(offsetToPosition(starts, 5)).toEqual({ line: 0, character: 5 });
  });

  test('an offset past the end clamps to the last line', () => {
    // An exclusive end offset legitimately sits one past the final character.
    expect(offsetToPosition(starts, text.length)).toEqual({ line: 2, character: 5 });
  });
});

describe('shiftPositionByLines', () => {
  test('moves the line and leaves the column alone', () => {
    expect(shiftPositionByLines({ line: 1, character: 7 }, 4)).toEqual({ line: 5, character: 7 });
  });

  test('a zero shift returns the position unchanged', () => {
    expect(shiftPositionByLines({ line: 3, character: 2 }, 0)).toEqual({ line: 3, character: 2 });
  });
});

describe('countLineBreaks', () => {
  test('counts the lines a front-matter block consumes', () => {
    expect(countLineBreaks('---\ntitle: x\n---\n')).toBe(3);
    expect(countLineBreaks('')).toBe(0);
  });
});
