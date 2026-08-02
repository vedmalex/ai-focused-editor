/**
 * Pure, Theia-free code detector (TASK-019 §1.4). Two independent layers, both
 * unit-testable without Monaco:
 *
 *  (a) BLOCK code -> `isCode[]`: a stateful scan of ` ``` `/`~~~` fences
 *      (CommonMark: a closing fence is the same character, at least as long as
 *      the opener, with only whitespace after), ≥4-space / tab-indented lines,
 *      and the LEADING YAML front matter block (see
 *      {@link findFrontMatterEnd}). The whole line is code.
 *
 *  (b) INLINE code -> `inlineRanges[]`: backtick spans within a non-code line,
 *      matched by equal-length backtick runs (`` `x` ``, ``` ``y`` ``). Ranges
 *      are 0-based, half-open `[startCol, endCol)` CHARACTER offsets into the
 *      line, and INCLUDE the surrounding backticks.
 *
 * The inline layer is deliberately NOT dependent on Monaco's `@internal`
 * tokenizer — it is the fail-safe that keeps the code-skip correct even if the
 * Monaco token refinement in the browser adapter is unavailable.
 */

export interface InlineCodeRange {
  /** 0-based inclusive start character offset (the opening backtick). */
  readonly startCol: number;
  /** 0-based exclusive end character offset (one past the closing backtick). */
  readonly endCol: number;
}

export interface CodeMask {
  /** Per-line: true when the entire line is a code block (fence or indent). */
  readonly isCode: boolean[];
  /** Per-line: inline code spans (empty on code lines and plain prose). */
  readonly inlineRanges: InlineCodeRange[][];
}

const FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** The opening delimiter of a YAML front matter block: exactly `---` on its own line. */
const FRONT_MATTER_OPEN = /^---[ \t]*$/;

/** A closing delimiter of a YAML front matter block: `---` or `...` on its own line. */
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

/** Byte-order mark, tolerated only as the very first character of line 0. */
const BOM = '﻿';

/**
 * Locate the LEADING YAML front matter block and return the index of its closing
 * delimiter, or -1 when the document has none.
 *
 * Recognition rules (deliberately narrow — this mask disables ALL typography on
 * the lines it claims, so a false positive silently turns the engine off):
 *
 *  - the opener must be line index 0 and exactly `---` (trailing spaces/tabs are
 *    tolerated; a BOM is stripped first). `----`, `--- foo` and any indented
 *    variant are NOT openers.
 *  - the block ends at the first LATER line that is exactly `---` or `...`
 *    (the two YAML document delimiters Jekyll/Obsidian/Pandoc all accept).
 *  - a `---` anywhere else in the document is a thematic break or a setext
 *    underline, never front matter — hence the line-0 anchor.
 *
 * UNCLOSED BLOCK -> -1 (fail-open, nothing is masked). Treating an unterminated
 * leading `---` as "front matter to end of file" would let ONE stray line at the
 * top of a manuscript silently disable typography for the whole document, and
 * that failure is invisible to the writer. The opposite failure — a genuinely
 * unterminated front matter getting typographed — cannot happen in practice
 * because the front matter this project writes is always closed
 * (`chapter-front-matter` round-trips the delimiter pair); an unterminated `---`
 * is far more likely to be a thematic break at the top of a prose file. Note the
 * asymmetry is deliberate and differs from the FENCE layer, where an unterminated
 * ``` ``` ``` DOES swallow the rest of the file: a fence opener is unambiguous
 * (three backticks are never prose), while a bare `---` is not.
 */
function findFrontMatterEnd(lines: readonly string[]): number {
  if (lines.length < 2) {
    return -1;
  }
  const first = lines[0].startsWith(BOM) ? lines[0].slice(BOM.length) : lines[0];
  if (!FRONT_MATTER_OPEN.test(first)) {
    return -1;
  }
  for (let idx = 1; idx < lines.length; idx++) {
    if (FRONT_MATTER_CLOSE.test(lines[idx])) {
      return idx;
    }
  }
  return -1;
}

/** Leading-whitespace column width, counting a tab as one indent character. */
function leadingIndentWidth(line: string): number {
  let spaces = 0;
  for (const ch of line) {
    if (ch === ' ') {
      spaces += 1;
    } else if (ch === '\t') {
      // A tab always clears the 4-space indent-code threshold on its own.
      return 4;
    } else {
      break;
    }
  }
  return spaces;
}

/** Find equal-length backtick-run inline spans on a single prose line. */
function scanInline(line: string): InlineCodeRange[] {
  const ranges: InlineCodeRange[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      i += 1;
      continue;
    }
    // Measure the opening run length.
    let openLen = 0;
    while (i + openLen < line.length && line[i + openLen] === '`') {
      openLen += 1;
    }
    const openStart = i;
    let j = i + openLen;
    let closed = false;
    while (j < line.length) {
      if (line[j] === '`') {
        let closeLen = 0;
        while (j + closeLen < line.length && line[j + closeLen] === '`') {
          closeLen += 1;
        }
        if (closeLen === openLen) {
          ranges.push({ startCol: openStart, endCol: j + closeLen });
          i = j + closeLen;
          closed = true;
          break;
        }
        j += closeLen;
      } else {
        j += 1;
      }
    }
    if (!closed) {
      // Unmatched opener: consume it and move on (no span).
      i = openStart + openLen;
    }
  }
  return ranges;
}

/**
 * Classify every line of `lines` into block-code flags and inline-code spans.
 * Fence state carries across lines, so callers should pass the WHOLE document's
 * lines (not just a window) to keep an open fence correct downstream — and the
 * front matter probe needs line 0, which a window may not contain.
 */
export function computeCodeMask(lines: readonly string[]): CodeMask {
  const isCode: boolean[] = new Array(lines.length).fill(false);
  const inlineRanges: InlineCodeRange[][] = lines.map(() => []);

  let fenceMarker: string | undefined;
  let fenceLen = 0;

  // YAML front matter: mark the whole block INCLUDING both delimiters, then let
  // the fence scanner start AFTER it. Skipping the range (rather than flagging
  // it inside the loop) keeps `fenceMarker` untouched — the delimiters are not
  // fences, and a ``` block right below the front matter must still open from a
  // clean state. `inlineRanges` stay empty for these lines, as for any code line.
  const frontMatterEnd = findFrontMatterEnd(lines);
  for (let idx = 0; idx <= frontMatterEnd; idx++) {
    isCode[idx] = true;
  }

  for (let idx = frontMatterEnd + 1; idx < lines.length; idx++) {
    const line = lines[idx];
    const fence = FENCE_PATTERN.exec(line);

    if (fenceMarker) {
      // Inside a fence: this line is code. A matching closing fence also counts
      // as code (the fence line itself), then closes the block.
      isCode[idx] = true;
      if (fence) {
        const marker = fence[2][0];
        const len = fence[2].length;
        const info = fence[3].trim();
        if (marker === fenceMarker && len >= fenceLen && info.length === 0) {
          fenceMarker = undefined;
          fenceLen = 0;
        }
      }
      continue;
    }

    if (fence) {
      // Opening fence.
      fenceMarker = fence[2][0];
      fenceLen = fence[2].length;
      isCode[idx] = true;
      continue;
    }

    if (leadingIndentWidth(line) >= 4) {
      // Indented code block (conservative: any ≥4-space/tab indent skips).
      isCode[idx] = true;
      continue;
    }

    inlineRanges[idx] = scanInline(line);
  }

  return { isCode, inlineRanges };
}
