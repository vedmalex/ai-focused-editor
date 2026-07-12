/**
 * PURE (no Obsidian imports) parsers + helpers for the book's source library:
 * `sources/citations.yaml` (a `{ citations: [...] }` list, or a bare list) and
 * `sources/excerpts.jsonl` (one JSON object per line). The shapes mirror the
 * studio's `source-library` contract (spec §5.4) — id + title are required for a
 * citation, text is required for an excerpt — but this module re-implements the
 * parse Theia-free so the plugin can index the same files under `bun test`.
 *
 * Also hosts the `[@…` cite-autocomplete trigger scan and ranking, and the
 * blockquote builder for the "Insert excerpt" command, so both stay unit-tested.
 */

import { parse } from 'yaml';

/** A bibliographic entry from `sources/citations.yaml`. */
export interface Citation {
  /** Stable citation id, referenced as `[@cite:id]`. */
  id: string;
  /** Display title (required by the contract). */
  title: string;
  /** Free-form source reference (a path or a bibliographic string). */
  source?: string;
  /** Optional author note. */
  note?: string;
}

/** A source excerpt from `sources/excerpts.jsonl`. */
export interface Excerpt {
  /** Stable excerpt id (falls back to `excerpt-N` when absent). */
  id: string;
  /** Citation id / label this excerpt is drawn from, when known. */
  sourceId?: string;
  /** Workspace-relative path of the originating source document, when known. */
  sourcePath?: string;
  /** The quoted text. */
  text: string;
  /** Optional author note. */
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/** A `source` string looks like a path when it has a slash or a file extension. */
function looksLikePath(value: string): boolean {
  return value.includes('/') || /\.[A-Za-z0-9]+$/.test(value);
}

/**
 * Parse `sources/citations.yaml` text into citations. Accepts either the
 * `{ citations: [...] }` document shape or a bare top-level list; entries missing
 * an id OR a title are dropped (matching the studio's required-field rule). A
 * malformed / empty file yields an empty list rather than throwing.
 */
export function parseCitations(text: string | undefined): Citation[] {
  if (!text || !text.trim()) {
    return [];
  }
  let document: unknown;
  try {
    document = parse(text);
  } catch {
    return [];
  }
  const records = Array.isArray(document)
    ? document
    : isRecord(document) && Array.isArray(document.citations)
      ? document.citations
      : undefined;
  if (!records) {
    return [];
  }
  const citations: Citation[] = [];
  for (const record of records) {
    if (!isRecord(record)) {
      continue;
    }
    const id = asString(record.id);
    const title = asString(record.title);
    if (!id || !title) {
      continue;
    }
    const citation: Citation = { id, title };
    const source = asString(record.source);
    if (source) {
      citation.source = source;
    }
    const note = asString(record.note);
    if (note) {
      citation.note = note;
    }
    citations.push(citation);
  }
  return citations;
}

/**
 * Parse `sources/excerpts.jsonl` text into excerpts, one JSON object per line.
 * Blank lines and lines that are not valid JSON objects are skipped; an entry
 * needs a non-empty `text`. The `sourceId` folds `source`/`sourceId`, and a
 * path-shaped source doubles as `sourcePath` (mirrors the studio parser).
 */
export function parseExcerpts(text: string | undefined): Excerpt[] {
  if (!text) {
    return [];
  }
  const excerpts: Excerpt[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line.length === 0) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) {
      continue;
    }
    const body = asString(record.text);
    if (!body) {
      continue;
    }
    const sourceId = asString(record.source) || asString(record.sourceId);
    const sourcePath = asString(record.sourcePath) || (looksLikePath(sourceId) ? sourceId : '');
    const excerpt: Excerpt = {
      id: asString(record.id) || `excerpt-${index + 1}`,
      text: body
    };
    if (sourceId) {
      excerpt.sourceId = sourceId;
    }
    if (sourcePath) {
      excerpt.sourcePath = sourcePath;
    }
    const note = asString(record.note) || asString(record.ref);
    if (note) {
      excerpt.note = note;
    }
    excerpts.push(excerpt);
  }
  return excerpts;
}

/** Active `[@…` cite-autocomplete trigger context, or null when not in one. */
export interface CiteContext {
  /** Character offset of the opening `[@`. */
  tokenStart: number;
  /** The prefix typed after `[@` (a leading `cite:` is stripped). */
  query: string;
}

// Chars allowed inside a citation id / typed prefix (unicode-aware; ids may be
// slugs like `smith2020` but author sources can carry non-latin scripts).
const CITE_PREFIX = /^[\p{L}\p{N}:._-]*$/u;

/**
 * Resolve the `[@…` autocomplete context at character offset `ch` on a line.
 * Fires from the nearest `[@` before the cursor when the run between it and the
 * cursor is a clean id prefix (no bracket, pipe, whitespace, or closing `]`). A
 * leading `cite:` the writer already typed is stripped from `query`.
 */
export function activeCiteContext(line: string, ch: number): CiteContext | null {
  const upto = line.slice(0, ch);
  const at = upto.lastIndexOf('[@');
  if (at === -1) {
    return null;
  }
  const between = upto.slice(at + 2);
  if (!CITE_PREFIX.test(between)) {
    return null;
  }
  return { tokenStart: at, query: between.replace(/^cite:/i, '') };
}

/**
 * Rank citations for a `[@` query. Empty query keeps source order; otherwise
 * matches (case-insensitively) on id, title, and source, ranking an id-prefix
 * hit above an id substring above a title/source hit. Non-matches drop out.
 */
export function rankCitations(citations: readonly Citation[], query: string): Citation[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...citations];
  }
  const scored: Array<{ citation: Citation; score: number; order: number }> = [];
  citations.forEach((citation, order) => {
    const id = citation.id.toLowerCase();
    const title = citation.title.toLowerCase();
    const source = (citation.source ?? '').toLowerCase();
    let score = 0;
    if (id.startsWith(needle)) {
      score = 4;
    } else if (id.includes(needle)) {
      score = 3;
    } else if (title.includes(needle)) {
      score = 2;
    } else if (source.includes(needle)) {
      score = 1;
    }
    if (score > 0) {
      scored.push({ citation, score, order });
    }
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map(entry => entry.citation);
}

/** The text inserted when a `[@` suggestion is accepted. */
export function citeInsertion(id: string): string {
  return `[@cite:${id}]`;
}

/**
 * Build the blockquote inserted by "Insert excerpt": every line of the excerpt
 * prefixed with `> `, then a trailing attribution line `> [@cite:id]` referencing
 * the excerpt's citation id (its `sourceId`, else its own `id`). The ref line is
 * omitted only when no id at all is available.
 */
export function buildExcerptBlockquote(excerpt: Excerpt): string {
  const lines = excerpt.text.split(/\r?\n/).map(line => `> ${line}`.trimEnd());
  const ref = excerpt.sourceId || excerpt.id;
  if (ref) {
    lines.push('>');
    lines.push(`> ${citeInsertion(ref)}`);
  }
  return lines.join('\n');
}
