/**
 * Pure helpers for clickable Markdown navigation (semantic `[[kind:id|label]]`
 * entity tags + relative `[text](path.md#anchor)` links). Kept Theia/Monaco-free
 * so the range/resolution/skip rules are unit-testable in isolation; the browser
 * `SemanticLinkContribution` layers Monaco ranges and the opener command on top.
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

// `[[...]]` tokens whose content has no `|`, so labeled `[[kind:id|label]]` tags
// (handled by parseSemanticMarkdown) never match here — the two are complementary.
const BARE_ENTITY_TAG_PATTERN = /\[\[([^\[\]|\n]+)\]\]/g;

/**
 * Parse bare `[[id]]` and unlabeled `[[kind:id]]` entity references with their
 * offsets. Labeled `[[kind:id|label]]` tags are intentionally skipped (they carry
 * a `|` and are parsed by `parseSemanticMarkdown`).
 */
export function parseBareEntityTags(text: string): BareEntityTagMatch[] {
  const matches: BareEntityTagMatch[] = [];
  BARE_ENTITY_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_ENTITY_TAG_PATTERN.exec(text)) !== null) {
    const content = match[1].trim();
    if (!content) {
      continue;
    }
    const colon = content.indexOf(':');
    const kind = colon >= 0 ? content.slice(0, colon).trim() : undefined;
    const id = colon >= 0 ? content.slice(colon + 1).trim() : content;
    if (!id) {
      continue;
    }
    const entry: BareEntityTagMatch = { id, start: match.index, end: match.index + match[0].length };
    if (kind) {
      entry.kind = kind;
    }
    matches.push(entry);
  }
  return matches;
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
