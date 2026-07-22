/**
 * Pure helpers for clickable Markdown navigation (semantic `[[kind:id|label]]`
 * entity tags, Obsidian-style `[[note]]` wiki-links, + relative
 * `[text](path.md#anchor)` links). Kept Theia/Monaco-free so the range/
 * resolution/skip rules are unit-testable in isolation; the browser
 * `SemanticLinkContribution` layers Monaco ranges and the opener command on top.
 *
 * TASK-013: `parseWikiLinks` classifies every `[[...]]` token as `entity` /
 * `note` / `invalid` per plan §1/§2's discriminator (kind-prefix before the
 * first `:`). This classifier is a BY-HAND-SYNC SEAM with
 * `isValidBareEntityTag`/the entity/note split implemented independently in
 * `@ai-focused-editor/semantic-markdown` (`semantic-markdown.ts`) — the two
 * packages cannot share code (this package is browser-facing and depends on
 * `semantic-markdown`'s TYPES only, not vice versa), so both mirror the SAME
 * plan §1/§2 table by hand. Keep the table-driven test cases in both
 * `*.test.ts` files aligned when the grammar changes.
 */

import type { SemanticRange, SemanticTag } from '@ai-focused-editor/semantic-markdown';
import type { NarrativeEntityKind } from './narrative-entity-protocol';
import { tagKindToEntityKind as registryTagKindToEntityKind } from './entity-type-registry';

/**
 * Unicode-aware heading slug, mirroring `slugifyBase` from
 * `@ai-focused-editor/book-export` (src/slug.ts). Copied rather than imported so
 * this browser-facing module does not pull the exporter's `puppeteer-core`
 * dependency into the frontend bundle. Must stay in sync so `#anchor` links match
 * the anchors the EPUB/HTML exporters emit.
 */
export function slugifyBase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Map a semantic tag kind to its narrative entity kind. Characters use the
 * `char` shorthand inside tags (spec §3.4); every other kind is used verbatim.
 */
export function tagKindToEntityKind(kind: string): NarrativeEntityKind {
  return registryTagKindToEntityKind(kind) as NarrativeEntityKind;
}

/**
 * Range covering only the `[[kind:id` portion of a `[[kind:id|label]]` tag, from
 * the tag start up to (excluding) the `|`. Linkifying just the id part keeps the
 * label directly editable — clicking into the label never triggers navigation.
 * The `|` sits one column before the label (labels are single-line), so the end
 * is `labelRange.start` shifted back by one.
 */
export function semanticTagLinkRange(tag: SemanticTag): SemanticRange {
  const pipeCharacter = tag.labelRange.start.character - 1;
  return {
    start: { line: tag.range.start.line, character: tag.range.start.character },
    end: {
      line: tag.labelRange.start.line,
      character: Math.max(tag.range.start.character, pipeCharacter)
    }
  };
}

/** A bare/unlabeled entity reference: `[[id]]` or `[[kind:id]]` (no `|label`). */
export interface BareEntityTagMatch {
  /** Tag kind (e.g. `char`) when written `[[kind:id]]`; undefined for `[[id]]`. */
  kind?: string;
  /** Referenced entity id. */
  id: string;
  /** Start offset of the whole `[[...]]` token. */
  start: number;
  /** End offset (exclusive) of the whole `[[...]]` token. */
  end: number;
}

/** Offset range of a `[[...]]` token in the source text (0-based, end exclusive). */
export interface WikiLinkOffsetRange {
  start: number;
  end: number;
}

/**
 * Classification of a `[[...]]` token, per plan §1/§2's kind-prefix discriminator:
 * - `entity` — `path` (after stripping `|alias` and `#anchor`) contains `:` and the
 *   substring before the first `:` matches the Unicode-lowercase kind grammar
 *   (`^\p{Ll}[\p{L}\p{N}_-]*$`), AND the id after `:` is non-empty ASCII with no
 *   embedded whitespace.
 * - `note` — anything else with a non-empty `path` (spaces, Unicode, `/` all
 *   allowed — Obsidian-style note names/paths).
 * - `invalid` — empty `path`, or an entity-shaped prefix (kind grammar matches)
 *   whose id fails the ASCII/no-whitespace check (e.g. `[[char:krishna Krishna]]`
 *   — plan §1's documented regression-guard case).
 */
export type WikiLinkClass = 'entity' | 'note' | 'invalid';

/**
 * One classified `[[...]]` token from `parseWikiLinks`. Fields are populated per
 * `class`: `entity` sets `kind`+`id`; `note` sets `notePath`; either may carry
 * `anchor` (first `#...` segment) and/or `alias` (first `|...` segment, display-
 * only per UR-004/005). `invalid` carries whatever partial fields were parsed
 * (e.g. `kind` for a kind-shaped prefix with a bad id) for diagnostics.
 */
export interface WikiLinkMatch {
  class: WikiLinkClass;
  /** Entity kind (Unicode-lowercase), only for `class === 'entity'` (or a
   *  kind-shaped `invalid` whose id failed validation). */
  kind?: string;
  /** Entity id (ASCII, no whitespace), only for `class === 'entity'`. */
  id?: string;
  /** Note name/path (spaces, Unicode, `/` allowed), only for `class === 'note'`. */
  notePath?: string;
  /** First `#anchor` segment (heading slug target), when present. */
  anchor?: string;
  /** First `|alias` segment (display label only — never affects resolution). */
  alias?: string;
  /** The whole matched `[[...]]` token, unmodified. */
  raw: string;
  /** Offset range of the whole token in the source text. */
  range: WikiLinkOffsetRange;
}

// Kind-grammar discriminator (plan §1/§9-ISS-136): Unicode-lowercase first
// character (so Cyrillic/other-script kinds like `персонаж:` work), then any mix
// of letters/digits/`_`/`-`. Superset of the pre-TASK-013 `[a-z][\w-]*` ASCII
// grammar, so the existing ASCII corpus keeps matching.
const WIKI_KIND_PATTERN = /^\p{Ll}[\p{L}\p{N}_-]*$/u;

// Entity id grammar: the SAME strict ASCII charset the validator uses
// (semantic-markdown.ts SEMANTIC_ENTITY_ID_PATTERN) — the two by-hand-synced
// classifiers MUST agree, or a token the validator flags red would still get
// link/decoration treatment here (seam divergence). A kind-shaped token whose
// id falls outside this charset (e.g. `[[c:some/path]]`, `[[char:krishna
// Krishna]]`) is `invalid` in BOTH classifiers — the plan §1/ISS-140 documented
// trade-off: such names cannot be note-linked without a path escape-hatch.
const WIKI_ENTITY_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

// `[[...]]` tokens, single-line only (no embedded `[`, `]`, or newline) — mirrors
// how both the labeled-tag scan and the old bare-tag scan treat a token as
// exactly one line; a `[[` with no `]]` before the next newline simply does not
// match (left as plain text), same as before.
const WIKI_LINK_TOKEN_PATTERN = /\[\[([^[\]\n]*)\]\]/g;

/**
 * Single unified scan of every `[[...]]` token in `text`, classified per plan
 * §1/§2 (see `WikiLinkClass`/`WikiLinkMatch`). Supersedes the old
 * `parseBareEntityTags`/`parseSemanticMarkdown`-tag split: this one function
 * covers labeled and unlabeled entity tags AND Obsidian-style note links in a
 * single pass, so callers only need one offset/classification source of truth.
 */
export function parseWikiLinks(text: string): WikiLinkMatch[] {
  const matches: WikiLinkMatch[] = [];
  WIKI_LINK_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKI_LINK_TOKEN_PATTERN.exec(text)) !== null) {
    const raw = match[0];
    const range: WikiLinkOffsetRange = { start: match.index, end: match.index + raw.length };
    matches.push(classifyWikiLinkToken(match[1], raw, range));
  }
  return matches;
}

function classifyWikiLinkToken(inner: string, raw: string, range: WikiLinkOffsetRange): WikiLinkMatch {
  // 1) Split off `|alias` (first `|` wins) — display-only, never affects
  //    resolution (UR-004/005).
  const pipeIndex = inner.indexOf('|');
  const beforeAlias = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
  const alias = pipeIndex >= 0 ? inner.slice(pipeIndex + 1) : undefined;

  // 2) Split off `#anchor` (first `#` wins) from what's left.
  const hashIndex = beforeAlias.indexOf('#');
  const rawPath = hashIndex >= 0 ? beforeAlias.slice(0, hashIndex) : beforeAlias;
  const anchorSegment = hashIndex >= 0 ? beforeAlias.slice(hashIndex + 1) : undefined;
  const anchor = anchorSegment ? anchorSegment : undefined;

  const path = rawPath.trim();
  if (!path) {
    return { class: 'invalid', alias, anchor, raw, range };
  }

  // 3) Discriminator: `path` contains `:` AND the prefix before the first `:`
  //    matches the kind grammar => entity intent; otherwise => note.
  const colonIndex = path.indexOf(':');
  if (colonIndex > 0) {
    const kindCandidate = path.slice(0, colonIndex);
    if (WIKI_KIND_PATTERN.test(kindCandidate)) {
      const id = path.slice(colonIndex + 1);
      if (id && WIKI_ENTITY_ID_PATTERN.test(id)) {
        return { class: 'entity', kind: kindCandidate, id, alias, anchor, raw, range };
      }
      // Kind-shaped prefix but the id fails ASCII/no-whitespace — regression-
      // guard case from plan §1 (`[[char:krishna Krishna]]`), stays Invalid
      // rather than falling back to a note interpretation.
      return { class: 'invalid', kind: kindCandidate, alias, anchor, raw, range };
    }
  }

  return { class: 'note', notePath: path, alias, anchor, raw, range };
}

/**
 * @deprecated Prefer `parseWikiLinks` directly. This wrapper filters its results
 * down to unlabeled (`alias === undefined`) `class === 'entity'` matches to keep
 * the pre-TASK-013 `{ kind?, id, start, end }` shape for callers that have not
 * migrated yet (browser `SemanticLinkContribution`/hover/doctor consumers —
 * plan §4 U4-U6).
 *
 * NOT a full-equivalence shim (plan §9, ISS-138): note-shaped bare tokens that
 * used to come back as a kind-less bare entity (e.g. `[[sharan-108]]`,
 * `[[frodo]]` — no `:` in the content) now classify as `note` under the
 * entity/note discriminator and are INTENTIONALLY EXCLUDED here. That is the
 * point of TASK-013 (distinguishing note references from entity references), not
 * a regression to patch around. Labeled (`|alias`) entity tags remain excluded
 * too, matching the original "bare" contract — those are `parseSemanticMarkdown`
 * tags. Remove this wrapper once all internal consumers migrate to
 * `parseWikiLinks`.
 */
export function parseBareEntityTags(text: string): BareEntityTagMatch[] {
  const matches: BareEntityTagMatch[] = [];
  for (const link of parseWikiLinks(text)) {
    if (link.class !== 'entity' || link.alias !== undefined || link.id === undefined) {
      continue;
    }
    const entry: BareEntityTagMatch = { id: link.id, start: link.range.start, end: link.range.end };
    if (link.kind) {
      entry.kind = link.kind;
    }
    matches.push(entry);
  }
  return matches;
}

/** Result of resolving an Obsidian-style `[[note]]` reference to a workspace file. */
export interface ResolvedNoteLink {
  /** Vault-relative path (as stored in the index) of the resolved file. */
  path: string;
  /**
   * `true` only for a genuine equal-distance tie among 2+ candidates (plan
   * §2/UR-005(1)): `path` is then the alphabetically-first tied candidate and
   * `candidates` lists the full tied set for a click-time picker. A clear
   * single closest candidate resolves WITHOUT this flag — no diagnostic needed.
   */
  ambiguous?: boolean;
  /** The tied candidate paths, sorted alphabetically, only set when `ambiguous`. */
  candidates?: string[];
}

/**
 * Resolve an Obsidian-style note reference (the `notePath` half of a `note`-class
 * `WikiLinkMatch`, i.e. with `|alias`/`#anchor` already stripped) to a workspace
 * file, following Obsidian's flat vault-wide basename lookup (UR-004(1)):
 *
 * - A target containing `/` is a vault-relative PATH (not resolved against
 *   `documentPath`'s directory — plan §3 supersedes the original "current
 *   folder or above" idea in favour of full Obsidian parity): matched
 *   case-insensitively against `index` entries whose basename matches the
 *   target's last segment, keeping only those whose full path ends with the
 *   (case-insensitive, `.md`-optional) target.
 * - A bare target (no `/`) is looked up by lowercased basename (`.md` optional)
 *   directly in `index`.
 * - When the basename lookup misses and `titleIndex` is supplied, retries by the
 *   same lowercased key against the title map (front-matter `title:` / first H1
 *   — plan §3/UR-005(2); building that priority is `NoteIndexService`'s job, not
 *   this function's — it just does the same generic lookup+tie-break here too).
 *
 * Duplicate basenames resolve to the candidate closest to `documentPath` (fewest
 * directory steps to a common ancestor); an exact tie resolves to the
 * alphabetically-first candidate with `ambiguous: true` (plan §2/UR-005(1)).
 * Returns `undefined` when nothing matches (caller falls through to
 * title/H1 fallback, then unresolved — plan §3's chain).
 */
export function resolveNoteLink(
  notePath: string,
  documentPath: string,
  index: Map<string, string[]>,
  titleIndex?: Map<string, string[]>
): ResolvedNoteLink | undefined {
  const trimmed = notePath.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.includes('/')) {
    return resolveVaultRelativeNotePath(trimmed, documentPath, index);
  }

  const lookupKey = stripMdExtension(trimmed).toLowerCase();

  const byBasename = index.get(lookupKey);
  if (byBasename && byBasename.length > 0) {
    return pickClosestCandidate(byBasename, documentPath);
  }

  const byTitle = titleIndex?.get(lookupKey);
  if (byTitle && byTitle.length > 0) {
    return pickClosestCandidate(byTitle, documentPath);
  }

  return undefined;
}

function resolveVaultRelativeNotePath(
  rawPath: string,
  documentPath: string,
  index: Map<string, string[]>
): ResolvedNoteLink | undefined {
  const withMd = ensureMdExtension(rawPath).replace(/^\/+/, '');
  const basenameKey = stripMdExtension(posixBasename(withMd)).toLowerCase();
  const candidates = index.get(basenameKey);
  if (!candidates || candidates.length === 0) {
    return undefined;
  }

  const targetLower = withMd.toLowerCase();
  const matches = candidates.filter(candidate => {
    const normalized = candidate.replace(/^\/+/, '').toLowerCase();
    return normalized === targetLower || normalized.endsWith(`/${targetLower}`);
  });
  if (matches.length === 0) {
    return undefined;
  }
  return pickClosestCandidate(matches, documentPath);
}

/** Directory segments of a path, excluding the file's own basename. */
function directorySegments(path: string): string[] {
  const normalized = path.replace(/^\/+/, '');
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) {
    return [];
  }
  return normalized.slice(0, slash).split('/').filter(Boolean);
}

/**
 * Tree distance between two paths' directories: steps up from `candidatePath`'s
 * directory to the nearest common ancestor, plus steps down to `documentPath`'s
 * directory. Lower is "closer" (plan §2's duplicate-basename tie-break).
 */
function pathDistance(candidatePath: string, documentPath: string): number {
  const candidateDirs = directorySegments(candidatePath);
  const documentDirs = directorySegments(documentPath);
  let common = 0;
  while (
    common < candidateDirs.length &&
    common < documentDirs.length &&
    candidateDirs[common] === documentDirs[common]
  ) {
    common++;
  }
  return candidateDirs.length - common + (documentDirs.length - common);
}

function pickClosestCandidate(candidates: string[], documentPath: string): ResolvedNoteLink {
  const withDistance = candidates.map(path => ({ path, distance: pathDistance(path, documentPath) }));
  const minDistance = Math.min(...withDistance.map(entry => entry.distance));
  const closest = withDistance.filter(entry => entry.distance === minDistance).map(entry => entry.path);

  if (closest.length === 1) {
    return { path: closest[0] };
  }

  const sorted = [...closest].sort((a, b) => a.localeCompare(b));
  return { path: sorted[0], ambiguous: true, candidates: sorted };
}

/**
 * Where a new file for an unresolved `[[note]]` reference should be created
 * (plan §2/UR-004(3)/UR-005(4)): a path IN the link wins (resolved against
 * `rootPath`, vault-relative — `[[folder/note]]` creates under `folder/`); a
 * bare `[[note]]` creates alongside the current chapter (`documentPath`'s
 * directory). A `.md` suffix is appended when missing. Returns an absolute
 * POSIX path (same convention as `resolveRelativeLink`).
 */
export function noteCreatePath(notePath: string, documentPath: string, rootPath: string): string {
  const trimmed = notePath.trim();
  const withMd = ensureMdExtension(trimmed);
  if (withMd.includes('/')) {
    return normalizePosix(`${normalizePosix(rootPath)}/${withMd}`);
  }
  const chapterDir = posixDirname(documentPath);
  return normalizePosix(`${chapterDir}/${withMd}`);
}

/**
 * Content for a newly-created note file (plan §2/UR-005(4)): a single
 * `# <Name>` heading line, no front-matter, where `<Name>` is the link's last
 * path segment with any `.md` suffix stripped.
 */
export function noteCreateContent(notePath: string): string {
  const trimmed = notePath.trim();
  const withoutMd = stripMdExtension(trimmed);
  const segments = withoutMd.split('/');
  const name = segments[segments.length - 1] || withoutMd;
  return `# ${name}\n`;
}

function ensureMdExtension(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

function stripMdExtension(path: string): string {
  return path.replace(/\.md$/i, '');
}

/** POSIX basename: everything after the last `/`, or the whole string when there is none. */
function posixBasename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** A relative Markdown link resolved to a workspace-internal target. */
export interface ResolvedRelativeLink {
  /** Absolute POSIX path of the target file, guaranteed inside the workspace root. */
  path: string;
  /** Heading anchor slug (without the leading `#`), when the link carried one. */
  anchor?: string;
}

/**
 * True for link targets that must NOT be linkified as workspace files: empty,
 * in-page `#anchor`-only references, `scheme://` URLs (http(s), file, ...), and
 * `mailto:`/`tel:`/`data:`/`javascript:` links.
 */
export function isSkippableLinkTarget(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return true;
  }
  return /^(?:mailto|tel|data|javascript):/i.test(trimmed);
}

/** Split a `path#anchor` target into its path and optional anchor (first `#` wins). */
export function splitLinkAnchor(target: string): { path: string; anchor?: string } {
  const hash = target.indexOf('#');
  if (hash < 0) {
    return { path: target };
  }
  const anchor = target.slice(hash + 1);
  const path = target.slice(0, hash);
  return anchor ? { path, anchor } : { path };
}

/**
 * Resolve a relative Markdown link target against the current document's
 * directory and the workspace root. Returns the resolved absolute POSIX path plus
 * any `#anchor`, or `undefined` when the target should be skipped (external URL,
 * `#`-only, or escaping the workspace root). No filesystem check is performed —
 * only path arithmetic and the workspace-root guard.
 *
 * `documentPath` and `workspaceRootPath` are POSIX URI paths (e.g. `URI.path`).
 * A leading `/` on the target resolves against the workspace root; anything else
 * resolves against the document's directory.
 */
export function resolveRelativeLink(
  rawTarget: string,
  documentPath: string,
  workspaceRootPath: string
): ResolvedRelativeLink | undefined {
  if (typeof rawTarget !== 'string') {
    return undefined;
  }
  const target = rawTarget.trim();
  if (isSkippableLinkTarget(target)) {
    return undefined;
  }

  const { path: rawPath, anchor } = splitLinkAnchor(target);
  if (!rawPath) {
    return undefined;
  }

  const relativePath = safeDecode(rawPath);
  const rootPath = normalizePosix(workspaceRootPath);
  const base = relativePath.startsWith('/') ? rootPath : posixDirname(documentPath);
  const resolved = normalizePosix(`${base}/${relativePath}`);

  if (!isInsideRoot(resolved, rootPath)) {
    return undefined;
  }

  return anchor ? { path: resolved, anchor } : { path: resolved };
}

/**
 * Find the 0-based line of the heading whose slug matches `anchor`, or
 * `undefined` when none matches. Heading text and anchor are both run through
 * `slugifyBase`, so already-slugged anchors (`#chapter-one`) match idempotently.
 */
export function findHeadingLine(text: string, anchor: string): number | undefined {
  const target = slugifyBase(safeDecode(anchor));
  if (!target) {
    return undefined;
  }
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const heading = HEADING_PATTERN.exec(lines[index]);
    if (heading && slugifyBase(heading[1]) === target) {
      return index;
    }
  }
  return undefined;
}

// ATX heading (`# .. ######`), tolerating up to 3 leading spaces and trailing `#`.
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** POSIX dirname: everything before the last `/`, or `.` when there is none. */
function posixDirname(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash < 0) {
    return '.';
  }
  return slash === 0 ? '/' : path.slice(0, slash);
}

/** Collapse `.`/`..` segments; keeps a leading `/` for absolute paths. */
function normalizePosix(path: string): string {
  const isAbsolute = path.startsWith('/');
  const stack: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push('..');
      }
      continue;
    }
    stack.push(part);
  }
  return (isAbsolute ? '/' : '') + stack.join('/');
}

function isInsideRoot(resolved: string, root: string): boolean {
  if (root === '' || root === '/') {
    return resolved.startsWith('/');
  }
  return resolved === root || resolved.startsWith(`${root}/`);
}
