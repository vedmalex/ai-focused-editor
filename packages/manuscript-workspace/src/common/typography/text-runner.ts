/**
 * Pure, Monaco-free driver that runs the typography engine over a whole document
 * given ONLY its text (TASK-019 W2, §2 multi-file batch). This is the third
 * driver over the one rule set — live (Monaco), open-buffer batch (Monaco), and
 * this text driver for UNOPENED files read through the FileService. Because it
 * touches no editor it is fully DST-testable.
 *
 * The code mask is the pure detector from {@link computeCodeMask} (the same one
 * the browser adapter uses); Monaco token refinement is intentionally absent —
 * §1.4 makes the pure inline-backtick mask the fail-safe source of truth, so an
 * unopened file needs no editor to skip code correctly.
 */

import { computeCodeMask } from './code-mask';
import { TypographyEngine } from './typography-engine';
import {
  LineSnapshot,
  LineToken,
  TokenKind,
  TypographyContext,
  TypographyEdit
} from './typography-types';

/**
 * Safety bound on the fixpoint loop — identical intent to the batch service's
 * bound: idempotent rules converge in one or two passes; this only stops a
 * hypothetical non-converging rule pair from spinning.
 */
export const TEXT_RUNNER_MAX_PASSES = 8;

export interface TextRunResult {
  /** The transformed document text. */
  readonly text: string;
  /** Total edits applied across all passes (0 ⇒ text is unchanged). */
  readonly editCount: number;
  /** How many passes actually ran (≤ `maxPasses`). */
  readonly passes: number;
  /**
   * FALSE when the loop hit {@link TEXT_RUNNER_MAX_PASSES} with the last pass
   * still producing edits — i.e. the rule set did NOT reach a fixpoint and
   * `text` is an INTERMEDIATE state, not a finished one.
   *
   * Without this flag a non-converging rule pair stopped silently at pass 8 and
   * returned a healthy-looking `editCount`, so a half-transformed document was
   * indistinguishable from a clean success (QA/ISS-255). Callers that report an
   * outcome to the user MUST NOT present `converged: false` as a plain success.
   */
  readonly converged: boolean;
}

/** Build a whole-document {@link TypographyContext} from raw text lines. */
export function buildTextContext(lines: readonly string[], locale: string): TypographyContext {
  const mask = computeCodeMask(lines);
  const snapshots: LineSnapshot[] = lines.map((text, idx) => {
    const isCode = mask.isCode[idx] ?? false;
    const tokens: LineToken[] = isCode
      ? []
      : mask.inlineRanges[idx].map(range => ({
        startColumn: range.startCol + 1,
        endColumn: range.endCol + 1,
        kind: TokenKind.InlineCode
      }));
    return { lineNumber: idx + 1, text, tokens, isCode };
  });
  const lastLine = lines.length;
  const lastColumn = lines.length > 0 ? lines[lastLine - 1].length + 1 : 1;
  return {
    lines: snapshots,
    changedRange: {
      start: { line: 1, column: 1 },
      end: { line: Math.max(1, lastLine), column: lastColumn }
    },
    cursor: { line: 1, column: 1 },
    locale,
    trigger: 'batch'
  };
}

/** 0-based absolute offset of a 1-based (line, column) inside `lines` (\n-joined). */
function lineColumnToOffset(lines: readonly string[], line: number, column: number): number {
  let offset = 0;
  for (let i = 0; i < line - 1; i++) {
    offset += lines[i].length + 1; // +1 for the '\n' separator
  }
  return offset + (column - 1);
}

/**
 * Apply engine-ordered, non-overlapping `edits` to `text`. Offsets are computed
 * on `lines` (the same `text.split('\n')` the context was built from) and spliced
 * from the END backwards so earlier offsets stay valid — this preserves any
 * `\r` in a `\r\n` document because the ORIGINAL string is spliced, not a
 * re-joined line array.
 */
export function applyEditsToText(text: string, lines: readonly string[], edits: readonly TypographyEdit[]): string {
  const withOffsets = edits.map(edit => ({
    startOffset: lineColumnToOffset(lines, edit.range.start.line, edit.range.start.column),
    endOffset: lineColumnToOffset(lines, edit.range.end.line, edit.range.end.column),
    text: edit.text
  }));
  withOffsets.sort((a, b) => b.startOffset - a.startOffset);
  let result = text;
  for (const op of withOffsets) {
    result = result.slice(0, op.startOffset) + op.text + result.slice(op.endOffset);
  }
  return result;
}

/**
 * Run every enabled rule over `text` to a fixpoint and return the transformed
 * text plus the total edit count. Pure: no editor, no I/O. An empty enabled set
 * is a no-op.
 */
export function runTypographyOnText(
  engine: TypographyEngine,
  text: string,
  enabledIds: ReadonlySet<string>,
  locale: string,
  maxPasses: number = TEXT_RUNNER_MAX_PASSES
): TextRunResult {
  if (enabledIds.size === 0) {
    return { text, editCount: 0, passes: 0, converged: true };
  }
  let current = text;
  let editCount = 0;
  let passes = 0;
  // `converged` stays false until a pass produces ZERO edits — the only proof
  // the fixpoint was actually reached. Falling out of the loop on the pass
  // budget therefore reports `converged: false` (ISS-255).
  let converged = false;
  for (let pass = 0; pass < maxPasses; pass++) {
    const lines = current.split('\n');
    const context = buildTextContext(lines, locale);
    const edits = engine.computeEdits(context, enabledIds);
    passes = pass + 1;
    if (edits.length === 0) {
      converged = true;
      break;
    }
    current = applyEditsToText(current, lines, edits);
    editCount += edits.length;
  }
  return { text: current, editCount, passes, converged };
}
