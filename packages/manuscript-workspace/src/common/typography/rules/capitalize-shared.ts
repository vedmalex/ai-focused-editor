/**
 * Shared, pure helpers for the CONTEXTUAL capitalization rules (TASK-019 W3,
 * GitHub #31/#39/#41/#42/#43). One module so the Unicode case tests, the
 * abbreviation guard, and the intentional-caps preserve set can never drift
 * between the five rules that all decide "is this the start of something that
 * should be capitalized, and is this an accidental double capital?".
 *
 * UNICODE-AWARE (UR-005): case classification uses `\p{Lu}` / `\p{Ll}` / `\p{L}`
 * with the `u` flag, and case conversion uses `toLocaleUpperCase(locale)` /
 * `toLocaleLowerCase(locale)`, so Cyrillic (`ё`→`Ё`), the ру/en locales, and any
 * other cased script behave correctly.
 *
 * AGGRESSIVE default with RICH NEGATIVE guards (UR-005): the rules fire readily
 * (an accidental lower-case is easily the common case), but never touch a known
 * abbreviation (`т.е.`, `т.к.`, `и.о.`), an initial, a number, an all-caps word
 * (`ГОСТ`, `США`), or a preserved two-caps unit (`МПа`).
 */

import { LineSnapshot, TypographyEdit } from '../typography-types';
import { insideNonProseToken } from './token-guard';

/** Sentence-ending marks after which a new sentence (a capital) may begin. */
export const SENTENCE_END_PUNCTUATION: ReadonlySet<string> = new Set(['.', '!', '?', '…']);

/**
 * Russian (plus a few Latin) common abbreviations whose trailing period is NOT a
 * sentence boundary. Stored lower-cased and dot-free; the sentence-start rule
 * skips capitalizing after `<abbr>. ` so `см. рис`, `т. е.`, `стр. текст` stay
 * lower-cased. Extensible — add the dot-free stem of any abbreviation.
 */
export const KNOWN_ABBREVIATIONS: ReadonlySet<string> = new Set([
  // single-letter initials / units are handled by the length<=1 guard, but the
  // most common multi-letter forms are enumerated here explicitly:
  'см', 'ср', 'стр', 'рис', 'табл', 'гл', 'напр', 'англ', 'лат', 'им',
  'ул', 'кв', 'руб', 'коп', 'млн', 'млрд', 'тыс', 'проф', 'акад', 'доц',
  'тд', 'тп', 'тк', 'др', 'пр', 'гг', 'вв', 'обл', 'р', 'оз', 'этс', 'etc'
]);

/**
 * Two-capital tokens to PRESERVE from the double-capital fixers (#42/#43): units
 * and acronyms that legitimately begin with two capitals then lower-case, so
 * `МПа`, `ГГц`, `КБайт` are never "corrected" to `Мпа`. All-caps words (`ГОСТ`,
 * `США`) need no entry — they never match the `[Lu][Lu][Ll]` stutter pattern.
 */
export const PRESERVED_DOUBLE_CAPS: ReadonlySet<string> = new Set([
  'МПа', 'ГПа', 'ГГц', 'МГц', 'КГц', 'КБайт', 'МБайт', 'ГБайт', 'ТБайт'
]);

const LETTER = /\p{L}/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const WHITESPACE = /\s/;

/** True for a single Unicode letter (any script). */
export function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && LETTER.test(ch);
}

/** True for a single lower-case Unicode letter. */
export function isLower(ch: string | undefined): boolean {
  return ch !== undefined && LOWER.test(ch);
}

/** True for a single upper-case Unicode letter. */
export function isUpper(ch: string | undefined): boolean {
  return ch !== undefined && UPPER.test(ch);
}

/** True for a single whitespace character. */
export function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE.test(ch);
}

/** Locale-aware upper-case of a single character. */
export function toLocaleUpper(ch: string, locale: string): string {
  return ch.toLocaleUpperCase(locale);
}

/** Locale-aware lower-case of a single character. */
export function toLocaleLower(ch: string, locale: string): string {
  return ch.toLocaleLowerCase(locale);
}

/** 0-based index of the first Unicode letter in `text`, or -1 when there is none. */
export function firstLetterIndex(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (LETTER.test(text[i])) {
      return i;
    }
  }
  return -1;
}

/**
 * The maximal run of letters ending immediately BEFORE 0-based index `i` (the
 * "word before this punctuation"). `precedingWord('см.', 2)` → `'см'`.
 */
export function precedingWord(text: string, i: number): string {
  let start = i;
  while (start > 0 && LETTER.test(text[start - 1])) {
    start--;
  }
  return text.slice(start, i);
}

/**
 * The maximal run of letters STARTING at 0-based index `p` (the "word at this
 * position"). `leadingWord('МПа далее', 0)` → `'МПа'`.
 */
export function leadingWord(text: string, p: number): string {
  let end = p;
  while (end < text.length && LETTER.test(text[end])) {
    end++;
  }
  return text.slice(p, end);
}

/** True when `text` is an ATX Markdown heading line (`#`…`######`, up to 3-space indent). */
export function isHeadingLine(text: string): boolean {
  return /^\s{0,3}#{1,6}(\s|$)/.test(text);
}

/**
 * The stutter-caps-lock fix shared by #42/#43: when the word starting at 0-based
 * index `p` reads `[Lu][Lu][Ll]…` (two capitals then a lower-case letter — an
 * accidental double capital like `ПРишёл`, `КАк`), return the edit that
 * lower-cases the SECOND capital. Returns null when the pattern does not hold, or
 * the word is a preserved two-caps unit (`МПа`), or it sits in inline code.
 *
 * An ALL-CAPS word (`ГОСТ`, `США`) never matches because its third character is
 * upper-case, so acronyms are preserved without a dictionary. The edit is a
 * one-character in-place lower-case: it does not move the text after it, so the
 * caret needs no repositioning (ISS-247).
 */
export function doubleCapitalFixEdit(
  line: LineSnapshot,
  p: number,
  ruleId: string,
  locale: string
): TypographyEdit | null {
  const text = line.text;
  if (!isUpper(text[p]) || !isUpper(text[p + 1]) || !isLower(text[p + 2])) {
    return null;
  }
  if (insideNonProseToken(line, p) || insideNonProseToken(line, p + 1)) {
    return null;
  }
  if (PRESERVED_DOUBLE_CAPS.has(leadingWord(text, p))) {
    return null;
  }
  const lower = toLocaleLower(text[p + 1], locale);
  if (lower === text[p + 1]) {
    return null;
  }
  return {
    ruleId,
    range: {
      start: { line: line.lineNumber, column: p + 2 },
      end: { line: line.lineNumber, column: p + 3 }
    },
    text: lower
  };
}
