/**
 * Rule #35 — closing straight quote to locale-aware quote (TASK-019 W2, GitHub
 * #35). Replaces a straight double quote (`"`) that sits in a CLOSING position
 * with the locale's closing mark: Russian `»`, every other locale the English
 * curly `”`. `«Привет"` → `«Привет»` (ru).
 *
 * CLOSING position is the complement of {@link isOpeningQuotePosition}: a quote
 * after a letter, digit, or closing punctuation. An opening quote belongs to #34
 * — the two never collide, so they share `priority: PRIORITY_GUILLEMET` and both are
 * `localeAware`.
 *
 * It NEVER touches a code line or an inline-code span.
 *
 * PURE + IDEMPOTENT: after one application the character is a guillemet/curly
 * mark, not a straight quote, so a second pass finds nothing.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_GUILLEMET } from '../typography-priority';
import {
  isOpeningQuotePosition,
  localeQuotes
} from './quote-shared';
import { insideNonProseToken } from './token-guard';

export const CLOSING_QUOTE_TO_GUILLEMET_ID = 'closing-quote-to-guillemet';

export const closingQuoteToGuillemetRule: TypographyRule = {
  id: CLOSING_QUOTE_TO_GUILLEMET_ID,
  descriptionKey: 'ai-focused-editor/typography/closing-quote-to-guillemet-desc',
  defaultEnabled: true,
  priority: PRIORITY_GUILLEMET,
  localeAware: true,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const { close } = localeQuotes(ctx.locale);
    const edits: TypographyEdit[] = [];
    for (const line of ctx.lines) {
      if (line.isCode) {
        continue;
      }
      const text = line.text;
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== '"') {
          continue;
        }
        // Complement of the opening test: anything not an opening position is a
        // closing quote.
        if (isOpeningQuotePosition(text, i)) {
          continue;
        }
        if (insideNonProseToken(line, i)) {
          continue;
        }
        edits.push({
          ruleId: CLOSING_QUOTE_TO_GUILLEMET_ID,
          range: {
            start: { line: line.lineNumber, column: i + 1 },
            end: { line: line.lineNumber, column: i + 2 }
          },
          text: close
        });
      }
    }
    return edits.length > 0 ? edits : null;
  }
};
