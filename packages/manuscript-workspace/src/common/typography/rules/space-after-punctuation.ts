/**
 * Rule #37 — space after punctuation (TASK-019 W1b). Inserts a single space
 * AFTER a sentence-punctuation mark (`,` `.` `;` `:` `!` `?` `…`) when it is
 * immediately followed by a letter or digit, so `word,next` becomes
 * `word, next`.
 *
 * ## Why the guards are this paranoid (ISS-240)
 *
 * This rule is ON BY DEFAULT and runs on the git-irreversible multi-file batch
 * path, so a false positive is not a cosmetic annoyance — it is silent damage to
 * the manuscript. The first implementation split clock times (`12:30` →
 * `12: 30`), domains (`example.com` → `example. com`) and file names
 * (`chapter-01.md` → `chapter-01. md`), all of which occur constantly in a
 * writer's notes and chapter cross-references.
 *
 * The guards below are therefore deliberately biased toward FALSE NEGATIVES: a
 * missed space is a cosmetic non-event the user fixes with one keystroke, a
 * spurious space inside `notes.md` is corruption they may never notice. Every
 * guard is written to fail in that direction.
 *
 * Guards, in the order they are applied:
 *  1. the next character must be a letter/digit — a mark at end of line, before
 *     whitespace, or before another mark (`?!`, `...`, `.)`) is left alone;
 *  2. NUMBER/CLOCK separator: `.` `,` `:` `;` flanked by DIGITS on both sides
 *     (`3.14`, `1,000`, `12:30`, `2:1`, `10:20:30`) is structural, not prose;
 *  3. STRUCTURAL token: the mark sits inside a whitespace-free run that carries
 *     a URL scheme (`://`), an `@`, or a path separator (`/`, `\`) — a URL,
 *     e-mail or path is one atom whatever its punctuation looks like;
 *  4. FILE/DOMAIN suffix (`.` only): the dot-segment that follows is a known TLD
 *     or file extension (`example.com`, `notes.md`), or the token has file-name
 *     shape (ASCII, digits/hyphens/underscores before the dot, short lowercase
 *     extension after);
 *  5. GLUED COLON (`:` only): a colon with a non-space character on its left is
 *     assumed structural (`key:value`, `d:e`, `C:...`, a markdown reference
 *     label) UNLESS what follows is an UPPER-CASE letter, which in prose means a
 *     new clause (`сказал:Привет` → `сказал: Привет`);
 *  6. code: a code line and any inline-code span are skipped (as #36/#38 do).
 *
 * Guard 4 is a dictionary, so an exotic extension (`notes.qqq`) still gets a
 * space — the residual risk accepted in exchange for keeping ordinary prose
 * (`Да.Нет` → `Да. Нет`, `one,two.three` → `one, two. three`) working. Cyrillic
 * prose is structurally immune to guards 4 and 5: both require ASCII lower-case
 * shapes, which Russian text never produces.
 *
 * PURE + IDEMPOTENT: after one application the mark is followed by a space, so
 * the guard "next is whitespace" makes a second pass a no-op.
 *
 * `priority: PRIORITY_SPACING_PUNCTUATION` — the punctuation/spacing band. It pairs with #36
 * (no-space-before-punctuation): on `word ,next` #36 deletes the leading space
 * and #37 inserts the trailing one (`word, next`) in the SAME engine pass, since
 * their ranges (a deletion before the mark, a zero-width insertion after it) do
 * not overlap.
 */

import {
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from '../typography-types';
import { PRIORITY_SPACING_PUNCTUATION } from '../typography-priority';
import { insideNonProseToken } from './token-guard';

export const SPACE_AFTER_PUNCTUATION_ID = 'space-after-punctuation';

/** Sentence punctuation that must be followed by a space before the next word. */
const PUNCTUATION = new Set([',', '.', ';', ':', '!', '?', '…']);

/**
 * Marks whose digit-flanked form is a NUMBER or CLOCK separator and must never
 * be split: `3.14`, `1,000`, `12:30`, `2:1`, `10:20:30`, `1;2`. Guard 2.
 *
 * The `:` entry is DEFENCE IN DEPTH, deliberately kept though guard 5 already
 * covers every clock time (a digit before a colon is never whitespace, so the
 * glued-colon guard always fires first). It is here so that relaxing guard 5 —
 * the plausible future change, since it is the aggressive one — cannot silently
 * re-open the `12:30` → `12: 30` corruption. `;` is NOT covered by guard 5 and
 * relies on this entry alone (`3;4`).
 */
const DIGIT_FLANKED_MARKS = new Set([',', '.', ':', ';']);

/** True for a single Unicode letter or digit (the "next is a word char" test). */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** True for a single upper-case Unicode letter (the prose-clause test, guard 5). */
const UPPER_LETTER = /\p{Lu}/u;

/** Characters a URL / path / file name is built from (guard 4's shape test). */
const ASCII_TOKEN = /^[A-Za-z0-9._+~%#=&?-]+$/;

/** A dot-segment shaped like a TLD or a file extension: short, ASCII, lower-case. */
const SUFFIX_SHAPE = /^[a-z0-9]{1,10}$/;

/**
 * Known top-level domains and file extensions (guard 4). Membership means "this
 * dot joins one token", so the list only has to be RIGHT, not exhaustive: an
 * entry that is also an English word (`is`, `it`, `me`, `in`) costs at most a
 * missed space in lower-case English prose, while a missing entry costs a
 * corrupted file name. Russian prose is unaffected either way (Cyrillic never
 * matches {@link SUFFIX_SHAPE}).
 */
const KNOWN_TOKEN_SUFFIXES: ReadonlySet<string> = new Set([
  // Top-level domains.
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro',
  'io', 'co', 'me', 'tv', 'cc', 'dev', 'app', 'ai', 'xyz', 'online', 'site',
  'club', 'shop', 'blog', 'news', 'wiki', 'store', 'space', 'tech', 'cloud',
  'ru', 'su', 'ua', 'by', 'kz', 'uz', 'am', 'ge', 'uk', 'de', 'fr', 'it', 'es',
  'pl', 'cz', 'sk', 'hu', 'ro', 'bg', 'rs', 'gr', 'pt', 'nl', 'be', 'at', 'ch',
  'se', 'no', 'fi', 'dk', 'ee', 'lv', 'lt', 'ie', 'is', 'us', 'ca', 'au', 'nz',
  'jp', 'cn', 'kr', 'in', 'br', 'mx', 'ar', 'cl', 'za', 'tr', 'il', 'ae', 'eu',
  // Text / markup / data.
  'md', 'markdown', 'txt', 'text', 'json', 'jsonc', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'lock', 'xml', 'csv', 'tsv', 'html', 'htm',
  'css', 'scss', 'sass', 'less', 'tex', 'bib', 'rst', 'adoc',
  // Code (`org`, `pl` already listed above as domains).
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'swift', 'php', 'sh', 'bash', 'zsh', 'sql', 'lua', 'vim',
  // Documents / books / media / archives.
  'pdf', 'epub', 'fb2', 'mobi', 'azw3', 'djvu', 'doc', 'docx', 'odt', 'rtf',
  'pages', 'ppt', 'pptx', 'xls', 'xlsx', 'ods',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'tiff',
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'avi', 'mov', 'flac', 'm4a',
  'zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z',
  // Misc build/tooling artefacts a writer's repo notes mention.
  'log', 'bak', 'tmp', 'map', 'gitignore', 'npmrc', 'editorconfig'
]);

/** True for a single ASCII digit (the number-separator neighbour test). */
function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/** 0-based half-open bounds of the whitespace-free run containing index `i`. */
function tokenBounds(text: string, i: number): { start: number; end: number } {
  let start = i;
  while (start > 0 && !/\s/.test(text[start - 1])) {
    start -= 1;
  }
  let end = i + 1;
  while (end < text.length && !/\s/.test(text[end])) {
    end += 1;
  }
  return { start, end };
}

/**
 * Guard 3 — the token is a URL, an e-mail address or a path, and therefore ONE
 * atom no matter what punctuation it contains. Checked for every mark (a comma
 * inside `site.com/a,b` is as structural as the dot).
 */
function isStructuralToken(token: string): boolean {
  return token.includes('://') || token.includes('@') || token.includes('/') || token.includes('\\');
}

/**
 * Guard 4 — the dot at 0-based `dot` joins a file name or a domain rather than
 * two sentences. Looks ONLY at the segment that follows (the run of ASCII
 * alphanumerics up to the next delimiter), so a mixed token decides each dot on
 * its own merits: in `notes.md.Потом` the first dot is a file extension and the
 * second is a sentence end.
 */
function isFileOrDomainDot(text: string, dot: number, token: string, tokenStart: number): boolean {
  let end = dot + 1;
  while (end < text.length && /[A-Za-z0-9]/.test(text[end])) {
    end += 1;
  }
  const segment = text.slice(dot + 1, end);
  if (!SUFFIX_SHAPE.test(segment)) {
    // Anything with a capital, a non-ASCII letter or 10+ characters is prose.
    return false;
  }
  if (KNOWN_TOKEN_SUFFIXES.has(segment)) {
    return true;
  }
  // Unknown-but-file-shaped: an ASCII token whose stem carries a digit, hyphen
  // or underscore followed by a short lower-case extension (`chapter-01.qqq`).
  // Cyrillic prose can never reach here — the token would fail ASCII_TOKEN.
  if (segment.length > 6 || !ASCII_TOKEN.test(token)) {
    return false;
  }
  const stem = text.slice(tokenStart, dot);
  return /[-_0-9]/.test(stem);
}

export const spaceAfterPunctuationRule: TypographyRule = {
  id: SPACE_AFTER_PUNCTUATION_ID,
  descriptionKey: 'ai-focused-editor/typography/space-after-punctuation-desc',
  defaultEnabled: true,
  priority: PRIORITY_SPACING_PUNCTUATION,

  apply(ctx: TypographyContext): TypographyEdit[] | null {
    const edits: TypographyEdit[] = [];
    for (const line of ctx.lines) {
      if (line.isCode) {
        continue;
      }
      const text = line.text;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (!PUNCTUATION.has(ch)) {
          continue;
        }
        const next = text[i + 1];
        const prev = text[i - 1];
        // Guard 1: need a following character that is a letter/digit and not
        // itself space or punctuation.
        if (next === undefined || !LETTER_OR_DIGIT.test(next) || PUNCTUATION.has(next)) {
          continue;
        }
        // Guard 2: number / clock separator — digits on both sides.
        if (DIGIT_FLANKED_MARKS.has(ch) && isDigit(prev) && isDigit(next)) {
          continue;
        }
        // Guards 3-4: the mark is inside a URL / path / file name / domain.
        const bounds = tokenBounds(text, i);
        const token = text.slice(bounds.start, bounds.end);
        if (isStructuralToken(token)) {
          continue;
        }
        if (ch === '.' && isFileOrDomainDot(text, i, token, bounds.start)) {
          continue;
        }
        // Guard 5: a colon glued to the token on its left is structural unless
        // an upper-case letter follows (a new prose clause).
        if (ch === ':' && prev !== undefined && !/\s/.test(prev) && !UPPER_LETTER.test(next)) {
          continue;
        }
        // Guard 6: skip when the mark (or the char right after) is inside inline
        // code.
        if (insideNonProseToken(line, i) || insideNonProseToken(line, i + 1)) {
          continue;
        }
        // Insert a single space at the gap after the mark: a zero-width edit at
        // column (i + 2) in 1-based coordinates (the mark is column i + 1).
        const column = i + 2;
        edits.push({
          ruleId: SPACE_AFTER_PUNCTUATION_ID,
          range: {
            start: { line: line.lineNumber, column },
            end: { line: line.lineNumber, column }
          },
          text: ' '
        });
      }
    }
    return edits.length > 0 ? edits : null;
  }
};
