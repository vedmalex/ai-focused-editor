/**
 * Rule #31 — paragraph-start capital (TASK-019 W3, GitHub #31). Capitalizes the
 * FIRST alphabetic character of a paragraph's first line: `иван вошёл.` →
 * `Иван вошёл.`. A paragraph starts at the document start or on the line after a
 * blank line. Leading Markdown markers (a bullet `- `, a blockquote `> `, a
 * dialogue dash `— `) are skipped over — the rule capitalizes the first LETTER,
 * so `- первый пункт` → `- Первый пункт` (GitHub #31's list example).
 *
 * SKIPS (task §W3): whole code lines (`isCode`), ATX heading lines (`# …` — the
 * task lists headings as structure to leave alone), a first letter that sits
 * inside an inline-code span, and a first letter that is already upper-case or
 * caseless (idempotence / no-op).
 *
 * LOOK-BACK: a line is a paragraph start only when it is line 1 OR the
 * immediately-preceding line is visible in the window AND blank. When the
 * predecessor is not in the window (and the line is not line 1) the rule is
 * CONSERVATIVE and does nothing — it never guesses a mid-paragraph line is a
 * start. The live seam always includes the changed line's predecessor
 * (CONTEXT_LOOKBACK_LINES ≥ 1) and the batch/text drivers snapshot the whole
 * document, so real paragraph starts are always decidable.
 *
 * INTERACTION with #41 (dialogue-dash-capital): for a paragraph-start dialogue
 * line `— привет.` both rules propose the SAME edit (capitalize `п`); the engine
 * dedupes overlapping edits, so the letter is capitalized exactly once.
 *
 * `priority: PRIORITY_CAPITALIZATION_START` — the capitalization band (§3). PURE + IDEMPOTENT.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_CAPITALIZATION_START } from '../typography-priority';
import {
  firstLetterIndex,
  isHeadingLine,
  isLower,
  toLocaleUpper
} from './capitalize-shared';
import { insideNonProseToken } from './token-guard';

export const PARAGRAPH_START_CAPITAL_ID = 'paragraph-start-capital';

export const paragraphStartCapitalRule: TypographyRule = {
  id: PARAGRAPH_START_CAPITAL_ID,
  descriptionKey: 'ai-focused-editor/typography/paragraph-start-capital-desc',
  defaultEnabled: true,
  priority: PRIORITY_CAPITALIZATION_START,
  // Reads the PRECEDING line (see the LOOK-BACK note above).
  requiredLookbackLines: 1,
  localeAware: true,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const edits: TypographyEdit[] = [];
    for (let idx = 0; idx < ctx.lines.length; idx++) {
      const line = ctx.lines[idx];
      if (line.isCode || isHeadingLine(line.text)) {
        continue;
      }
      if (!isParagraphStart(ctx.lines, idx)) {
        continue;
      }
      const letterIndex = firstLetterIndex(line.text);
      if (letterIndex < 0) {
        continue;
      }
      if (insideNonProseToken(line, letterIndex)) {
        continue;
      }
      const ch = line.text[letterIndex];
      if (!isLower(ch)) {
        continue;
      }
      const upper = toLocaleUpper(ch, ctx.locale);
      if (upper === ch) {
        continue;
      }
      edits.push({
        ruleId: PARAGRAPH_START_CAPITAL_ID,
        range: {
          start: { line: line.lineNumber, column: letterIndex + 1 },
          end: { line: line.lineNumber, column: letterIndex + 2 }
        },
        text: upper
      });
    }
    return edits.length > 0 ? edits : null;
  }
};

/**
 * True when the window line at index `idx` begins a paragraph: it is line 1, or
 * its immediately-preceding line is present in the window and blank. Returns
 * false when the predecessor is not visible (conservative — never invents a
 * paragraph start mid-buffer).
 */
function isParagraphStart(
  lines: TypographyContext['lines'],
  idx: number
): boolean {
  const line = lines[idx];
  if (line.lineNumber === 1) {
    return true;
  }
  const prev = lines[idx - 1];
  if (prev && prev.lineNumber === line.lineNumber - 1) {
    return prev.text.trim() === '';
  }
  return false;
}
