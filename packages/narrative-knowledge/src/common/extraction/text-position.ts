/**
 * Offset → line/character arithmetic (TASK-022 WP-2).
 *
 * WHY THIS EXISTS AT ALL. The two prose parsers WP-2 reads hand back
 * coordinates in two different currencies: `parseSemanticMarkdown` returns
 * line/character positions, `parseWikiLinks` returns byte-free character
 * OFFSETS (`WikiLinkOffsetRange`). `EvidenceRef` speaks line/character, so one
 * of the two has to be converted, and the conversion needs a line table.
 *
 * WHY IT MIRRORS `semantic-markdown`'s PRIVATE COPY RATHER THAN IMPORTING IT.
 * The functions there are module-private and not exported, so there is nothing
 * to import. The implementation below is deliberately IDENTICAL in behaviour —
 * `\n`-only line breaks (a `\r` stays part of the preceding line, which is what
 * an editor column count wants), a half-open binary search, and a final
 * position that maps end-of-text to the last line — because a mention found by
 * one parser and a mention found by the other must be comparable coordinates in
 * the same file. Two subtly different line tables would put two mentions on the
 * same line at different line NUMBERS, and nothing downstream could tell.
 */

import type { EvidencePosition } from '../graph';

/**
 * Offsets at which each line of `text` starts, index 0 being the first line.
 *
 * Always at least one element: an empty string is one empty line, so an offset
 * of 0 has somewhere to land.
 */
export function computeLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }
  return lineStarts;
}

/**
 * Convert a character offset into a zero-based {@link EvidencePosition}.
 *
 * An offset past the end of the text clamps to the last line rather than
 * throwing: an exclusive end offset legitimately sits one past the final
 * character, and the alternative is every caller writing the same guard.
 */
export function offsetToPosition(lineStarts: readonly number[], offset: number): EvidencePosition {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle];
    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (offset < lineStart) {
      high = middle - 1;
    } else if (offset >= nextLineStart) {
      low = middle + 1;
    } else {
      return { line: middle, character: offset - lineStart };
    }
  }

  const lastLine = lineStarts.length - 1;
  return { line: lastLine, character: Math.max(0, offset - lineStarts[lastLine]) };
}

/**
 * Move a position down by `lines` whole lines, leaving its column alone.
 *
 * SOUND ONLY BECAUSE THE SHIFT IS ALWAYS LINE-ALIGNED. WP-2 parses a chapter's
 * BODY separately from its front matter (they are two different sources with
 * two different evidence kinds), and then has to report body coordinates in
 * whole-file terms. That is a pure line shift — and only because the front
 * matter fence always ends with a line break, so the body always begins at
 * column 0. `parseChapterFrontMatter`'s pattern closes on `---[ \t]*(?:\r?\n|$)`:
 * the `\r?\n` branch leaves the body at a line start, and the `$` branch leaves
 * the body EMPTY, which has no positions to shift. There is no third case, and
 * if one were introduced this function would start lying about columns.
 */
export function shiftPositionByLines(position: EvidencePosition, lines: number): EvidencePosition {
  return lines === 0 ? position : { line: position.line + lines, character: position.character };
}

/** Number of line breaks in `text` — i.e. how many whole lines it consumes. */
export function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      count++;
    }
  }
  return count;
}
