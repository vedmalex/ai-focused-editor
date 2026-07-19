import { describe, expect, test } from 'bun:test';
import {
  paragraphOffsetRange,
  sentenceOffsetRange,
  wordOffsetRange
} from './proofreading-scope';

/** Slice helper: the text a scope range selects. */
function slice(text: string, range: { startOffset: number; endOffset: number }): string {
  return text.slice(range.startOffset, range.endOffset);
}

describe('paragraphOffsetRange', () => {
  test('selects the whole blank-line-delimited paragraph around the cursor', () => {
    const text = 'First paragraph line one.\nStill first paragraph.\n\nSecond paragraph.';
    // cursor inside the second line of the first paragraph
    const range = paragraphOffsetRange(text, 30);
    expect(slice(text, range)).toBe('First paragraph line one.\nStill first paragraph.');
  });

  test('selects the second paragraph when the cursor is inside it', () => {
    const text = 'First paragraph.\n\nSecond paragraph line one.\nSecond line two.';
    const cursor = text.indexOf('line one');
    const range = paragraphOffsetRange(text, cursor);
    expect(slice(text, range)).toBe('Second paragraph line one.\nSecond line two.');
  });

  test('a single-line document is one paragraph', () => {
    const text = 'Only one line here.';
    const range = paragraphOffsetRange(text, 5);
    expect(slice(text, range)).toBe('Only one line here.');
  });

  test('cursor at the very start selects the first paragraph', () => {
    const text = 'Alpha line.\nBeta line.\n\nGamma.';
    const range = paragraphOffsetRange(text, 0);
    expect(slice(text, range)).toBe('Alpha line.\nBeta line.');
  });

  test('empty text yields an empty range', () => {
    expect(paragraphOffsetRange('', 0)).toEqual({ startOffset: 0, endOffset: 0 });
  });

  test('a whitespace-only line counts as a paragraph boundary', () => {
    const text = 'Para one.\n   \nPara two.';
    const range = paragraphOffsetRange(text, text.indexOf('two'));
    expect(slice(text, range)).toBe('Para two.');
  });
});

describe('sentenceOffsetRange', () => {
  test('selects a single sentence bounded by periods', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const cursor = text.indexOf('Second');
    const range = sentenceOffsetRange(text, cursor);
    expect(slice(text, range)).toBe('Second sentence.');
  });

  test('selects the leading sentence when the cursor is inside it', () => {
    const text = 'Hello world. Goodbye world.';
    const range = sentenceOffsetRange(text, 3);
    expect(slice(text, range)).toBe('Hello world.');
  });

  test('handles a question mark terminator', () => {
    const text = 'Are you sure? Yes indeed.';
    const range = sentenceOffsetRange(text, text.indexOf('Yes'));
    expect(slice(text, range)).toBe('Yes indeed.');
  });

  test('an ellipsis character terminates a sentence', () => {
    const text = 'Wait for it… Here it comes.';
    const range = sentenceOffsetRange(text, 3);
    expect(slice(text, range)).toBe('Wait for it…');
  });

  test('a dotted abbreviation ends the scan at its dot (ScanCheck parity)', () => {
    // The dot after "т" is treated as a terminator: the sentence stops there.
    const text = 'Смотри т. д. и прочее.';
    const range = sentenceOffsetRange(text, 0);
    expect(slice(text, range)).toBe('Смотри т.');
  });

  test('a blank line bounds a sentence with no terminal punctuation', () => {
    const text = 'A line without a period\n\nNext block.';
    const range = sentenceOffsetRange(text, 5);
    expect(slice(text, range)).toBe('A line without a period');
  });

  test('empty text yields an empty range', () => {
    expect(sentenceOffsetRange('', 0)).toEqual({ startOffset: 0, endOffset: 0 });
  });
});

describe('wordOffsetRange', () => {
  test('finds the word around the cursor in a multi-line buffer', () => {
    const text = 'alpha beta\ngamma delta';
    const cursor = text.indexOf('gamma') + 2;
    const range = wordOffsetRange(text, cursor)!;
    expect(slice(text, range)).toBe('gamma');
  });

  test('finds a word at the very start of the buffer', () => {
    const text = 'hello world';
    const range = wordOffsetRange(text, 0)!;
    expect(slice(text, range)).toBe('hello');
  });

  test('finds a word at the very end of the buffer', () => {
    const text = 'hello world';
    const range = wordOffsetRange(text, text.length)!;
    expect(slice(text, range)).toBe('world');
  });

  test('returns undefined between two non-word characters', () => {
    const text = 'a  b';
    // offset 2 sits between the two spaces
    expect(wordOffsetRange(text, 2)).toBeUndefined();
  });

  test('does not cross a line break', () => {
    const text = 'one\ntwo';
    // offset 3 is the newline boundary; the word before it is "one"
    const range = wordOffsetRange(text, 3)!;
    expect(slice(text, range)).toBe('one');
  });
});
