/**
 * Rule #36 — no space before punctuation (TASK-019 W1b). Deletes any run of
 * ASCII spaces that sits BETWEEN a prose character and a sentence-punctuation
 * mark (`,` `.` `;` `:` `!` `?` `…`), so `word ,` becomes `word,` and
 * `word  ;` becomes `word;`.
 *
 * It NEVER touches:
 *  - a code line (`ctx.lines[i].isCode`),
 *  - an inline-code span (`ctx.lines[i].tokens` of a non-prose kind),
 *  - the LEADING indentation of a line (the scan starts at the first prose
 *    character, exactly like #38), so a line that is only indentation plus a
 *    punctuation mark is left alone.
 *
 * PURE + IDEMPOTENT: after one application no space precedes any handled
 * punctuation mark, so a second pass yields no edits — the property the live
 * recursion guard leans on.
 *
 * `priority: PRIORITY_SPACING_PUNCTUATION` sits in the punctuation/spacing band, ABOVE #38
 * `collapse-multiple-spaces` (10): when both fire on the same multi-space run in
 * front of punctuation (`word  .`), #36 wins the conflict and DELETES the run
 * (`word.`) rather than collapsing it to a single space — the correct end state.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_SPACING_PUNCTUATION } from '../typography-priority';
import { overlapsNonProseToken } from './token-guard';

export const NO_SPACE_BEFORE_PUNCTUATION_ID = 'no-space-before-punctuation';

/** Sentence punctuation that must hug the preceding word (no leading space). */
const PUNCTUATION = new Set([',', '.', ';', ':', '!', '?', '…']);

/** 0-based index of the first non-space, non-tab character (the prose start). */
function leadingWhitespaceEnd(text: string): number {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i += 1;
  }
  return i;
}

export const noSpaceBeforePunctuationRule: TypographyRule = {
  id: NO_SPACE_BEFORE_PUNCTUATION_ID,
  descriptionKey: 'ai-focused-editor/typography/no-space-before-punctuation-desc',
  defaultEnabled: true,
  priority: PRIORITY_SPACING_PUNCTUATION,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const edits: TypographyEdit[] = [];
    for (const line of ctx.lines) {
      if (line.isCode) {
        continue;
      }
      const proseStart = leadingWhitespaceEnd(line.text);
      const text = line.text;
      // Scan from the first prose char, so leading indentation is never the run
      // we delete (any run found here has a prose character before it).
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
        const next = text[runEnd];
        // The run is deletable only when a handled punctuation mark follows it
        // immediately AND neither the run nor that mark sits in inline code.
        if (
          next !== undefined &&
          PUNCTUATION.has(next) &&
          !overlapsNonProseToken(line, runStart, runEnd + 1)
        ) {
          edits.push({
            ruleId: NO_SPACE_BEFORE_PUNCTUATION_ID,
            // Delete the whole space run (replace [runStart, runEnd) with ''). Columns are 1-based.
            range: {
              start: { line: line.lineNumber, column: runStart + 1 },
              end: { line: line.lineNumber, column: runEnd + 1 }
            },
            text: ''
          });
        }
        i = runEnd;
      }
    }
    return edits.length > 0 ? edits : null;
  }
};
