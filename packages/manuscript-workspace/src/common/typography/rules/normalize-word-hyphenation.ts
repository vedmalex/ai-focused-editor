/**
 * Rule #33 — normalize known word hyphenation (TASK-019 W2, GitHub #33).
 * DICTIONARY-BASED: replaces the single space between two adjacent words with a
 * hyphen ONLY when the lower-cased word pair is an explicit entry in
 * {@link HYPHENATION_DICTIONARY} (`из за` → `из-за`, `кто то` → `кто-то`). The
 * issue is explicit — "do not guess arbitrary compounds" — so the rule never
 * infers a hyphen from shape; it acts solely on the supported dictionary.
 *
 * The `id` is FINAL and stable (§3, ISS-236); the DICTIONARY is data and may
 * grow in later work without ever renaming the rule.
 *
 * OFF BY DEFAULT. Some entries are genuinely context-sensitive in running prose
 * — e.g. `что то письмо` ("that letter", `то` a demonstrative) must NOT become
 * `что-то письмо` — so the safe manuscript default is opt-in, while `из за` /
 * `из под` (never correct as two words) and the pronoun+particle families make
 * the rule immediately useful once enabled. The unambiguous `из-за` example the
 * issue lists is satisfied; the ambiguity is why the whole rule is one opt-in
 * toggle rather than on by default.
 *
 * Mechanism: the separating space is REPLACED with `-`, so the original casing
 * of both words is preserved automatically (`Из за` → `Из-за`), and the result
 * is a single hyphenated token that can never re-match (there is no longer a
 * space between the words) — hence PURE + IDEMPOTENT.
 *
 * `priority: PRIORITY_SPACING_HYPHENATION` — the top of the punctuation/spacing band, below the
 * em-dash/quote rules (30-40) per §3.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_SPACING_HYPHENATION } from '../typography-priority';
import { overlapsNonProseToken } from './token-guard';

export const NORMALIZE_WORD_HYPHENATION_ID = 'normalize-word-hyphenation';

/**
 * The supported word pairs (lower-cased `left right`). Membership is exact and
 * whole-word — a pair matches only when both tokens equal a dictionary word,
 * never as a substring. Grouped for maintenance; behaviour is a flat set.
 */
export const HYPHENATION_DICTIONARY: ReadonlySet<string> = new Set([
  // Compound prepositions — never correct as two separate words.
  'из за',
  'из под',
  // Pronoun/adverb + `-то`.
  'кто то', 'что то', 'чей то', 'чьё то', 'чье то', 'какой то', 'какая то',
  'какое то', 'какие то', 'каком то', 'какому то', 'каких то', 'кому то',
  'кого то', 'кем то', 'чём то', 'чем то', 'где то', 'куда то', 'откуда то',
  'когда то', 'как то', 'почему то', 'зачем то', 'сколько то', 'который то',
  // Pronoun/adverb + `-нибудь`.
  'кто нибудь', 'что нибудь', 'чей нибудь', 'какой нибудь', 'какая нибудь',
  'какое нибудь', 'какие нибудь', 'где нибудь', 'куда нибудь', 'откуда нибудь',
  'когда нибудь', 'как нибудь', 'почему нибудь', 'сколько нибудь', 'кому нибудь',
  // Pronoun/adverb + `-либо`.
  'кто либо', 'что либо', 'чей либо', 'какой либо', 'где либо', 'куда либо',
  'откуда либо', 'когда либо', 'как либо'
]);

/** A word token: a maximal run of Unicode letters, with its 0-based bounds. */
interface WordToken {
  readonly text: string;
  readonly start: number;
  /** 0-based exclusive end. */
  readonly end: number;
}

const WORD = /\p{L}+/gu;

function wordTokens(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  WORD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

export const normalizeWordHyphenationRule: TypographyRule = {
  id: NORMALIZE_WORD_HYPHENATION_ID,
  descriptionKey: 'ai-focused-editor/typography/normalize-word-hyphenation-desc',
  defaultEnabled: false,
  priority: PRIORITY_SPACING_HYPHENATION,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const edits: TypographyEdit[] = [];
    for (const line of ctx.lines) {
      if (line.isCode) {
        continue;
      }
      const text = line.text;
      const tokens = wordTokens(text);
      for (let i = 0; i < tokens.length - 1; i++) {
        const left = tokens[i];
        const right = tokens[i + 1];
        // The two words must be separated by EXACTLY one space (a single ASCII
        // space at `left.end`). A wider gap is left for #38 to collapse first.
        if (right.start - left.end !== 1 || text[left.end] !== ' ') {
          continue;
        }
        const key = `${left.text.toLowerCase()} ${right.text.toLowerCase()}`;
        if (!HYPHENATION_DICTIONARY.has(key)) {
          continue;
        }
        if (overlapsNonProseToken(line, left.start, right.end)) {
          continue;
        }
        edits.push({
          ruleId: NORMALIZE_WORD_HYPHENATION_ID,
          // Replace the single separating space (0-based index `left.end`,
          // 1-based column `left.end + 1`) with a hyphen.
          range: {
            start: { line: line.lineNumber, column: left.end + 1 },
            end: { line: line.lineNumber, column: left.end + 2 }
          },
          text: '-'
        });
      }
    }
    return edits.length > 0 ? edits : null;
  }
};
