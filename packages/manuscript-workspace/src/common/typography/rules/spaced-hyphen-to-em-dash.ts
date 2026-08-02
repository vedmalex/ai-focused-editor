/**
 * Rule #32 — spaced hyphen to em dash (TASK-019 W2, GitHub #32). Replaces a
 * single ASCII hyphen that is surrounded by spaces on BOTH sides with an em dash
 * (`—`, U+2014), keeping the flanking spaces: `слово - слово` becomes
 * `слово — слово`.
 *
 * It NEVER touches:
 *  - a hyphen WITHOUT surrounding spaces (`из-за`, `кто-то`, `well-known`) — the
 *    space-on-both-sides requirement is what distinguishes a dash from a
 *    compound-word hyphen;
 *  - a run of two or more hyphens (`--`, `---` thematic break / long dash);
 *  - a hyphen at the very start of the line (that is #40's paragraph dash);
 *  - a code line (`ctx.lines[i].isCode`) or an inline-code span.
 *
 * PURE + IDEMPOTENT: after one application the character is an em dash, not an
 * ASCII hyphen, so a second pass finds nothing to replace.
 *
 * `priority: PRIORITY_EM_DASH` sits in the em-dash/quote band, above the punctuation/spacing
 * rules (10-25) and below capitalization (45-50) per §3.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_EM_DASH } from '../typography-priority';
import { insideNonProseToken } from './token-guard';

export const SPACED_HYPHEN_TO_EM_DASH_ID = 'spaced-hyphen-to-em-dash';

/** The em dash the rule inserts (U+2014). */
const EM_DASH = '—';

export const spacedHyphenToEmDashRule: TypographyRule = {
  id: SPACED_HYPHEN_TO_EM_DASH_ID,
  descriptionKey: 'ai-focused-editor/typography/spaced-hyphen-to-em-dash-desc',
  defaultEnabled: true,
  priority: PRIORITY_EM_DASH,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const edits: TypographyEdit[] = [];
    for (const line of ctx.lines) {
      if (line.isCode) {
        continue;
      }
      const text = line.text;
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== '-') {
          continue;
        }
        // Space on BOTH sides — the dash signature. A leading-of-line hyphen
        // (i === 0) can have no space before it, so it is excluded here (that is
        // #40's paragraph dash).
        if (text[i - 1] !== ' ' || text[i + 1] !== ' ') {
          continue;
        }
        // A single hyphen only: reject `--`/`---` and any run of hyphens (the
        // surrounding spaces already guarantee no adjacent hyphen, but guard the
        // char-before-the-space and char-after-the-space against a stray hyphen
        // run mistaken for a dash).
        if (text[i - 1] === '-' || text[i + 1] === '-') {
          continue;
        }
        // Require a prose character before the leading space, so a line that is
        // only indentation + `- x` is left to #40, and we never dash a bare gap.
        const beforeSpace = text.slice(0, i - 1);
        if (beforeSpace.trim().length === 0) {
          continue;
        }
        if (insideNonProseToken(line, i)) {
          continue;
        }
        edits.push({
          ruleId: SPACED_HYPHEN_TO_EM_DASH_ID,
          // Replace just the hyphen (columns are 1-based; the hyphen is at
          // 0-based index i, i.e. column i + 1). The spaces stay put.
          range: {
            start: { line: line.lineNumber, column: i + 1 },
            end: { line: line.lineNumber, column: i + 2 }
          },
          text: EM_DASH
        });
      }
    }
    return edits.length > 0 ? edits : null;
  }
};
