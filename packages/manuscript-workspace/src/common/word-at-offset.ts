/**
 * Pure word-boundary helper shared by editor-driven AI modes.
 *
 * Theia's `TextEditor` exposes the cursor position and line content but has no
 * `getWordRangeAtPosition`, so word-context modes extract the word around the
 * cursor from the raw line text. Offsets are UTF-16 code-unit indices to match
 * LSP `Position.character`, which the editor uses.
 */

export interface WordAtOffset {
  /** The matched word text. */
  word: string;
  /** Inclusive start index within the line. */
  start: number;
  /** Exclusive end index within the line. */
  end: number;
}

/** Letters (any script), digits, and underscore make up a word. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

export function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch.length > 0 && WORD_CHAR.test(ch);
}

/**
 * Returns the word touching `offset` in `line`, or `undefined` when the cursor
 * sits between non-word characters. A cursor at index `offset` is between
 * `line[offset - 1]` and `line[offset]`; it touches a word when either side is
 * a word character, and the word then expands in both directions.
 */
export function wordAtOffset(line: string, offset: number): WordAtOffset | undefined {
  if (typeof line !== 'string' || !Number.isFinite(offset)) {
    return undefined;
  }

  const cursor = Math.max(0, Math.min(Math.floor(offset), line.length));
  if (!isWordChar(line[cursor - 1]) && !isWordChar(line[cursor])) {
    return undefined;
  }

  let start = cursor;
  while (start > 0 && isWordChar(line[start - 1])) {
    start--;
  }

  let end = cursor;
  while (end < line.length && isWordChar(line[end])) {
    end++;
  }

  if (start === end) {
    return undefined;
  }
  return { word: line.slice(start, end), start, end };
}
