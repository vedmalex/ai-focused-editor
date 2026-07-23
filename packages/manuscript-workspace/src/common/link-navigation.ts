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

// `parseBareEntityTags` (the `{ kind?, id, start, end }`-shaped wrapper that
// filtered `parseWikiLinks` down to unlabeled `class === 'entity'` matches)
// has been REMOVED (TASK-015 U-B). It was never re-exported through
// `common/index.ts` (the package's public barrel), so no external consumer
// could depend on it; its only three internal consumers
// (`SemanticEntityHoverContribution`, `BookDoctorContribution`,
// `SemanticLinkContribution`) have all migrated to `parseWikiLinks` directly.
// The migration also fixed a live regression the wrapper's narrowing silently
// caused: a colon-less bare `[[id]]` token (this project's own
// `[[sharan-108]]`-style corpus) classifies as `note` under the plan §1/§2
// entity/note discriminator, so it stopped being surfaced to hover/doctor at
// all — hover lost its entity card for such tokens, and the book doctor
// under-counted references, falsely reporting a referenced entity card as an
// orphan (`entityCardOrphanFindings`). Both consumers now apply an
// entity-first check (mirroring `resolveWikiToken`'s bare-id chain, U4)
// directly over `parseWikiLinks`'s `note`-class tokens instead of relying on
// this wrapper's blanket exclusion. The `{ kind?, id, start, end }` shape
// (`BareEntityTagMatch`) was removed alongside it, having no other use; see
// `link-navigation.test.ts` for the removed wrapper's former coverage.

/** One folded unlabeled `[[...]]` entity-tag occurrence (no `|alias`). */
export interface UnlabeledWikiEntityMatch {
  /** Tag kind (e.g. `char`), only for a `class === 'entity'` token; `undefined` for a bare `[[id]]`. */
  kind?: string;
  /** The referenced id — `entity`-class's `id`, or `note`-class's `notePath` (colon-less bare). */
  id: string;
}

/**
 * Collect every UNLABELED `[[...]]` token `parseWikiLinks` classifies as
 * `entity` OR `note` (colon-less bare — e.g. this project's own
 * `[[sharan-108]]`-style corpus), as the `{ kind?, id }` shape
 * `BookDoctorContribution.foldEntityTags` needs. `kind` stays `undefined` for
 * a `note`-class match, exactly the pre-TASK-013 bare-entity shape
 * `entityCardOrphanFindings`/`entityCardMissingFixes`/`entityUnknownKindFindings`
 * (`common/book-doctor.ts`) already expect ("a bare `[[id]]` matches any
 * kind"). Labeled (`|alias`) tokens are excluded (`parseSemanticMarkdown`'s
 * job) and so are `invalid`-class tokens (no usable id).
 *
 * TASK-015 U-B: this is the entity-side replacement for the removed
 * `parseBareEntityTags`, WIDENED to also cover `note`-class colon-less bare
 * tokens — the live regression the narrower wrapper silently introduced (see
 * the removal note above `UnlabeledWikiEntityMatch`).
 */
export function collectUnlabeledWikiEntityMatches(text: string): UnlabeledWikiEntityMatch[] {
  const matches: UnlabeledWikiEntityMatch[] = [];
  for (const link of parseWikiLinks(text)) {
    if (link.alias !== undefined || link.class === 'invalid') {
      continue;
    }
    if (link.class === 'entity' && link.id !== undefined) {
      matches.push({ kind: link.kind, id: link.id });
    } else if (link.class === 'note' && link.notePath !== undefined) {
      matches.push({ id: link.notePath });
    }
  }
  return matches;
}

/**
 * Resolve one classified `parseWikiLinks` token to an entity-hover candidate
 * `{ kind?, id }`, or `undefined` when the token should get NO entity hover.
 * An `entity`-class (colon-shaped) token always qualifies. A `note`-class
 * (colon-less bare, e.g. `[[sharan-108]]`) token qualifies ONLY when
 * `hasEntity(notePath)` reports a real entity by bare id — the entity-first
 * chain {@link resolveWikiToken} (in `semantic-link-contribution.ts`, U4)
 * already applies for click-navigation; this mirrors it for hover. A genuine
 * Obsidian-style note title (e.g. `[[My Chapter Notes]]`, no matching entity)
 * correctly returns `undefined`. Labeled (`|alias`) and `invalid`-class tokens
 * always return `undefined` too.
 *
 * Pure and synchronous: `hasEntity` is an injected predicate so the caller
 * decides when (and whether) to pay for an entity-list lookup — e.g.
 * `SemanticEntityHoverContribution.findTagAt` only calls this once a token's
 * range already contains the hover offset, never on every hover.
 */
export function wikiEntityHoverCandidate(
  link: WikiLinkMatch,
  hasEntity: (id: string) => boolean
): UnlabeledWikiEntityMatch | undefined {
  if (link.alias !== undefined) {
    return undefined;
  }
  if (link.class === 'entity' && link.id !== undefined) {
    return { kind: link.kind, id: link.id };
  }
  if (link.class === 'note' && link.notePath !== undefined && hasEntity(link.notePath)) {
    return { id: link.notePath };
  }
  return undefined;
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
