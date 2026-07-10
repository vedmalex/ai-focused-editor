/*
 * Shared slug convention for AI Focused Editor exporters.
 *
 * `slugifyBase` / `createSlugger` moved here from
 * packages/manuscript-workspace/src/node/node-book-build-service.ts so the
 * Markdown, HTML, and EPUB exporters unify on a single anchor convention.
 * EpubGenerator/AnchorGenerator derive heading ids and NCX anchors from
 * `slugifyBase`.
 */

/**
 * Unicode-aware slug for a single title: lowercase, keep any Unicode letters
 * and digits, collapse every other run to a single hyphen, and trim hyphens.
 * Returns an empty string when the title contains no letters/digits.
 */
export function slugifyBase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Creates a stateful slug generator that deduplicates anchors within a single
 * build. Repeated slugs receive `-2`, `-3`, ... suffixes; empty results fall
 * back to `section` (and `section-2`, ...).
 */
export function createSlugger(): (title: string) => string {
  const used = new Set<string>();
  return (title: string): string => {
    const base = slugifyBase(title) || 'section';
    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }
    used.add(candidate);
    return candidate;
  };
}
