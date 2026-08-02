/**
 * Rule #43 — fix accidental double capital after sentence punctuation (TASK-019
 * W3, GitHub #43). Corrects a stray second upper-case letter at the start of the
 * word that follows sentence punctuation and a space: `Привет. КАк дела?` →
 * `Привет. Как дела?`, `Готово! МОжно продолжать.` → `Готово! Можно продолжать.`.
 * The fix lower-cases the SECOND capital only.
 *
 * PRESERVES intentional caps exactly as #42 does (all-caps acronyms `ГОСТ`/`США`
 * never match the `[Lu][Lu][Ll]` pattern; two-caps units like `МПа` are in the
 * preserve set) — see {@link doubleCapitalFixEdit}.
 *
 * A word start here is a letter preceded by whitespace whose run traces back to a
 * sentence mark (`. ! ? …`). This is a subset of #42's "after a space", so when
 * both rules are enabled they emit the SAME edit and the engine dedupes; the two
 * exist as SEPARATE toggles because the user may want the punctuation-only fix
 * without the broader after-any-space one. SKIPS code lines and inline-code
 * spans. `priority: PRIORITY_CAPITALIZATION_FIXUP`. PURE + IDEMPOTENT.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_CAPITALIZATION_FIXUP } from '../typography-priority';
import {
  doubleCapitalFixEdit,
  isLetter,
  isWhitespace,
  SENTENCE_END_PUNCTUATION
} from './capitalize-shared';

export const FIX_DOUBLE_CAPITAL_AFTER_PUNCTUATION_ID = 'fix-double-capital-after-punctuation';

export const fixDoubleCapitalAfterPunctuationRule: TypographyRule = {
  id: FIX_DOUBLE_CAPITAL_AFTER_PUNCTUATION_ID,
  descriptionKey: 'ai-focused-editor/typography/fix-double-capital-after-punctuation-desc',
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
        // Walk back over the whitespace run; a sentence mark before it makes this
        // a post-punctuation word start.
        let k = i - 1;
        while (k >= 0 && isWhitespace(text[k])) {
          k--;
        }
        if (k < 0 || !SENTENCE_END_PUNCTUATION.has(text[k])) {
          continue;
        }
        const edit = doubleCapitalFixEdit(line, i, FIX_DOUBLE_CAPITAL_AFTER_PUNCTUATION_ID, ctx.locale);
        if (edit) {
          edits.push(edit);
        }
      }
    }
    return edits.length > 0 ? edits : null;
  }
};
