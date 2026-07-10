/**
 * Pure, Theia-free helpers for inlining Markdown image sources into the live
 * preview. Kept in `common/` (like `link-navigation.ts`) so the lexing/classify/
 * rewrite rules are unit-testable without a DOM or FileService; the browser
 * `SemanticMarkdownPreviewWidget` layers path resolution + file reads on top.
 *
 * Why inlining is needed: the preview renders through Theia's `MarkdownRenderer`
 * (markdown-it -> DOMPurify). A relative `![alt](images/pic.png)` src cannot
 * resolve (there is no document base URI), and the browser target cannot load
 * `file:` URIs at all. Rewriting the src to a `data:` URI makes the image render
 * offline. See the widget's notes for how the two-stage sanitizer treats these.
 */

/** A single Markdown image source, with the byte range of just the target. */
export interface ImageTarget {
  /** The raw destination inside `![alt](target "title")` — no title, no `()`. */
  target: string;
  /** Half-open `[start, end)` offsets of `target` within the source string. */
  range: { start: number; end: number };
}

/**
 * How an image target should be treated:
 * - `relative` — a document-relative path (`images/pic.png`, `../cover.png`).
 * - `absolute-workspace` — a workspace-root-relative path (leading `/`).
 * - `external` — an `http(s):` URL (rendered as-is; not inlined).
 * - `data` — an existing `data:` URI (passed through untouched).
 * `undefined` means "skip" (empty, in-page `#anchor`, `mailto:`/`tel:`/other
 * schemes) — never inlined, never classified as one of the four buckets.
 */
export type ImageTargetClass = 'relative' | 'absolute-workspace' | 'external' | 'data';

// Inline image up to the start of its destination: `![alt](` plus any leading
// whitespace CommonMark allows before the destination. `alt` forbids `]` and
// newlines so the match cannot run past a single image. Group 1 is the prefix
// (used only for its length, to locate the destination); group 2 is the target,
// stopping at the first whitespace or `)` — i.e. before an optional `"title"`
// and before the closing paren. This intentionally does NOT support:
//   - angle-bracket destinations `![a](<path with spaces>)`,
//   - destinations containing a literal `)` ,
//   - reference-style images `![alt][ref]` (no inline destination),
//   - raw `<img src=...>` HTML (the renderer has html disabled, so such HTML is
//     escaped and never becomes an <img> anyway).
// These are documented limitations; the widget notes call them out.
const IMAGE_TARGET_PATTERN = /(!\[[^\]\n]*\]\(\s*)([^\s)]+)/g;

/**
 * Extract every inline image destination with the byte range of the target
 * substring only (so a rewrite can replace the target and preserve the
 * surrounding `![alt](` / `"title")` byte-exact). Lexical only: it does not skip
 * fenced/inline code, mirroring the light-touch style of `link-navigation`.
 */
export function extractImageTargets(markdown: string): ImageTarget[] {
  const targets: ImageTarget[] = [];
  IMAGE_TARGET_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_TARGET_PATTERN.exec(markdown)) !== null) {
    const prefix = match[1];
    const target = match[2];
    const start = match.index + prefix.length;
    targets.push({ target, range: { start, end: start + target.length } });
  }
  return targets;
}

// A `scheme:` prefix (RFC 3986 style). Used to detect non-relative targets.
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Bucket an image target. Returns `undefined` for targets that must never be
 * inlined and are not one of the four classes (empty, `#anchor`, `mailto:`,
 * `tel:`, `javascript:`, or any other non-`http(s)`/`data` scheme).
 */
export function classifyImageTarget(target: string): ImageTargetClass | undefined {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return undefined;
  }
  if (/^data:/i.test(trimmed)) {
    return 'data';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return 'external';
  }
  // Any other explicit scheme (mailto:, tel:, file:, javascript:, custom ...)
  // and protocol-relative `//host` URLs are skipped.
  if (SCHEME_PATTERN.test(trimmed) || trimmed.startsWith('//')) {
    return undefined;
  }
  return trimmed.startsWith('/') ? 'absolute-workspace' : 'relative';
}

/**
 * Rebuild `markdown`, replacing each image target for which `map` returns a
 * string, and leaving every other byte untouched. `map` returning `undefined`
 * for a target keeps it verbatim. Replacement is offset-driven (shares
 * {@link extractImageTargets} ranges), so titles, alt text, spacing, and
 * unrelated `![]()` occurrences are preserved exactly.
 */
export function rewriteImageTargets(
  markdown: string,
  map: (target: string) => string | undefined
): string {
  let result = '';
  let cursor = 0;
  for (const { target, range } of extractImageTargets(markdown)) {
    const replacement = map(target);
    if (replacement === undefined) {
      continue;
    }
    result += markdown.slice(cursor, range.start) + replacement;
    cursor = range.end;
  }
  return result + markdown.slice(cursor);
}
