/**
 * Pure, Theia-free parser for a chapter's YAML front-matter block (the leading
 * `---`…`---` fence), producing a TYPED field model an Obsidian-style
 * "Properties" panel can render directly. Kept in `common/` (like
 * `preview-images.ts` / `link-navigation.ts`) so extraction/typing is
 * unit-testable without a DOM; the browser `SemanticMarkdownPreviewWidget`
 * layers rendering (icons, click-to-open wiki-links) on top.
 *
 * Scope (UR-002/REQ-007): read-only. Nothing here writes back to the file —
 * the Obsidian companion plugin owns the on-disk YAML, and this module only
 * ever reads it to build a display model.
 */

import { splitEntityMentions, type EntityMentionSegment } from './entity-mentions';
import { parse as parseYaml } from 'yaml';

/**
 * The well-known chapter front-matter fields (REQ-007): slug, title, type,
 * summary, updated, source, language. Any other top-level key is still typed
 * by its YAML shape (list/date/text/scalar) and rendered — passthrough, not
 * dropped — but is not one of these seven.
 */
const KNOWN_FIELD_KEYS: ReadonlySet<string> = new Set([
  'slug', 'title', 'type', 'summary', 'updated', 'source', 'language'
]);

/** Fields whose scalar value is typed as a date (icon + date styling) when it looks like one. */
const DATE_FIELD_KEYS: ReadonlySet<string> = new Set(['updated']);

/** One typed value inside a front-matter field, discriminated by `kind`. */
export type ChapterFrontMatterValue =
  | { kind: 'date'; display: string }
  | { kind: 'list'; items: ChapterFrontMatterValue[] }
  | { kind: 'text'; segments: EntityMentionSegment[] }
  | { kind: 'empty' }
  | { kind: 'raw'; display: string };

/** One top-level front-matter key, typed and labelled for display. */
export interface ChapterFrontMatterField {
  /** The literal YAML key, e.g. `slug`, `updated`, or an author-defined key. */
  key: string;
  /** Humanised display label, e.g. `slug` -> `Slug`, `sortOrder` -> `Sort order`. */
  label: string;
  /** Whether `key` is one of the seven well-known chapter fields (REQ-007). */
  known: boolean;
  value: ChapterFrontMatterValue;
}

/** Result of parsing a chapter markdown document's leading front matter. */
export interface ChapterFrontMatterResult {
  /** Whether a `---`…`---` fence was found at the top of the document at all. */
  present: boolean;
  /**
   * Typed fields in front-matter key order. Empty when `present` is false, when
   * the fence enclosed no keys, or when `parseError` is set.
   */
  fields: ChapterFrontMatterField[];
  /** Markdown body with the front-matter fence stripped (unchanged when `present` is false). */
  body: string;
  /** Set when the fence was found but its YAML failed to parse, or was not a mapping. */
  parseError?: string;
  /** Raw YAML block text — populated only when `parseError` is set, for a graceful fallback display. */
  rawBlock?: string;
}

// A leading `---` fence (optional BOM, trailing spaces/tabs, \r\n or \n), a
// YAML body captured LINE BY LINE — each content line is only consumed while
// it does NOT itself look like a closing fence (the negative lookahead) — and
// a closing `---` line. The line-by-line capture (rather than a single
// `([\s\S]*?)\r?\n---` non-greedy group) is deliberate: that simpler form
// cannot match a genuinely EMPTY front-matter block (`---\n---\n`, zero
// content lines) because it always demands a newline strictly BEFORE the
// closing fence, on top of the one that already ended the opening line.
// Mirrors the `SKILL.md` frontmatter fence used elsewhere in this codebase
// (manuscript-tree-model.ts's parseSkillFrontmatter) and Obsidian's own
// front-matter contract, so the same chapter file parses identically in both
// tools.
const FRONT_MATTER_PATTERN = /^﻿?---[ \t]*\r?\n((?:(?!---[ \t]*(?:\r?\n|$)).*(?:\r?\n|$))*)---[ \t]*(?:\r?\n|$)/;

interface ExtractedBlock {
  yamlText: string;
  body: string;
}

/** Split a leading front-matter fence off `markdown`, or `undefined` when none is found. */
function extractFrontMatterBlock(markdown: string): ExtractedBlock | undefined {
  const match = FRONT_MATTER_PATTERN.exec(markdown);
  if (!match) {
    return undefined;
  }
  return { yamlText: match[1], body: markdown.slice(match[0].length) };
}

/**
 * Humanise a YAML key into a display label: `slug` -> `Slug`,
 * `sortOrder`/`sort_order`/`sort-order` -> `Sort order`. Applied uniformly to
 * known and passthrough fields alike — the seven well-known keys are already
 * single lower-case words, so this produces the same labels a fixed mapping
 * would, without needing one.
 */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (spaced.length === 0) {
    return key;
  }
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1).toLowerCase()}`;
}

/** Recognise a date-field scalar without reformatting it (timezone-safe: the raw text is kept). */
function toDateValue(raw: unknown): { kind: 'date'; display: string } | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return undefined;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return { kind: 'date', display: trimmed };
}

/** Type one YAML value (recursing into list items) into a {@link ChapterFrontMatterValue}. */
function toFieldValue(raw: unknown, isDateField: boolean): ChapterFrontMatterValue {
  if (Array.isArray(raw)) {
    return { kind: 'list', items: raw.map(item => toFieldValue(item, isDateField)) };
  }
  if (raw === null || raw === undefined) {
    return { kind: 'empty' };
  }
  if (isDateField) {
    const date = toDateValue(raw);
    if (date) {
      return date;
    }
  }
  if (typeof raw === 'string') {
    return raw.length === 0 ? { kind: 'empty' } : { kind: 'text', segments: splitEntityMentions(raw) };
  }
  if (typeof raw === 'boolean' || typeof raw === 'number') {
    return { kind: 'raw', display: String(raw) };
  }
  if (typeof raw === 'object') {
    try {
      return { kind: 'raw', display: JSON.stringify(raw) };
    } catch {
      return { kind: 'raw', display: String(raw) };
    }
  }
  return { kind: 'raw', display: String(raw) };
}

/**
 * Parse a chapter markdown document's leading front-matter fence into a typed
 * field model, read-only. Never throws: a missing fence yields
 * `present: false`; a malformed YAML body or a non-mapping top level yields
 * `present: true` with `parseError` (+ `rawBlock`) set and no fields — the
 * caller decides how to fall back (raw block, an error notice, or both).
 */
export function parseChapterFrontMatter(markdown: string): ChapterFrontMatterResult {
  const extracted = extractFrontMatterBlock(markdown);
  if (!extracted) {
    return { present: false, fields: [], body: markdown };
  }

  let document: unknown;
  try {
    document = parseYaml(extracted.yamlText);
  } catch (error) {
    return {
      present: true,
      fields: [],
      body: extracted.body,
      parseError: error instanceof Error ? error.message : String(error),
      rawBlock: extracted.yamlText
    };
  }

  // An empty (or whitespace/comment-only) fence parses to `null`/`undefined` —
  // a legitimately empty front matter block, not an error: no fields, no notice.
  if (document === null || document === undefined) {
    return { present: true, fields: [], body: extracted.body };
  }

  if (typeof document !== 'object' || Array.isArray(document)) {
    return {
      present: true,
      fields: [],
      body: extracted.body,
      parseError: 'Front matter is not a mapping (expected "key: value" pairs).',
      rawBlock: extracted.yamlText
    };
  }

  const record = document as Record<string, unknown>;
  const fields: ChapterFrontMatterField[] = Object.keys(record).map(key => ({
    key,
    label: humanizeKey(key),
    known: KNOWN_FIELD_KEYS.has(key),
    value: toFieldValue(record[key], DATE_FIELD_KEYS.has(key))
  }));

  return { present: true, fields, body: extracted.body };
}
