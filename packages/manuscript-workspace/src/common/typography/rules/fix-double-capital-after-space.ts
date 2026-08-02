/**
 * Rule #42 — fix accidental double capital after a space (TASK-019 W3, GitHub
 * #42). Corrects a stray second upper-case letter at the start of a word that
 * follows whitespace: `Он ПРишёл.` → `Он Пришёл.`, `Это БЫло давно.` →
 * `Это Было давно.`. The fix lower-cases the SECOND capital only.
 *
 * PRESERVES intentional caps (GitHub #42). An all-caps word (`ГОСТ`, `США`) never
 * matches the `[Lu][Lu][Ll]` stutter pattern (its third letter is upper-case),
 * and a small preserve set covers two-caps units (`МПа`). A proper noun (`Иван`)
 * has a single capital, so it never matches either. See {@link doubleCapitalFixEdit}.
 *
 * A word start here is a letter immediately preceded by a WHITESPACE character
 * (not line start — the issue scopes this to "after a space"). SKIPS code lines
 * and inline-code spans.
 *
 * INTERACTION with #43 (same fix after punctuation): a word after `. ` follows a
 * space too, so both rules propose the SAME edit there; the engine dedupes, so
 * the letter is lower-cased once. `priority: PRIORITY_CAPITALIZATION_FIXUP`. PURE + IDEMPOTENT.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_CAPITALIZATION_FIXUP } from '../typography-priority';
import { doubleCapitalFixEdit, isLetter, isWhitespace } from './capitalize-shared';

export const FIX_DOUBLE_CAPITAL_AFTER_SPACE_ID = 'fix-double-capital-after-space';

export const fixDoubleCapitalAfterSpaceRule: TypographyRule = {
  id: FIX_DOUBLE_CAPITAL_AFTER_SPACE_ID,
  descriptionKey: 'ai-focused-editor/typography/fix-double-capital-after-space-desc',
  defaultEnabled: true,
  priority: PRIORITY_CAPITALIZATION_FIXUP,
  localeAware: true,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const edits: TypographyEdit[] = [];
    for (const line of ctx.lines) {
      if (line.isCode) {
        continue;
      }
      const text = line.text;
      for (let i = 1; i < text.length; i++) {
        if (!isWhitespace(text[i - 1]) || !isLetter(text[i])) {
          continue;
        }
        const edit = doubleCapitalFixEdit(line, i, FIX_DOUBLE_CAPITAL_AFTER_SPACE_ID, ctx.locale);
        if (edit) {
          edits.push(edit);
        }
      }
    }
    return edits.length > 0 ? edits : null;
  }
};
