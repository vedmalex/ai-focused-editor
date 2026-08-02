/**
 * Batch typography runner (TASK-019 W1b, UR-006). Runs the SAME pure engine and
 * the SAME enabled-rule set the live seam uses, but over a whole open buffer (or
 * a selection) at the user's explicit request — and collapses the entire run
 * into ONE discrete undo element.
 *
 * Two properties matter:
 *  - ONE UNDO STEP: the whole (possibly multi-pass) run is bracketed by a single
 *    `pushStackElement`…`pushStackElement` pair via
 *    {@link TypographyMonacoAdapter.applyEditsWithoutBoundary}, so a single
 *    Ctrl+Z reverts the batch wholesale — unlike the incremental live path where
 *    each keystroke's fix is its own step.
 *  - SCOPE-FREE: the chapter/all-md scope gate does NOT apply here (the user
 *    invoked the command deliberately on THIS buffer). Only the per-rule enable
 *    toggles are respected, via `enabledIds`.
 *
 * The loop iterates to a fixpoint (bounded by {@link BATCH_MAX_PASSES}) because,
 * although every rule is individually idempotent, one rule's output can unlock
 * another's input on the next pass; the idempotence contract guarantees the loop
 * terminates (a clean pass yields no edits).
 */

import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { inject, injectable, named } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { TypographyEngine, dropEditsBeyondLine } from '../../common/typography/typography-engine';
import { runTypographyOnText, TextRunResult } from '../../common/typography/text-runner';
import { resolveRequiredLookahead } from '../../common/typography/typography-rules';
import { TypographyRule } from '../../common/typography/typography-types';
import { TypographyMonacoAdapter } from './typography-monaco-adapter';

/**
 * Safety bound on the batch fixpoint loop. Idempotent rules converge in one or
 * two passes; this only guards against a hypothetical non-converging rule pair
 * (a rule-authoring bug), so the command can never hang the UI.
 */
export const BATCH_MAX_PASSES = 8;

/**
 * What an open-buffer batch run OBSERVED, not just how much it wrote.
 *
 * `applied` alone made a run that hit {@link BATCH_MAX_PASSES} indistinguishable
 * from one that reached a fixpoint — the caller reported "applied N fix(es)" as a
 * clean success either way (QA/ISS-259). That is exactly the silence already
 * rejected for the multi-file path (ISS-255), so the two drivers now expose the
 * SAME pair of observables and callers MUST NOT present `converged: false` as a
 * plain success. Mirrors {@link TextRunResult}'s `passes`/`converged`.
 */
export interface BatchRunResult {
  /** Total edits written across all passes. */
  readonly applied: number;
  /** How many passes actually ran (≤ {@link BATCH_MAX_PASSES}). */
  readonly passes: number;
  /**
   * FALSE when the loop stopped with work still outstanding — either the pass
   * budget ran out while the last pass was still producing edits, or the model
   * refused a write. The buffer is then an INTERMEDIATE state, not a finished one.
   */
  readonly converged: boolean;
}

export interface BatchRunOptions {
  /** The rule ids currently enabled (master + per-rule toggles), same as live. */
  readonly enabledIds: ReadonlySet<string>;
  /** BCP-47-ish locale tag driving locale-aware rules. */
  readonly locale: string;
  /** 1-based inclusive first line; omitted → line 1 (whole document). */
  readonly startLine?: number;
  /** 1-based inclusive last line; omitted → the last line (whole document). */
  readonly endLine?: number;
}

@injectable()
export class TypographyBatchService {
  @inject(TypographyEngine)
  protected readonly engine!: TypographyEngine;

  @inject(TypographyMonacoAdapter)
  protected readonly adapter!: TypographyMonacoAdapter;

  /**
   * The bound rule set, read for its DECLARED look-ahead only (F-CR2-1) — the
   * rules themselves are still run by the injected engine. Same provider the
   * live seam consults, so the two windows are derived from one source.
   */
  @inject(ContributionProvider) @named(TypographyRule)
  protected readonly ruleProvider!: ContributionProvider<TypographyRule>;

  /**
   * Apply every enabled rule over the requested line range (or the whole
   * document) as ONE undo element. Returns the edit count TOGETHER WITH the
   * `passes`/`converged` observables (see {@link BatchRunResult}) — a caller that
   * only reads `applied` cannot tell a finished run from a truncated one.
   *
   * ZERO LOOK-BACK, DELIBERATELY (F-CR-4). The context window here starts at
   * `startLine` exactly, so — unlike the live seam, which widens the window by
   * `resolveRequiredLookback` — a selection run gives look-back-declaring rules
   * NO predecessor line. This is not an oversight:
   *
   *  - the window is also the EDITABLE region, so extending it upward would let
   *    a run over a selection rewrite lines the user did not select;
   *  - the rules that want look-back are conservative when they don't get it
   *    (`paragraph-start-capital` emits nothing rather than guess), so the
   *    asymmetry costs a MISSED fix, never a wrong one.
   *
   * The whole-file path is unaffected (`startLine` is 1, where those rules treat
   * line 1 as a paragraph start by definition). The visible consequence is
   * narrow: running the command over a SELECTION does not capitalize the first
   * selected line (ISS-272).
   *
   * LOOK-AHEAD IS HONOURED, AND THE ASYMMETRY IS THE POINT (F-CR2-1). The window
   * DOES extend past `endLine` by `resolveRequiredLookahead`, because the
   * "costs a missed fix, never a wrong one" argument above does NOT hold in the
   * forward direction. A rule denied its look-back sees no predecessor and stays
   * silent; a rule denied its look-AHEAD sees `undefined` and reads it as "no
   * list below", so it emits a WRONG edit. Selecting a block that ENDS on
   * `- пункт` with a bullet list continuing on the next line would otherwise
   * convert that bullet into an em dash — the same defect the live seam had.
   *
   * The ISS-272 objection is answered rather than ignored: the extra lines are
   * CONTEXT ONLY. Every computed edit goes through `dropEditsBeyondLine`, so the
   * set of lines this run may WRITE is still exactly `[startLine, endLine]` — a
   * selection run cannot touch a line outside the selection, before or after
   * this change. That is the context/editable separation the paragraph above
   * says "would be the right fix", now built — but applied to the FORWARD end
   * only. Extending it upward is what would fix the ISS-272 first-line case, and
   * is still a deliberate behaviour change left to that task.
   */
  applyTo(model: monaco.editor.ITextModel, options: BatchRunOptions): BatchRunResult {
    // Nothing to do is a CONVERGED outcome: there is no outstanding work, so a
    // caller must not warn about it.
    if (options.enabledIds.size === 0) {
      return { applied: 0, passes: 0, converged: true };
    }
    const startLine = Math.max(1, options.startLine ?? 1);
    if (startLine > model.getLineCount()) {
      return { applied: 0, passes: 0, converged: true };
    }

    let applied = 0;
    let passes = 0;
    // Stays false until a pass produces ZERO edits — the only proof the fixpoint
    // was reached. Falling out of the loop on the pass budget, or on a refused
    // write, therefore reports `converged: false` (ISS-259, mirroring ISS-255).
    let converged = false;
    // ONE undo boundary around the whole run. Two adjacent pushStackElement
    // calls with no write between them create no undo element, so a clean
    // document (zero edits) leaves the undo stack untouched.
    const lookahead = resolveRequiredLookahead(this.ruleProvider.getContributions(), options.enabledIds);
    model.pushStackElement();
    try {
      for (let pass = 0; pass < BATCH_MAX_PASSES; pass++) {
        const lineCount = model.getLineCount();
        const endLine = Math.min(lineCount, options.endLine ?? lineCount);
        if (startLine > endLine) {
          // The requested range collapsed away — no outstanding work.
          converged = true;
          break;
        }
        const context = this.adapter.buildContext(model, {
          changedRange: {
            start: { line: startLine, column: 1 },
            end: { line: endLine, column: model.getLineMaxColumn(endLine) }
          },
          cursor: { line: startLine, column: 1 },
          trigger: 'batch',
          locale: options.locale,
          windowStart: startLine,
          // Context only past `endLine` (the adapter clamps to the document).
          windowEnd: endLine + lookahead
        });
        // …and the write set is clamped straight back to `endLine`, so the
        // selection stays the editable region. Clamping BEFORE the convergence
        // check also keeps the fixpoint honest: a rule that keeps proposing an
        // out-of-range edit every pass would otherwise never let `edits` reach
        // zero and the run would report `converged: false` forever.
        const edits = dropEditsBeyondLine(
          this.engine.computeEdits(context, options.enabledIds),
          endLine
        );
        passes = pass + 1;
        if (edits.length === 0) {
          converged = true;
          break;
        }
        if (!this.adapter.applyEditsWithoutBoundary(model, edits)) {
          // The model refused the write: pending edits were computed and NOT
          // applied, so the run is unfinished — never report this as success.
          break;
        }
        applied += edits.length;
      }
    } finally {
      model.pushStackElement();
    }
    return { applied, passes, converged };
  }

  /**
   * Run every enabled rule over a raw document STRING (no open editor), for the
   * multi-file batch over UNOPENED files (§2). Delegates to the pure
   * {@link runTypographyOnText} with the SAME injected engine the live/open-buffer
   * paths use, so all drivers share one rule set. Returns the transformed text
   * and the edit count; the caller decides whether to write (behind the
   * ISS-219 preview/confirm gate).
   */
  runOnText(text: string, options: { readonly enabledIds: ReadonlySet<string>; readonly locale: string }): TextRunResult {
    return runTypographyOnText(this.engine, text, options.enabledIds, options.locale);
  }
}
