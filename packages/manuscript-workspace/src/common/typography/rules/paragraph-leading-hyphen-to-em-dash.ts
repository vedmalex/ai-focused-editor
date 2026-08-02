/**
 * Rule #40 — paragraph-leading hyphen to em dash (TASK-019 W2, GitHub #40).
 * Converts a hyphen at the very START of a prose line into an em dash (`—`,
 * U+2014), keeping the trailing space: `- Привет.` becomes `— Привет.` — the
 * Russian dialogue / paragraph dash.
 *
 * DISAMBIGUATION FROM A MARKDOWN LIST (the issue's one hard constraint: "do not
 * convert Markdown list markers when the current block is a list"). A leading
 * `- ` is syntactically also a bullet, so the rule is CONSERVATIVE and only
 * converts a hyphen that looks like a lone dialogue line, NOT a list item:
 *  - the hyphen must be at column 1 (no leading indentation — an indented `- `
 *    is almost always a nested list);
 *  - it must be a SINGLE hyphen followed by exactly one space then content
 *    (`- x`), never `-- `, `---`, `-  `, or a bare `-`;
 *  - NEITHER neighbour line visible in the context window may itself be a list
 *    item (`- `, `* `, `+ `, or `1. `). Two adjacent hyphen lines read as a
 *    bullet list and are left alone. BOTH neighbours are declared as data
 *    (`requiredLookbackLines: 1` + `requiredLookaheadLines: 1`) so every driver
 *    that builds a window actually hands them over — before the look-ahead
 *    declaration existed (F-CR2-1) the live seam's window ended at the changed
 *    line, the successor was never in `ctx.lines`, and the forward half of this
 *    guard silently did nothing.
 * The trade-off is deliberate: a false NEGATIVE (a real dialogue dash left as a
 * hyphen, easily fixed by hand) is far cheaper than a false POSITIVE (silently
 * rewriting a bullet list). For the same reason the rule is OFF by default.
 *
 * PURE + IDEMPOTENT: after one application the first character is an em dash, so
 * a second pass finds no leading hyphen.
 *
 * `priority: PRIORITY_EM_DASH` — the em-dash/quote band (§3).
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_EM_DASH } from '../typography-priority';

export const PARAGRAPH_LEADING_HYPHEN_TO_EM_DASH_ID = 'paragraph-leading-hyphen-to-em-dash';

/** The em dash the rule inserts (U+2014). */
const EM_DASH = '—';

/** True when `text` begins with a Markdown list marker (bullet or ordered). */
function looksLikeListItem(text: string | undefined): boolean {
  if (text === undefined) {
    return false;
  }
  // `- x`, `* x`, `+ x`, or `1. x` / `2) x`, allowing leading indentation.
  return /^\s*([-*+]\s|\d+[.)]\s)/.test(text);
}

export const paragraphLeadingHyphenToEmDashRule: TypographyRule = {
  id: PARAGRAPH_LEADING_HYPHEN_TO_EM_DASH_ID,
  descriptionKey: 'ai-focused-editor/typography/paragraph-leading-hyphen-to-em-dash-desc',
  defaultEnabled: false,
  priority: PRIORITY_EM_DASH,
  // Reads the PRECEDING line (see the LOOK-BACK note above).
  requiredLookbackLines: 1,
  // …and the FOLLOWING one — the other half of the same neighbour guard
  // (F-CR2-1). Undeclared, this half was dead in the live seam: the window ended
  // at the changed line, so `ctx.lines[idx + 1]` was always `undefined` and
  // `- пункт` typed directly ABOVE an existing list was converted anyway.
  requiredLookaheadLines: 1,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const edits: TypographyEdit[] = [];
    for (let idx = 0; idx < ctx.lines.length; idx++) {
      const line = ctx.lines[idx];
      if (line.isCode) {
        continue;
      }
      const text = line.text;
      // Column 1 must be a hyphen, column 2 a single space, column 3 real
      // content (not another space, not another hyphen).
      if (text[0] !== '-' || text[1] !== ' ') {
        continue;
      }
      const third = text[2];
      if (third === undefined || third === ' ' || third === '-') {
        continue;
      }
      // Neighbour-based list guard: if the line directly above or below (as seen
      // in the window) is itself a list item, treat THIS as a list too.
      const prev = ctx.lines[idx - 1];
      const next = ctx.lines[idx + 1];
      const prevIsAdjacent = prev !== undefined && prev.lineNumber === line.lineNumber - 1;
      const nextIsAdjacent = next !== undefined && next.lineNumber === line.lineNumber + 1;
      if ((prevIsAdjacent && looksLikeListItem(prev.text)) || (nextIsAdjacent && looksLikeListItem(next.text))) {
        continue;
      }
      edits.push({
        ruleId: PARAGRAPH_LEADING_HYPHEN_TO_EM_DASH_ID,
        // Replace the leading hyphen (column 1) only; the space stays.
        range: {
          start: { line: line.lineNumber, column: 1 },
          end: { line: line.lineNumber, column: 2 }
        },
        text: EM_DASH
      });
    }
    return edits.length > 0 ? edits : null;
  }
};
