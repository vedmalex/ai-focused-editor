/**
 * Rule #41 — dialogue-dash capital (TASK-019 W3, GitHub #41). Capitalizes the
 * first letter after a paragraph-leading dialogue dash: `— привет.` →
 * `— Привет.`, `— когда ты вернёшься?` → `— Когда ты вернёшься?`.
 *
 * The leading dash is accepted as either an em dash `—` (U+2014) or a plain
 * hyphen `-` at column 1, followed by a single space then the letter — so the
 * rule works whether or not #40 (paragraph-leading-hyphen-to-em-dash) has
 * already converted the hyphen, and coordinates cleanly with it: #40 rewrites
 * column 1 (`-`→`—`) while this rule rewrites the first letter, disjoint ranges
 * that both land in one engine pass.
 *
 * Unlike #40 there is NO list guard: capitalizing the first letter of a bullet's
 * content is desirable too (GitHub #31 shows `- первый пункт` → `- Первый пункт`),
 * so a dialogue line and a list item are treated the same here.
 *
 * Fires on ANY line beginning with the dash (not only paragraph starts), so a
 * dialogue run whose lines are not blank-separated is still handled. For a
 * paragraph-start dialogue line it proposes the SAME edit as #31; the engine
 * dedupes, so the letter is capitalized exactly once.
 *
 * SKIPS code lines. `priority: PRIORITY_CAPITALIZATION_START`. PURE + IDEMPOTENT.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_CAPITALIZATION_START } from '../typography-priority';
import { isLower, toLocaleUpper } from './capitalize-shared';

export const DIALOGUE_DASH_CAPITAL_ID = 'dialogue-dash-capital';

/** Dashes accepted as a paragraph-leading dialogue marker (em dash or hyphen). */
const LEADING_DASHES = new Set(['—', '-']);

export const dialogueDashCapitalRule: TypographyRule = {
  id: DIALOGUE_DASH_CAPITAL_ID,
  descriptionKey: 'ai-focused-editor/typography/dialogue-dash-capital-desc',
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
      // Column 1 a dialogue dash, column 2 a single space, column 3 the letter.
      if (!LEADING_DASHES.has(text[0]) || text[1] !== ' ') {
        continue;
      }
      const ch = text[2];
      if (!isLower(ch)) {
        continue;
      }
      const upper = toLocaleUpper(ch, ctx.locale);
      if (upper === ch) {
        continue;
      }
      edits.push({
        ruleId: DIALOGUE_DASH_CAPITAL_ID,
        range: {
          start: { line: line.lineNumber, column: 3 },
          end: { line: line.lineNumber, column: 4 }
        },
        text: upper
      });
    }
    return edits.length > 0 ? edits : null;
  }
};
