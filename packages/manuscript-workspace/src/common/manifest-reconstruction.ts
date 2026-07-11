/**
 * Pure (Theia-free) manifest reconstruction for the Book Doctor.
 *
 * When an author opens an OLD folder where chapters already live on disk but the
 * `manifest.yaml` is missing (or does not yet list every file), the doctor uses
 * these helpers to rebuild the build manifest FROM the content:
 *  - {@link reconstructManifestEntries} turns a pre-listed set of Markdown files
 *    into a manifest tree (directories become parts, `.md` files become
 *    chapters), ordered with numeric prefixes first (natural sort);
 *  - {@link buildManifestYaml} serializes a fresh manifest document string that
 *    matches EXACTLY the schema `flattenManifestRows` reads
 *    (`{ version, content: [{ path, title, children? }] }`);
 *  - {@link appendEntriesToManifest} merges new entries into an EXISTING manifest
 *    comment-preservingly via the `yaml` Document API — a new chapter lands at the
 *    END of its parent part when that part already exists, otherwise the whole
 *    part subtree is appended at the end of `content`.
 *
 * All filesystem I/O stays in the browser layer: these functions operate on
 * already-listed files (`{ path, firstHeading? }`), so the tree/ordering/humanize
 * logic is unit-testable under `bun test`. Kept Theia-free (only `yaml`, which the
 * sibling `book-doctor`/`book-scaffold` modules already depend on).
 */

import { isMap, isSeq, parseDocument, stringify, YAMLMap, YAMLSeq } from 'yaml';
import { normalizeManifestPath } from './book-config-forms';

/**
 * One discovered manuscript candidate, as the browser walk hands it in: a
 * workspace-relative Markdown path plus (optionally) the first ATX heading the
 * browser extracted from the file's leading bytes.
 */
export interface DiscoveredManuscriptFile {
  /** Workspace-relative path (forward slashes). */
  path: string;
  /** First ATX heading text, if the browser found one in the leading bytes. */
  firstHeading?: string;
}

/** A reconstructed manifest node: a chapter (leaf) or a part (has children). */
export interface ReconstructedEntry {
  /** Workspace-relative path (original on-disk path, kept verbatim). */
  path: string;
  /** Display title (first heading / humanized name). */
  title: string;
  /** Present on parts (folders); a chapter is a leaf with no `children`. */
  children?: ReconstructedEntry[];
}

/** Options for {@link buildManifestYaml}. */
export interface BuildManifestOptions {
  /** Manifest schema `version` (defaults to 1). */
  version?: number;
}

/**
 * Top-level directory names excluded from manuscript discovery — these hold
 * build output, research sources, entities, AI config, and tooling metadata, not
 * chapter prose. Any path segment starting with `.` (hidden dir) is also skipped.
 */
export const MANUSCRIPT_DISCOVERY_EXCLUDED_DIRS: readonly string[] = [
  'build',
  'knowledge',
  'sources',
  'entities',
  'ai',
  '.theia',
  '.git',
  '.prompts',
  'node_modules'
];

/**
 * True when `name` is a directory the discovery walk must not descend into: an
 * excluded canonical folder or any hidden (`.`-prefixed) directory.
 */
export function isExcludedDiscoveryDir(name: string): boolean {
  return name.startsWith('.') || MANUSCRIPT_DISCOVERY_EXCLUDED_DIRS.includes(name);
}

/**
 * True when a workspace-relative path is a discoverable manuscript candidate: a
 * `.md` file none of whose ANCESTOR directories are excluded/hidden. Mirrors the
 * browser walk's pruning so callers can also post-filter a flat listing.
 */
export function isDiscoverableManuscriptPath(path: string): boolean {
  const norm = normalizeManifestPath(path);
  if (!/\.md$/i.test(norm)) {
    return false;
  }
  const segments = norm.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] && isExcludedDiscoveryDir(segments[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Extract the first ATX heading (`# …` through `###### …`, up to three leading
 * spaces, optional closing `#`s) from `text`, returning its trimmed content or
 * `undefined` when there is none. The browser feeds this the file's leading
 * bytes (~2 KB) so a restored chapter's real title becomes its manifest title.
 */
export function extractFirstHeading(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const heading = match[2].replace(/\s+#+\s*$/, '').trim();
    if (heading) {
      return heading;
    }
  }
  return undefined;
}

/**
 * Humanize a file/dir base name into a display title: strip a leading numeric
 * ordering prefix (`01-`, `2. `, `03_`), turn dashes/underscores into spaces,
 * collapse whitespace, and capitalize the first letter of each word. A name that
 * is entirely a numeric prefix (e.g. `01`) keeps its digits rather than emptying.
 */
export function humanizeName(name: string): string {
  const stripped = name.replace(/^\d+[\s._-]*/, '');
  const base = stripped.trim() ? stripped : name;
  const spaced = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) {
    return name;
  }
  return spaced
    .split(' ')
    .map(word => (word ? word[0].toLocaleUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Natural comparator: numeric-prefixed names first (2 < 10), then lexicographic. */
function naturalCompare(a: string, b: string): number {
  const na = /^(\d+)/.exec(a);
  const nb = /^(\d+)/.exec(b);
  if (na && nb) {
    const diff = parseInt(na[1], 10) - parseInt(nb[1], 10);
    if (diff !== 0) {
      return diff;
    }
    return a.slice(na[1].length).localeCompare(b.slice(nb[1].length));
  }
  if (na) {
    return -1;
  }
  if (nb) {
    return 1;
  }
  return a.localeCompare(b);
}

/** The sort key for an entry: its base name, with a trailing `.md` dropped for files. */
function sortKey(entry: ReconstructedEntry): string {
  const base = entry.path.split('/').pop() ?? entry.path;
  return entry.children ? base : base.replace(/\.md$/i, '');
}

/** Sort a sibling list in place (natural order), recursing into each part. */
function sortEntries(entries: ReconstructedEntry[]): void {
  entries.sort((a, b) => naturalCompare(sortKey(a), sortKey(b)));
  for (const entry of entries) {
    if (entry.children) {
      sortEntries(entry.children);
    }
  }
}

/**
 * Build the manifest tree from a pre-listed set of files. Directories become
 * PARTS (title = humanized folder name; original path kept), `.md` files become
 * CHAPTERS (title = first ATX heading when present, else humanized filename);
 * nested directories nest. A single leading `content/` segment — the canonical
 * manuscript root — is transparent (its immediate children become top-level
 * entries, matching the hand-authored manifest convention); every OTHER
 * directory level becomes a part. Non-`.md` and duplicate paths are ignored.
 * Siblings are natural-sorted (numeric prefixes first, then lexicographic).
 */
export function reconstructManifestEntries(files: DiscoveredManuscriptFile[]): ReconstructedEntry[] {
  const top: ReconstructedEntry[] = [];
  const parts = new Map<string, ReconstructedEntry>();
  const seen = new Set<string>();

  for (const file of files) {
    const path = normalizeManifestPath(file.path);
    if (!path || !/\.md$/i.test(path) || seen.has(path)) {
      continue;
    }
    seen.add(path);

    const segments = path.split('/');
    const fileName = segments.pop() ?? path;
    // The leading `content/` directory is the transparent manuscript root; every
    // deeper directory level becomes a part (its original path preserved).
    const start = segments[0] === 'content' ? 1 : 0;

    let container = top;
    for (let i = start; i < segments.length; i++) {
      const dirPath = segments.slice(0, i + 1).join('/');
      let part = parts.get(dirPath);
      if (!part) {
        part = { path: dirPath, title: humanizeName(segments[i]), children: [] };
        parts.set(dirPath, part);
        container.push(part);
      }
      container = part.children!;
    }

    container.push({
      path,
      title: file.firstHeading?.trim() || humanizeName(fileName.replace(/\.md$/i, ''))
    });
  }

  sortEntries(top);
  return top;
}

/** Convert a reconstructed entry to the plain `{ path, title, children? }` shape. */
function toPlain(entry: ReconstructedEntry): Record<string, unknown> {
  if (entry.children && entry.children.length > 0) {
    return { path: entry.path, title: entry.title, children: entry.children.map(toPlain) };
  }
  return { path: entry.path, title: entry.title };
}

/**
 * Serialize a FRESH manifest document string from reconstructed entries. The
 * shape parses to `{ version, content: [{ path, title, children? }] }` — exactly
 * what `flattenManifestRows` reads — and `yaml.stringify` quotes titles only when
 * required (colons, leading specials), so arbitrary/Cyrillic titles round-trip.
 */
export function buildManifestYaml(
  entries: ReconstructedEntry[],
  options?: BuildManifestOptions
): string {
  const version = options?.version ?? 1;
  return stringify({ version, content: entries.map(toPlain) });
}

/** Find a DIRECT child of `seq` whose `path` matches (normalized); undefined if none. */
function findDirectEntry(seq: YAMLSeq, path: string): YAMLMap | undefined {
  const target = normalizeManifestPath(path);
  for (const item of seq.items) {
    if (isMap(item)) {
      const entryPath = item.get('path');
      if (typeof entryPath === 'string' && normalizeManifestPath(entryPath) === target) {
        return item;
      }
    }
  }
  return undefined;
}

/** Get (or create + attach) the `children` sequence of a part entry. */
function ensureChildrenSeq(entry: YAMLMap): YAMLSeq {
  const children = entry.get('children');
  if (isSeq(children)) {
    return children;
  }
  const seq = new YAMLSeq();
  entry.set('children', seq);
  return seq;
}

/** Recursively merge new entries into a manifest content/children sequence. */
function mergeEntries(
  doc: ReturnType<typeof parseDocument>,
  seq: YAMLSeq,
  entries: ReconstructedEntry[]
): void {
  for (const entry of entries) {
    const match = findDirectEntry(seq, entry.path);
    if (match) {
      // The part already exists — descend and append the new chapters at its end.
      if (entry.children && entry.children.length > 0) {
        mergeEntries(doc, ensureChildrenSeq(match), entry.children);
      }
      // A leaf that already exists is left untouched (never duplicated).
      continue;
    }
    seq.items.push(doc.createNode(toPlain(entry)));
  }
}

/**
 * Append reconstructed entries to an EXISTING manifest, comment-preservingly, via
 * the `yaml` Document API. A new chapter whose parent part already exists lands
 * at the END of that part's children; a new part is appended at the end of
 * `content`. Existing entries are never moved, retitled, or removed — only new
 * paths are added. Returns the updated manifest text.
 */
export function appendEntriesToManifest(
  existingYamlText: string,
  newEntries: ReconstructedEntry[]
): string {
  const doc = parseDocument(existingYamlText);
  let content = doc.get('content');
  if (!isSeq(content)) {
    content = new YAMLSeq();
    doc.set('content', content);
  }
  mergeEntries(doc, content as YAMLSeq, newEntries);
  return doc.toString();
}
