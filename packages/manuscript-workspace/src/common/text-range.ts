/**
 * Position/range helpers shared by every consumer of `TextEditor.selection`.
 *
 * Theia's Monaco bridge maps `selection.start` to the selection ANCHOR and
 * `selection.end` to the ACTIVE cursor (see monaco-to-protocol-converter
 * `asSelection`): selecting upwards (`direction: 'rtl'`) yields `start` that
 * comes AFTER `end` in the document. Offset-splicing such a range duplicates
 * the selected region, and `getText` over it comes back empty — so every
 * consumer must normalize first.
 */

export interface TextPosition {
  readonly line: number;
  readonly character: number;
}

export interface TextRange {
  readonly start: TextPosition;
  readonly end: TextPosition;
}

/** Lexicographic (line, character) comparison. */
export function comparePositions(a: TextPosition, b: TextPosition): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

/**
 * Deep-copied range with `start` guaranteed to not come after `end` —
 * an upward (rtl) selection is swapped into document order.
 */
export function normalizeRange<T extends TextRange>(range: T): TextRange {
  const start = { line: range.start.line, character: range.start.character };
  const end = { line: range.end.line, character: range.end.character };
  return comparePositions(start, end) <= 0
    ? { start, end }
    : { start: end, end: start };
}
