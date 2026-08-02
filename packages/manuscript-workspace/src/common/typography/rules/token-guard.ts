/**
 * The ONE implementation of the "never touch code" invariant shared by every
 * typography rule (TASK-019, ISS-248).
 *
 * Before this module the same eight-line scan lived in seven places —
 * `capitalize-shared`, `quote-shared`, `space-after-punctuation`,
 * `spaced-hyphen-to-em-dash` (the point form) and `collapse-multiple-spaces`,
 * `no-space-before-punctuation`, `normalize-word-hyphenation` (the interval
 * form). That is the single most safety-critical predicate in the engine: a
 * rule that gets it wrong rewrites literal source inside the user's manuscript.
 * Seven copies means seven places to fix a bug and seven chances for them to
 * drift, so it lives here and every rule imports it.
 *
 * COORDINATES: rule code walks a line with 0-based character indices, while
 * {@link LineToken} columns are 1-based (`endColumn` exclusive). Both helpers
 * take 0-BASED indices and do the conversion internally — that translation was
 * itself duplicated in every copy.
 *
 * {@link TokenKind.Text} spans are prose and are ignored here; every other kind
 * (inline code, comments, and anything a future Monaco refinement adds) is
 * off-limits.
 */

import { LineSnapshot, TokenKind } from '../typography-types';

/**
 * True when the 0-based half-open character interval `[start, end)` overlaps any
 * non-prose span on `line`. This is the general form; {@link insideNonProseToken}
 * is the single-character special case.
 */
export function overlapsNonProseToken(line: LineSnapshot, start: number, end: number): boolean {
  for (const token of line.tokens) {
    if (token.kind === TokenKind.Text) {
      continue;
    }
    // Token columns are 1-based; convert to the 0-based char interval to compare.
    const tokenStart = token.startColumn - 1;
    const tokenEnd = token.endColumn - 1;
    if (start < tokenEnd && tokenStart < end) {
      return true;
    }
  }
  return false;
}

/** True when the 0-based index `col` falls inside any inline/code token span. */
export function insideNonProseToken(line: LineSnapshot, col: number): boolean {
  return overlapsNonProseToken(line, col, col + 1);
}
