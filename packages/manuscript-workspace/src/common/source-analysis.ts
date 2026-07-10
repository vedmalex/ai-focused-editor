/*
 * spec §5.4 — "Extract and re-analyze source documents": pure helpers.
 *
 * These functions turn a raw AI response into normalized excerpt/citation
 * records and derive the shapes appended to `sources/excerpts.jsonl` and merged
 * into `sources/citations.yaml`. They contain no Theia, Node, or DOM imports so
 * they can be unit-tested with `bun test` and shared across process boundaries.
 */

import { extractJsonValue } from './knowledge-generation';

/** A quotable passage the model extracted from a source document. */
export interface AnalyzedExcerpt {
  text: string;
  note?: string;
  ref?: string;
}

/** A bibliographic-style entry the source document supports. */
export interface AnalyzedCitation {
  id: string;
  title?: string;
  source?: string;
  note?: string;
}

/** Normalized `{ excerpts, citations }` payload extracted from a model response. */
export interface SourceAnalysis {
  excerpts: AnalyzedExcerpt[];
  citations: AnalyzedCitation[];
}

/** One JSON line appended to `sources/excerpts.jsonl` (matches the parser shape). */
export interface ExcerptRecord {
  id: string;
  sourcePath: string;
  text: string;
  note?: string;
  /** Workspace-relative manuscript file this excerpt links back to. */
  targetPath?: string;
  /** 1-based line revealed when the Sources view opens the target file. */
  targetLine?: number;
}

/** Slug/path/continuation options for {@link buildExcerptRecords}. */
export interface BuildExcerptOptions {
  /** Slug prefix for generated ids (typically the source file slug). */
  sourceSlug: string;
  /** Workspace-relative path of the analyzed source document. */
  sourcePath: string;
  /** Number of excerpts already indexed for this slug; ids continue past it. */
  startIndex: number;
}

/** Result of merging new citations against the ids already present on disk. */
export interface CitationDedupeResult {
  added: AnalyzedCitation[];
  skipped: string[];
}

/**
 * Robustly turn a raw model response into a normalized analysis. Tolerant of
 * fenced/prose-wrapped JSON (via {@link extractJsonValue}); missing or malformed
 * arrays coerce to empty lists rather than throwing.
 */
export function coerceSourceAnalysis(rawText: string): SourceAnalysis {
  const value = extractJsonValue(rawText);
  return {
    excerpts: normalizeExcerpts(value),
    citations: normalizeCitations(value)
  };
}

/**
 * Normalize the `excerpts` array of a payload (or a bare array). Each entry
 * needs a non-empty `text`; blank entries are dropped.
 */
export function normalizeExcerpts(value: unknown): AnalyzedExcerpt[] {
  const raw = pickArray(value, 'excerpts');
  if (!raw) {
    return [];
  }
  const excerpts: AnalyzedExcerpt[] = [];
  for (const entry of raw) {
    const excerpt = toExcerpt(entry);
    if (excerpt) {
      excerpts.push(excerpt);
    }
  }
  return excerpts;
}

/**
 * Normalize the `citations` array of a payload (or a bare array). Each entry
 * needs a non-empty `id`; entries without one are dropped.
 */
export function normalizeCitations(value: unknown): AnalyzedCitation[] {
  const raw = pickArray(value, 'citations');
  if (!raw) {
    return [];
  }
  const citations: AnalyzedCitation[] = [];
  for (const entry of raw) {
    const citation = toCitation(entry);
    if (citation) {
      citations.push(citation);
    }
  }
  return citations;
}

/**
 * Build the `sources/excerpts.jsonl` records for a batch of excerpts. Ids are
 * `<sourceSlug>-<N>` continuing past `startIndex` (the count already indexed for
 * that slug), and `note` folds in the model's optional `ref` when no note given.
 */
export function buildExcerptRecords(
  excerpts: AnalyzedExcerpt[],
  options: BuildExcerptOptions
): ExcerptRecord[] {
  const slug = options.sourceSlug || 'source';
  const start = Number.isFinite(options.startIndex) && options.startIndex > 0
    ? Math.floor(options.startIndex)
    : 0;
  return excerpts.map((excerpt, index) => {
    const record: ExcerptRecord = {
      id: `${slug}-${start + index + 1}`,
      sourcePath: options.sourcePath,
      text: excerpt.text
    };
    const note = excerpt.note ?? excerpt.ref;
    if (note) {
      record.note = note;
    }
    return record;
  });
}

/**
 * Split incoming citations into those to add and the ids to skip. An id already
 * present on disk (or repeated within this batch) is skipped rather than merged,
 * so existing `citations.yaml` entries are never overwritten.
 */
export function dedupeCitations(
  citations: AnalyzedCitation[],
  existingIds: Iterable<string>
): CitationDedupeResult {
  const seen = new Set<string>();
  for (const id of existingIds) {
    if (typeof id === 'string' && id) {
      seen.add(id);
    }
  }
  const added: AnalyzedCitation[] = [];
  const skipped: string[] = [];
  for (const citation of citations) {
    if (seen.has(citation.id)) {
      skipped.push(citation.id);
      continue;
    }
    seen.add(citation.id);
    added.push(citation);
  }
  return { added, skipped };
}

/**
 * Count existing excerpt ids that already use the `<slug>-N` pattern, so newly
 * generated ids continue past them (collision-safe on re-analysis of a source).
 */
export function countSlugOccurrences(existingIds: Iterable<string>, slug: string): number {
  const prefix = `${slug}-`;
  let count = 0;
  for (const id of existingIds) {
    if (typeof id === 'string' && id.startsWith(prefix)) {
      count++;
    }
  }
  return count;
}

/**
 * Derive a citation id slug from the leading words of a selection. Ports the
 * unicode-aware chapter slug (lowercase, keep any Unicode letters/digits,
 * collapse other runs to a single hyphen) so any script (Cyrillic, Devanagari,
 * …) survives. Falls back to `citation` when the text yields no usable
 * characters.
 */
export function citationSlugFromText(text: string, wordCount = 6): string {
  const words = String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(word => word.length > 0)
    .slice(0, Math.max(1, wordCount))
    .join(' ');
  const slug = words
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'citation';
}

/**
 * Derive a concise citation title from a selection: whitespace collapsed and
 * truncated to `maxLength` characters (ellipsis appended when clipped).
 */
export function citationTitleFromText(text: string, maxLength = 60): string {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/**
 * Ensure a citation id is unique against ids already present. Returns the
 * candidate unchanged when free, otherwise appends `-2`, `-3`, … until unique
 * (so writers get a suggested, collision-free id).
 */
export function dedupeCitationId(candidate: string, existingIds: Iterable<string>): string {
  const taken = new Set<string>();
  for (const id of existingIds) {
    if (typeof id === 'string' && id) {
      taken.add(id);
    }
  }
  const base = candidate || 'citation';
  if (!taken.has(base)) {
    return base;
  }
  for (let counter = 2; counter < 10000; counter++) {
    const next = `${base}-${counter}`;
    if (!taken.has(next)) {
      return next;
    }
  }
  return `${base}-${Date.now()}`;
}

/** Where a saved editor selection came from, for {@link buildSelectionExcerptRecord}. */
export interface SelectionCitationInput {
  /** The deduped citation id; the excerpt id is `<citationId>-excerpt`. */
  citationId: string;
  /** Workspace-relative path of the editor the selection came from. */
  sourcePath: string;
  /** The selected text. */
  text: string;
  /** Optional author note. */
  note?: string;
  /** 1-based line of the selection start, revealed on click-to-open. */
  targetLine: number;
}

/**
 * Build the `sources/excerpts.jsonl` record for a saved editor selection. The
 * `sourcePath` doubles as `targetPath` so the Sources view can reveal the
 * originating line (click-to-open, spec §5.4).
 */
export function buildSelectionExcerptRecord(input: SelectionCitationInput): ExcerptRecord {
  const record: ExcerptRecord = {
    id: `${input.citationId}-excerpt`,
    sourcePath: input.sourcePath,
    text: input.text,
    targetPath: input.sourcePath
  };
  const note = input.note?.trim();
  if (note) {
    record.note = note;
  }
  if (Number.isFinite(input.targetLine) && input.targetLine > 0) {
    record.targetLine = Math.floor(input.targetLine);
  }
  return record;
}

function pickArray(value: unknown, key: 'excerpts' | 'citations'): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value[key])) {
    return value[key] as unknown[];
  }
  return undefined;
}

function toExcerpt(entry: unknown): AnalyzedExcerpt | undefined {
  if (typeof entry === 'string') {
    const text = entry.trim();
    return text ? { text } : undefined;
  }
  if (!isRecord(entry)) {
    return undefined;
  }
  const text = asTrimmedString(entry.text);
  if (!text) {
    return undefined;
  }
  const excerpt: AnalyzedExcerpt = { text };
  const note = asTrimmedString(entry.note);
  if (note) {
    excerpt.note = note;
  }
  const ref = asTrimmedString(entry.ref);
  if (ref) {
    excerpt.ref = ref;
  }
  return excerpt;
}

function toCitation(entry: unknown): AnalyzedCitation | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const id = asTrimmedString(entry.id);
  if (!id) {
    return undefined;
  }
  const citation: AnalyzedCitation = { id };
  const title = asTrimmedString(entry.title);
  if (title) {
    citation.title = title;
  }
  const source = asTrimmedString(entry.source);
  if (source) {
    citation.source = source;
  }
  const note = asTrimmedString(entry.note);
  if (note) {
    citation.note = note;
  }
  return citation;
}

function asTrimmedString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
