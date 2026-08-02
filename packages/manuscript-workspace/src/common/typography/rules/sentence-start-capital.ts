/**
 * Rule #39 — sentence-start capital (TASK-019 W3, GitHub #39). Capitalizes the
 * first alphabetic character after sentence-ending punctuation and a space:
 * `Привет. мир.` → `Привет. Мир.`, `Ты пришёл? да.` → `Ты пришёл? Да.`,
 * `Вот это да! невероятно.` → `Вот это да! Невероятно.`.
 *
 * IN-LINE ONLY. The boundary is a sentence mark (`. ! ? …`) followed by at least
 * one space then a lower-case letter, all on the SAME line. Cross-line
 * continuation (a bare line break) is left to #31 (paragraph start) so a
 * soft-wrapped line is never wrongly capitalized.
 *
 * CONSERVATIVE boundary — RICH NEGATIVES (UR-005). For the ambiguous `.` the
 * rule does NOT capitalize when:
 *  - the char before the period is itself a `.` (an abbreviation chain / ellipsis
 *    like `т.е.`), or
 *  - the word before the period is a single letter (an initial: `И. Петров`,
 *    `и. о.`), or
 *  - that word is a known abbreviation (`см. рис`, `т. е.`, `стр. текст`).
 * `!`, `?`, `…` are unambiguous sentence enders and carry no abbreviation guard.
 * A NUMBER (`3.14`, `стр. 5`) is skipped for free: the next char is a digit, and
 * only LETTERS are capitalized. Requiring a space also excludes the spaceless
 * `т.е.` outright.
 *
 * SKIPS code lines and inline-code spans. `priority: PRIORITY_CAPITALIZATION_START`. PURE + IDEMPOTENT
 * (after one pass the letter is upper-case, so the guard finds nothing).
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_CAPITALIZATION_START } from '../typography-priority';
import {
  isLower,
  isWhitespace,
  KNOWN_ABBREVIATIONS,
  precedingWord,
  SENTENCE_END_PUNCTUATION,
  toLocaleUpper
} from './capitalize-shared';
import { insideNonProseToken } from './token-guard';

export const SENTENCE_START_CAPITAL_ID = 'sentence-start-capital';

export const sentenceStartCapitalRule: TypographyRule = {
  id: SENTENCE_START_CAPITAL_ID,
  descriptionKey: 'ai-focused-editor/typography/sentence-start-capital-desc',
  defaultEnabled: true,
  priority: PRIORITY_CAPITALIZATION_START,
  localeAware: true,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const edits: TypographyEdit[] = [];
    for (const line of ctx.lines) {
      if (line.isCode) {
        continue;
      }
      const text = line.text;
      for (let i = 0; i < text.length; i++) {
        const mark = text[i];
        if (!SENTENCE_END_PUNCTUATION.has(mark)) {
          continue;
        }
        // Require at least one space between the mark and the next letter.
        if (!isWhitespace(text[i + 1])) {
          continue;
        }
        let j = i + 1;
        while (j < text.length && isWhitespace(text[j])) {
          j++;
        }
        const ch = text[j];
        if (!isLower(ch)) {
          continue;
        }
        // Abbreviation / initial guard for the ambiguous period.
        if (mark === '.' && !isSentenceEndingPeriod(text, i)) {
          continue;
        }
        if (insideNonProseToken(line, i) || insideNonProseToken(line, j)) {
          continue;
        }
        const upper = toLocaleUpper(ch, ctx.locale);
        if (upper === ch) {
          continue;
        }
        edits.push({
          ruleId: SENTENCE_START_CAPITAL_ID,
          range: {
            start: { line: line.lineNumber, column: j + 1 },
            end: { line: line.lineNumber, column: j + 2 }
          },
          text: upper
        });
      }
    }
    return edits.length > 0 ? edits : null;
  }
};

/**
 * True when the period at 0-based index `i` reads as a real sentence end rather
 * than part of an abbreviation or an initial: not preceded by another `.`, and
 * the word before it is neither a single letter nor a known abbreviation.
 */
function isSentenceEndingPeriod(text: string, i: number): boolean {
  if (text[i - 1] === '.') {
    return false;
  }
  const word = precedingWord(text, i);
  if (word.length <= 1) {
    return false;
  }
  return !KNOWN_ABBREVIATIONS.has(word.toLowerCase());
}
