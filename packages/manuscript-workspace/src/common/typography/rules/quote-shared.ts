/**
 * Shared, pure helpers for the locale-aware quote rules #34 / #35 (TASK-019 W2,
 * GitHub #34/#35). Kept in one module so the OPEN-vs-CLOSE classification and the
 * per-locale mark table can never drift between the two rules.
 *
 * A straight double quote (`"`, U+0022) is classified purely from the character
 * immediately before it on the same line:
 *  - OPENING when there is nothing before it, the previous char is whitespace,
 *    or an opening delimiter (`(`, `[`, `{`, `«`, `“`, an em/en dash, a hyphen);
 *  - CLOSING otherwise (after a letter, digit, or closing punctuation).
 * The two positions are mutually exclusive, so #34 (opening) and #35 (closing)
 * never both fire on the same quote — which is why they share `priority: PRIORITY_GUILLEMET`.
 */


/** The opening/closing marks for a locale. */
export interface LocaleQuotes {
  readonly open: string;
  readonly close: string;
}

/** Russian guillemets; every other locale gets English curly quotes. */
const RU_QUOTES: LocaleQuotes = { open: '«', close: '»' };
const DEFAULT_QUOTES: LocaleQuotes = { open: '“', close: '”' };

/** Resolve the quote pair for a (lower-cased, single-segment) locale tag. */
export function localeQuotes(locale: string): LocaleQuotes {
  return locale === 'ru' ? RU_QUOTES : DEFAULT_QUOTES;
}

/** Characters that, immediately before a `"`, mark it as an OPENING quote. */
const OPENING_PREDECESSORS = new Set(['(', '[', '{', '«', '“', '—', '–', '-']);

/**
 * True when the straight quote at 0-based index `i` sits in an OPENING position
 * (start of line, after whitespace, or after an opening delimiter).
 */
export function isOpeningQuotePosition(text: string, i: number): boolean {
  const prev = text[i - 1];
  if (prev === undefined) {
    return true;
  }
  if (/\s/.test(prev)) {
    return true;
  }
  return OPENING_PREDECESSORS.has(prev);
}
