/**
 * The pure typography DISPATCH engine (TASK-019 §1.6). It owns no Monaco and no
 * side effects: given a context and the set of enabled rule ids, it runs each
 * enabled rule, then deterministically resolves conflicts and drops any edit
 * that would land in code — returning a clean, ordered edit list the browser
 * seam applies verbatim.
 *
 * Determinism (UR-003) is the headline property: the output MUST NOT depend on
 * the order rules were registered/bound. Two rules whose edits overlap are
 * resolved by (1) higher `priority`, then (2) lexicographically smaller `id`;
 * the losing, intersecting edit is dropped. This is why acceptance is driven by
 * an IMPORTANCE order (priority desc, id asc) rather than document order — a
 * lower-priority edit can never evict a higher-priority one merely by starting
 * earlier in the line.
 */

import {
  LineSnapshot,
  Position,
  TextRange,
  TokenKind,
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from './typography-types';

/** DI token for the resolved engine (value/type declaration-merge). */
export const TypographyEngine = Symbol('TypographyEngine');

/** The engine contract the browser seam depends on. */
export interface TypographyEngine {
  /**
   * Run every rule whose id is in `enabledIds`, resolve conflicts, drop
   * in-code edits, and return the surviving edits ordered by document
   * position. Pure — never mutates `ctx`.
   */
  computeEdits(ctx: TypographyContext, enabledIds: ReadonlySet<string>): TypographyEdit[];
}

/** Lexicographic (line, then column) comparison of two 1-based positions. */
export function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.column - b.column;
}

/**
 * True when two ranges share any span. Touching edges do NOT overlap
 * (`[1,3)` and `[3,5)` are disjoint) — EXCEPT two zero-length insertions at the
 * very same point, which DO conflict (both want that single caret slot).
 */
export function rangesOverlap(a: TextRange, b: TextRange): boolean {
  const aEmpty = comparePositions(a.start, a.end) === 0;
  const bEmpty = comparePositions(b.start, b.end) === 0;
  if (aEmpty && bEmpty) {
    return comparePositions(a.start, b.start) === 0;
  }
  return comparePositions(a.start, b.end) < 0 && comparePositions(b.start, a.end) < 0;
}

/**
 * Drop every edit that would land past `lastEditableLine` (1-based, inclusive).
 *
 * THE SAFETY VALVE FOR LOOK-AHEAD (F-CR2-1). A driver's context window doubles
 * as its EDITABLE region — every rule iterates `ctx.lines` and may emit an edit
 * on any line it can see, which is exactly the coupling ISS-272 is about. So
 * widening the window downward to satisfy `requiredLookaheadLines` would, on its
 * own, hand every enabled rule the right to rewrite lines BELOW the one the user
 * just touched: type a character on line 10 and line 11's unrelated `слово -
 * слово` quietly becomes an em dash. That is a new, unrequested write surface —
 * a worse defect than the one the look-ahead fixes.
 *
 * Passing the computed edits through here decouples the two: the snapshot grows,
 * the WRITE SET DOES NOT. The lines a pass may modify stay byte-identical to what
 * they were before the widening, so the extra lines are pure context — visible to
 * a guard, untouchable by an edit.
 *
 * DELIBERATELY ONE-DIRECTIONAL: it clamps only the FORWARD end. The look-BACK
 * lines have always been editable (that predates this change and is ISS-272's
 * subject, not this fix's), so clamping them too would be an unrelated behaviour
 * change smuggled in under a bug fix.
 *
 * An edit is kept only when its WHOLE range is in bounds — a hypothetical
 * multi-line edit starting in range and ending past it is dropped, not truncated.
 */
export function dropEditsBeyondLine(
  edits: readonly TypographyEdit[],
  lastEditableLine: number
): TypographyEdit[] {
  return edits.filter(edit =>
    edit.range.start.line <= lastEditableLine && edit.range.end.line <= lastEditableLine
  );
}

interface Candidate {
  readonly edit: TypographyEdit;
  readonly priority: number;
  readonly id: string;
}

/**
 * Default engine: constructed with the full rule set (from the
 * `ContributionProvider`); `computeEdits` filters to the enabled subset per
 * call, so a preference toggle never requires re-binding.
 */
export class DefaultTypographyEngine implements TypographyEngine {
  private readonly rulesById: ReadonlyMap<string, TypographyRule>;

  constructor(rules: readonly TypographyRule[]) {
    const map = new Map<string, TypographyRule>();
    for (const rule of rules) {
      // Last binding wins on a duplicate id; ids are meant to be unique, this
      // just keeps the map well-defined rather than throwing at container init.
      map.set(rule.id, rule);
    }
    this.rulesById = map;
  }

  computeEdits(ctx: TypographyContext, enabledIds: ReadonlySet<string>): TypographyEdit[] {
    const candidates: Candidate[] = [];
    for (const id of enabledIds) {
      const rule = this.rulesById.get(id);
      if (!rule) {
        continue;
      }
      const produced = rule.apply(ctx);
      if (!produced) {
        continue;
      }
      for (const edit of produced) {
        // Defence in depth: a rule *should* skip code itself, but the engine is
        // the last line — never let an edit touch a code line or inline span.
        if (this.intersectsCode(ctx, edit.range)) {
          continue;
        }
        candidates.push({ edit, priority: rule.priority, id: rule.id });
      }
    }

    // Acceptance in importance order (priority desc, id asc, then start asc for
    // a fully-stable tie-break): the highest-priority edits claim their span
    // first; any later edit that intersects an accepted one is dropped. This is
    // independent of rule registration order -> deterministic (UR-003).
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      if (a.id !== b.id) {
        return a.id < b.id ? -1 : 1;
      }
      return comparePositions(a.edit.range.start, b.edit.range.start);
    });

    const accepted: TypographyEdit[] = [];
    for (const candidate of candidates) {
      if (accepted.some(other => rangesOverlap(candidate.edit.range, other.range))) {
        continue;
      }
      accepted.push(candidate.edit);
    }

    // Emit in document order so the seam applies top-to-bottom.
    accepted.sort((a, b) => comparePositions(a.range.start, b.range.start));
    return accepted;
  }

  /** True when `range` touches any code line or inline-code/comment span in the window. */
  private intersectsCode(ctx: TypographyContext, range: TextRange): boolean {
    for (let line = range.start.line; line <= range.end.line; line++) {
      const snapshot = this.lineAt(ctx, line);
      if (!snapshot) {
        continue;
      }
      if (snapshot.isCode) {
        return true;
      }
      for (const token of snapshot.tokens) {
        if (token.kind === TokenKind.Text) {
          continue;
        }
        // Reduce the edit's span to this line's column interval, then test the
        // token interval [startColumn, endColumn) for overlap.
        const editStartCol = line === range.start.line ? range.start.column : 1;
        const editEndCol = line === range.end.line ? range.end.column : Number.MAX_SAFE_INTEGER;
        const overlaps = editStartCol < token.endColumn && token.startColumn < editEndCol;
        // A zero-width insertion exactly at a token boundary is not "inside" it.
        const zeroWidthAtEdge = editStartCol === editEndCol
          && (editStartCol === token.startColumn || editStartCol === token.endColumn);
        if (overlaps && !zeroWidthAtEdge) {
          return true;
        }
      }
    }
    return false;
  }

  private lineAt(ctx: TypographyContext, lineNumber: number): LineSnapshot | undefined {
    // Window lines are contiguous but may not start at line 1; index by number.
    for (const snapshot of ctx.lines) {
      if (snapshot.lineNumber === lineNumber) {
        return snapshot;
      }
    }
    return undefined;
  }
}
