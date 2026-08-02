/**
 * Rule #38 — collapse multiple spaces (TASK-019 W1a probe rule). Replaces every
 * run of 2+ ASCII spaces INSIDE prose with a single space. This is the W1a
 * de-risk vehicle for code-skip: it must never touch
 *  - a code line (`ctx.lines[i].isCode`),
 *  - an inline-code span (`ctx.lines[i].tokens` of kind InlineCode/Code),
 *  - the LEADING indentation of a line (writers indent deliberately; and it is
 *    the boundary of an indented code block).
 *
 * PURE + IDEMPOTENT: after one application no eligible 2+-space run remains, so
 * a second pass yields no edits — the property the live recursion guard leans on.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_SPACING_WHITESPACE } from '../typography-priority';
import { overlapsNonProseToken } from './token-guard';

export const COLLAPSE_MULTIPLE_SPACES_ID = 'collapse-multiple-spaces';

/** 0-based index of the first non-space, non-tab character (the prose start). */
function leadingWhitespaceEnd(text: string): number {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i += 1;
  }
  return i;
}

/**
 * The rule as data. `priority: PRIORITY_SPACING_WHITESPACE` sits in the punctuation/spacing band (lowest),
 * below em-dash/quote (30-40) and capitalization (45-50) rules per §3.
 */
export const collapseMultipleSpacesRule: TypographyRule = {
  id: COLLAPSE_MULTIPLE_SPACES_ID,
  descriptionKey: 'ai-focused-editor/typography/collapse-multiple-spaces-desc',
  defaultEnabled: true,
  priority: PRIORITY_SPACING_WHITESPACE,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const edits: TypographyEdit[] = [];
    for (const line of ctx.lines) {
      if (line.isCode) {
        continue;
      }
      const proseStart = leadingWhitespaceEnd(line.text);
      const text = line.text;
      let i = proseStart;
      while (i < text.length) {
        if (text[i] !== ' ') {
          i += 1;
          continue;
        }
        // Measure the space run [runStart, runEnd).
        const runStart = i;
        let runEnd = i + 1;
        while (runEnd < text.length && text[runEnd] === ' ') {
          runEnd += 1;
        }
        const runLength = runEnd - runStart;
        if (runLength >= 2 && !overlapsNonProseToken(line, runStart, runEnd)) {
          // Replace the whole run with a single space. Columns are 1-based.
          edits.push({
            ruleId: COLLAPSE_MULTIPLE_SPACES_ID,
            range: {
              start: { line: line.lineNumber, column: runStart + 1 },
              end: { line: line.lineNumber, column: runEnd + 1 }
            },
            text: ' '
          });
        }
        i = runEnd;
      }
    }
    return edits.length > 0 ? edits : null;
  }
};
