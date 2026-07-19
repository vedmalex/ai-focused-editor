/**
 * Pure scope-range helpers for the granular Proofreading AI actions (ported from
 * ScanCheck's `MonacoEditorController` scope logic — `getParagraphScope`,
 * `getSentenceScope`/`findSentenceOffsetRange`, `getWordScope`).
 *
 * Everything here works on a plain text string + a UTF-16 cursor offset and
 * returns a `{ startOffset, endOffset }` half-open range (so it runs directly
 * under `bun test`, DOM/Monaco-free). The widget converts these offsets into
 * Monaco ranges via `model.getPositionAt` and keeps the Monaco-specific
 * selection/word handling on its side.
 */

import { wordAtOffset } from './word-at-offset';

/** A half-open `[startOffset, endOffset)` slice of a text buffer. */
export interface OffsetRange {
  startOffset: number;
  endOffset: number;
}

/** Clamp `offset` into `[0, length]`, coercing non-finite input to 0. */
function clampOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.min(Math.floor(offset), length));
}

/** Start offset of every line (index 0 always present; one entry per `\n`). */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Content end offset of line `index` (the position of its `\n`, or text end). */
function lineContentEnd(text: string, starts: number[], index: number): number {
  return index + 1 < starts.length ? starts[index + 1] - 1 : text.length;
}

/** The text of line `index`, excluding its trailing newline. */
function lineContent(text: string, starts: number[], index: number): string {
  return text.slice(starts[index], lineContentEnd(text, starts, index));
}

/** Index of the line containing `offset` (the last line whose start <= offset). */
function lineIndexAt(starts: number[], offset: number): number {
  let index = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= offset) {
      index = i;
    } else {
      break;
    }
  }
  return index;
}

/**
 * The blank-line-delimited paragraph around `pivotOffset`: from the cursor's
 * line, walk up while the previous line is non-blank and down while the next
 * line is non-blank (mirrors ScanCheck's `getParagraphScope`). The returned
 * range spans full lines (no trailing newline).
 */
export function paragraphOffsetRange(text: string, pivotOffset: number): OffsetRange {
  const safeText = typeof text === 'string' ? text : '';
  if (safeText.length === 0) {
    return { startOffset: 0, endOffset: 0 };
  }
  const pivot = clampOffset(pivotOffset, safeText.length);
  const starts = lineStartOffsets(safeText);
  const cursor = lineIndexAt(starts, pivot);

  let first = cursor;
  let last = cursor;
  while (first > 0 && lineContent(safeText, starts, first - 1).trim() !== '') {
    first -= 1;
  }
  while (last < starts.length - 1 && lineContent(safeText, starts, last + 1).trim() !== '') {
    last += 1;
  }
  return {
    startOffset: starts[first],
    endOffset: lineContentEnd(safeText, starts, last)
  };
}

/**
 * The sentence around `pivotOffset`: expand backwards to just after the nearest
 * `[.!?…]` or blank-line boundary, skip leading intra-line whitespace, then
 * expand forwards through the next terminal punctuation (or blank line), and
 * trim trailing whitespace. Direct port of ScanCheck's `findSentenceOffsetRange`
 * — a dotted abbreviation ends the scan at its dot (ScanCheck parity).
 */
export function sentenceOffsetRange(text: string, pivotOffset: number): OffsetRange {
  const safeText = typeof text === 'string' ? text : '';
  if (safeText.length === 0) {
    return { startOffset: 0, endOffset: 0 };
  }
  const pivot = clampOffset(pivotOffset, safeText.length);
  let startOffset = pivot;
  let endOffset = pivot;

  while (startOffset > 0) {
    const previousChar = safeText[startOffset - 1];
    if (/[.!?…]/u.test(previousChar)) {
      break;
    }
    if (previousChar === '\n' && safeText[startOffset] === '\n') {
      break;
    }
    startOffset -= 1;
  }
  while (
    startOffset < safeText.length &&
    /\s/u.test(safeText[startOffset]) &&
    safeText[startOffset] !== '\n'
  ) {
    startOffset += 1;
  }
  while (endOffset < safeText.length) {
    const currentChar = safeText[endOffset];
    if (/[.!?…]/u.test(currentChar)) {
      endOffset += 1;
      break;
    }
    if (currentChar === '\n' && safeText[endOffset + 1] === '\n') {
      break;
    }
    endOffset += 1;
  }
  while (endOffset > startOffset && /\s/u.test(safeText[endOffset - 1])) {
    endOffset -= 1;
  }
  return { startOffset, endOffset: Math.max(startOffset, endOffset) };
}

/**
 * The word touching `pivotOffset`, or `undefined` when the cursor sits between
 * non-word characters. Word characters never span a line break, so this is safe
 * to run over the whole buffer (delegates to the shared `wordAtOffset`).
 */
export function wordOffsetRange(text: string, pivotOffset: number): OffsetRange | undefined {
  const safeText = typeof text === 'string' ? text : '';
  const pivot = clampOffset(pivotOffset, safeText.length);
  const match = wordAtOffset(safeText, pivot);
  if (!match) {
    return undefined;
  }
  return { startOffset: match.start, endOffset: match.end };
}
