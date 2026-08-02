/**
 * Rule #34 — opening straight quote to locale-aware quote (TASK-019 W2, GitHub
 * #34). Replaces a straight double quote (`"`) that sits in an OPENING position
 * with the locale's opening mark: Russian `«`, every other locale the English
 * curly `“`. `"привет` → `«привет` (ru).
 *
 * OPENING position is decided by {@link isOpeningQuotePosition} (start of line,
 * after whitespace, or after an opening delimiter). A quote right after a letter
 * or digit is a CLOSING quote and belongs to #35 — the two never collide, so
 * they share `priority: PRIORITY_GUILLEMET` and both are `localeAware`.
 *
 * It NEVER touches a code line or an inline-code span (a `"` inside `` `code` ``
 * stays straight).
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

export const OPENING_QUOTE_TO_GUILLEMET_ID = 'opening-quote-to-guillemet';

export const openingQuoteToGuillemetRule: TypographyRule = {
  id: OPENING_QUOTE_TO_GUILLEMET_ID,
  descriptionKey: 'ai-focused-editor/typography/opening-quote-to-guillemet-desc',
  defaultEnabled: true,
  priority: PRIORITY_GUILLEMET,
  localeAware: true,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const { open } = localeQuotes(ctx.locale);
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
        if (!isOpeningQuotePosition(text, i)) {
          continue;
        }
        if (insideNonProseToken(line, i)) {
          continue;
        }
        edits.push({
          ruleId: OPENING_QUOTE_TO_GUILLEMET_ID,
          range: {
            start: { line: line.lineNumber, column: i + 1 },
            end: { line: line.lineNumber, column: i + 2 }
          },
          text: open
        });
      }
    }
    return edits.length > 0 ? edits : null;
  }
};
