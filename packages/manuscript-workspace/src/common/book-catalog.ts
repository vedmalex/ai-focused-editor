/**
 * Pure (Theia-free) assembly for the "My Books" welcome-page catalog.
 *
 * The impure half — walking the library folder, confirming each candidate holds
 * a `manifest.yaml`, reading `metadata.yaml`, and turning a `cover.png` into a
 * renderable URI — lives in the browser widget (it needs `FileService`). This
 * module takes the already-scanned {@link RawBookCandidate} list (a folder path
 * plus its tolerantly-parsed metadata and an optional cover URI) and turns it
 * into the sorted {@link BookCatalogEntry} list the grid renders. Keeping the
 * coercion + sort here (no Theia imports) makes it unit-testable under `bun test`.
 */

/** One card in the "My Books" grid. */
export interface BookCatalogEntry {
  /**
   * URI string of the book folder — passed verbatim to
   * `WorkspaceService.open(new URI(path))` when the card is clicked.
   */
  path: string;
  /** Display title: `metadata.title` when usable, else the folder basename. */
  title: string;
  /** `metadata.author` when it is a non-empty string; omitted otherwise. */
  author?: string;
  /** Renderable cover URI (a `data:`/`file:` URI) when a cover was found. */
  coverUri?: string;
}

/**
 * A folder the scanner has already confirmed holds a `manifest.yaml` (i.e. it is
 * a book, not just any subdirectory).
 */
export interface RawBookCandidate {
  /** URI string of the book folder. */
  path: string;
  /**
   * The parsed `metadata.yaml` for this folder, tolerant of anything: the
   * scanner passes whatever `yaml.parse` returned, or `undefined` when the file
   * is absent or did not parse. Non-object shapes are ignored during assembly.
   */
  metadata?: unknown;
  /** A renderable cover URI when a `cover.png` was found, else `undefined`. */
  coverUri?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed non-empty string, or `undefined`. */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Tolerantly pull `title`/`author` out of a parsed metadata value. Any shape is
 * accepted: a non-object, or missing/blank/non-string fields, simply yield
 * `undefined` for that field.
 */
export function extractBookMeta(metadata: unknown): { title?: string; author?: string } {
  if (!isRecord(metadata)) {
    return {};
  }
  return {
    title: cleanString(metadata.title),
    author: cleanString(metadata.author)
  };
}

/**
 * Human-readable folder name from a URI/path string: the last non-empty path
 * segment, percent-decoded (so `My%20Book` → `My Book`). Falls back to the raw
 * input when there is no usable segment.
 */
export function basenameFromPath(path: string): string {
  // Drop a query/fragment and any trailing slashes, then take the last segment.
  const withoutTrailer = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const lastSlash = withoutTrailer.lastIndexOf('/');
  const segment = lastSlash >= 0 ? withoutTrailer.slice(lastSlash + 1) : withoutTrailer;
  if (!segment) {
    return path;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Assemble a single entry: metadata title (else basename), optional author/cover. */
export function buildBookCatalogEntry(candidate: RawBookCandidate): BookCatalogEntry {
  const meta = extractBookMeta(candidate.metadata);
  const entry: BookCatalogEntry = {
    path: candidate.path,
    title: meta.title ?? basenameFromPath(candidate.path)
  };
  if (meta.author) {
    entry.author = meta.author;
  }
  if (candidate.coverUri) {
    entry.coverUri = candidate.coverUri;
  }
  return entry;
}

/**
 * Turn scanned candidates into the display list, sorted by title
 * (case-/accent-insensitive, natural-number aware) with the folder path as a
 * stable tie-breaker so equal titles keep a deterministic order.
 */
export function buildBookCatalog(candidates: readonly RawBookCandidate[]): BookCatalogEntry[] {
  return candidates
    .map(buildBookCatalogEntry)
    .sort((a, b) => {
      const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
      return byTitle !== 0 ? byTitle : a.path.localeCompare(b.path);
    });
}
