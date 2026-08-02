/**
 * Rule #44 — period after double space (TASK-019 W2, GitHub #44, OPTIONAL).
 * Replaces a run of two or more spaces that immediately follows sentence text
 * (a letter or digit) with a period and a single space: `погода␠␠` becomes
 * `погода.␠`, and `мысль␠␠продолжаю` becomes `мысль.␠продолжаю`. The
 * sentence-start capital in the issue's second example (`Продолжаю`) is NOT this
 * rule's job — it is produced by #39 `sentence-start-capital` (W3) composing on
 * top; #44 only inserts the period.
 *
 * OFF BY DEFAULT (the issue marks it optional / disabled by default): it guesses
 * a sentence boundary from a double space, which is a stylistic convention, not
 * a universal one.
 *
 * It NEVER triggers in:
 *  - a code line (`ctx.lines[i].isCode`) or leading indentation (the scan starts
 *    at the first prose character);
 *  - a table / alignment-sensitive row — conservatively, any line containing a
 *    `|` pipe is skipped (double spaces there are column alignment);
 *  - after anything that is not sentence text — the run must be preceded by a
 *    letter or digit, so `слово.␠␠` (already punctuated) and a leading gap are
 *    left alone.
 *
 * When enabled it out-ranks #38 `collapse-multiple-spaces` on the same run:
 * `priority: PRIORITY_SPACING_SENTENCE_BREAK` (> #38's 10) means the double space becomes `. ` rather than a
 * single space. With #44 off (the default) #38 collapses the run as usual.
 *
 * PURE + IDEMPOTENT: after one application the run is `. ` (a period then ONE
 * space), so no 2+-space run preceded by a letter/digit remains.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_SPACING_SENTENCE_BREAK } from '../typography-priority';

export const PERIOD_AFTER_DOUBLE_SPACE_ID = 'period-after-double-space';

/** True for a single ASCII letter or digit; the "preceded by sentence text" test. */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export const periodAfterDoubleSpaceRule: TypographyRule = {
  id: PERIOD_AFTER_DOUBLE_SPACE_ID,
  descriptionKey: 'ai-focused-editor/typography/period-after-double-space-desc',
  defaultEnabled: false,
  priority: PRIORITY_SPACING_SENTENCE_BREAK,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const edits: TypographyEdit[] = [];
    for (const line of ctx.lines) {
      if (line.isCode) {
        continue;
      }
      const text = line.text;
      // Table / alignment guard: a pipe means the double spaces are structural.
      if (text.includes('|')) {
        continue;
      }
      let i = 0;
      while (i < text.length) {
        if (text[i] !== ' ') {
          i += 1;
          continue;
        }
        const runStart = i;
        let runEnd = i + 1;
        while (runEnd < text.length && text[runEnd] === ' ') {
          runEnd += 1;
        }
        const runLength = runEnd - runStart;
        const before = text[runStart - 1];
        // Two-or-more spaces, preceded by sentence text (letter/digit). The
        // char before must exist and be a word char, which also excludes a
        // leading-indent run (nothing before) and a run after punctuation.
        if (runLength >= 2 && before !== undefined && LETTER_OR_DIGIT.test(before)) {
          edits.push({
            ruleId: PERIOD_AFTER_DOUBLE_SPACE_ID,
            // Replace the whole space run with a period + single space.
            range: {
              start: { line: line.lineNumber, column: runStart + 1 },
              end: { line: line.lineNumber, column: runEnd + 1 }
            },
            text: '. '
          });
        }
        i = runEnd;
      }
    }
    return edits.length > 0 ? edits : null;
  }
};
