/**
 * Pure, Theia-free lookup index over the workspace's markdown notes, plus a
 * pure title extractor — the shared logic behind the browser `NoteIndexService`
 * (TASK-013 §3/U3). Kept here (like `chapter-front-matter.ts` /
 * `link-navigation.ts`) so basename bucketing, duplicate handling, and
 * front-matter/H1 title extraction are unit-testable without a DOM or any
 * filesystem access — the browser service only adds the I/O (FileSearchService
 * listing, FileService reads/watch, debounce/TTL scheduling) around these
 * functions.
 */

import { parseChapterFrontMatter, type ChapterFrontMatterValue } from './chapter-front-matter';

/** One indexed note: its full path/URI string as supplied by the caller, and its `.md`-stripped basename (original case, for display). */
export interface NoteIndexEntry {
  /** Full workspace-relative or absolute URI/path string, as supplied by the caller — never mutated or normalized beyond trimming. */
  path: string;
  /** File basename with the trailing `.md` extension stripped, ORIGINAL case (for display; lookups use the lowercased key). */
  basename: string;
}

/**
 * Vault-wide note lookup structures, built once by {@link buildNoteIndex} and
 * kept fresh by the browser service.
 */
export interface NoteIndex {
  /** Lowercased basename -> every matching note's path, in encounter order. A basename with 2+ paths is a duplicate (tie-break/ambiguity is the resolver's job, not the index's). */
  byBasename: Map<string, string[]>;
  /** Flat list of every indexed note, in the order supplied to {@link buildNoteIndex}. */
  entries: NoteIndexEntry[];
  /**
   * Lazily-populated title -> path[] lookup (lowercased title as the key).
   * Array-valued to mirror `byBasename`'s multi-candidate shape — two notes can
   * legally share the same title, and `resolveNoteLink`'s tie-break (closest
   * candidate, then alphabetical) applies uniformly to both maps. Starts EMPTY
   * on every {@link buildNoteIndex} call — this is only the pure hook the index
   * exposes; actual title resolution (reading file content, parsing front
   * matter/H1, caching by mtime) is entirely the browser service's job via
   * {@link registerNoteTitle} on a basename-lookup miss.
   */
  titleIndex: Map<string, string[]>;
}

/**
 * Build a {@link NoteIndex} from a flat list of markdown file URIs/paths.
 * Pure and synchronous: no filesystem access, no Theia types. Entries that are
 * not strings, are blank, or do not end in `.md` (case-insensitive) are
 * silently dropped — the caller (FileSearchService result, or a fallback
 * FileService walk) is expected to already scope to markdown, but this stays
 * defensive since it is the ONLY validation the index performs.
 *
 * Basenames are bucketed case-insensitively (lowercased key) per TASK-013 §2/
 * §3 (flat vault-wide, case-insensitive lookup); duplicates are preserved in
 * `byBasename` in encounter order rather than deduplicated — resolving a
 * duplicate to a single path (nearest chapter, then alphabetical, per UR-004)
 * is the resolver's responsibility, not the index's.
 */
export function buildNoteIndex(uris: readonly string[]): NoteIndex {
  const entries: NoteIndexEntry[] = [];
  const byBasename = new Map<string, string[]>();

  for (const raw of uris) {
    if (typeof raw !== 'string') {
      continue;
    }
    const path = raw.trim();
    if (!path || !/\.md$/i.test(path)) {
      continue;
    }
    const basename = basenameOf(path);
    if (!basename) {
      continue;
    }
    entries.push({ path, basename });
    const key = basename.toLowerCase();
    const existing = byBasename.get(key);
    if (existing) {
      existing.push(path);
    } else {
      byBasename.set(key, [path]);
    }
  }

  return { byBasename, entries, titleIndex: new Map() };
}

/**
 * Extract the last path segment of `path` (accepting `/` or `\` separators)
 * with a trailing `.md` (case-insensitive) stripped, DECODED to its display/
 * lookup form (ISS-148).
 *
 * This is the ONE boundary decode point for the index. `FileSearchService.find`
 * hands us `FileUri.create(...).toString()` strings, which percent-encode every
 * non-ASCII byte (a Cyrillic `Замысел романа.md` arrives as
 * `%D0%97%D0%B0%D0%BC%D1%8B%D1%81%D0%B5%D0%BB%20...md`). The note names authors
 * type inside `[[...]]` — and that {@link resolveNoteLink} lowercases into its
 * lookup key — are plain Unicode, so WITHOUT decoding here the `byBasename` key
 * (and the displayed basename) stay percent-encoded and every non-ASCII note
 * resolves to nothing while ASCII notes (whose encoding is a no-op) work by
 * accident. Decoding the basename brings the KEY and the DISPLAY string into the
 * same decoded space the resolver and the autocomplete label already live in.
 *
 * The entry `path` VALUE is deliberately left in its original (percent-encoded)
 * form: post-ISS-144 every consumer passes `editor.uri.toString()` (also
 * percent-encoded) as the resolver's `documentPath`, so the directory-distance
 * tie-break compares like-for-like, and `new URI(path)` re-parses the encoded
 * string unchanged. Decoding only the basename fixes the lookup without
 * disturbing that path-representation invariant.
 */
function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const last = segments[segments.length - 1] ?? '';
  return decodeUriSegment(last).replace(/\.md$/i, '');
}

/** Percent-decode one URI path segment for display/lookup; malformed encoding is returned verbatim rather than throwing. */
function decodeUriSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Register a lazily-resolved title -> path mapping into `index.titleIndex`
 * (mutates the index's map in place; the index itself is otherwise a plain
 * data holder). Case-insensitive key (title lowercased and trimmed). A
 * blank/whitespace-only title is a no-op. A duplicate title is LEGAL — the
 * path is accumulated onto the existing candidate list (in encounter order),
 * never overwritten — mirroring `byBasename`'s duplicate-basename handling;
 * disambiguating 2+ candidates for the same title key is `resolveNoteLink`'s
 * tie-break job, not this function's.
 */
export function registerNoteTitle(index: NoteIndex, title: string, path: string): void {
  const key = title.trim().toLowerCase();
  if (!key) {
    return;
  }
  const existing = index.titleIndex.get(key);
  if (existing) {
    existing.push(path);
  } else {
    index.titleIndex.set(key, [path]);
  }
}

/**
 * Extract a display title from a note's raw markdown content: the
 * front-matter `title` field first (via {@link parseChapterFrontMatter}),
 * falling back to the first `# ` H1 heading in the body. Returns `undefined`
 * when neither is present (or both are blank) — never throws.
 *
 * Pure and synchronous; the browser service supplies the file content (read
 * via `FileService`) and caches the result by mtime — this function itself
 * does no I/O and no caching.
 */
export function extractNoteTitle(markdown: string): string | undefined {
  const parsed = parseChapterFrontMatter(markdown);

  const titleField = parsed.fields.find(field => field.key === 'title');
  if (titleField) {
    const text = frontMatterValueToPlainText(titleField.value);
    if (text && text.trim().length > 0) {
      return text.trim();
    }
  }

  const body = parsed.present ? parsed.body : markdown;
  const h1Match = /^#[ \t]+(.+)$/m.exec(body);
  if (h1Match) {
    const text = h1Match[1].trim();
    if (text) {
      return text;
    }
  }

  return undefined;
}

/** Flatten a typed front-matter field value (as produced by `chapter-front-matter.ts`) to plain text for title comparison; never throws. */
function frontMatterValueToPlainText(value: ChapterFrontMatterValue): string | undefined {
  switch (value.kind) {
    case 'text':
      return value.segments.map(segment => segment.type === 'text' ? segment.value : (segment.mention.label ?? segment.mention.raw)).join('');
    case 'raw':
    case 'date':
      return value.display;
    case 'list':
      return value.items.length > 0 ? frontMatterValueToPlainText(value.items[0]) : undefined;
    case 'empty':
    default:
      return undefined;
  }
}
