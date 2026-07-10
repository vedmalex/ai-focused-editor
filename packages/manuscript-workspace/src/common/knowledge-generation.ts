/*
 * FR-011 knowledge generation — pure helpers (spec §5.3, §6).
 *
 * These functions turn a raw AI response into a structured document object that
 * the browser contribution serializes to YAML and writes under the workspace
 * `knowledge/` convention (spec §4.1). They contain no Theia, Node, or DOM
 * imports so they can be unit-tested with `bun test` and shared freely across
 * process boundaries.
 */

export type KnowledgeKind = 'summary' | 'plan' | 'questions';

/** Provenance metadata shared by every generated knowledge document. */
export interface KnowledgeMeta {
  /** Workspace-relative path (or URI) of the source chapter. */
  chapter: string;
  /** Human-readable chapter title. */
  title: string;
  /** ISO-8601 timestamp of generation. */
  generated_at: string;
  /** Provider that produced the response (e.g. `openai`). */
  provider?: string;
  /** Model that produced the response. */
  model?: string;
}

export interface SummaryDocument extends KnowledgeMeta {
  /** Prose synopsis of the chapter. */
  summary?: string;
  /** Raw model text, present only when the response could not be parsed. */
  raw?: string;
}

export interface ScenePlanEntry {
  title: string;
  purpose?: string;
  beats: string[];
}

export interface PlanDocument extends KnowledgeMeta {
  scenes?: ScenePlanEntry[];
  raw?: string;
}

export interface QuestionsDocument extends KnowledgeMeta {
  questions?: string[];
  raw?: string;
}

export type KnowledgeDocument = SummaryDocument | PlanDocument | QuestionsDocument;

export interface KnowledgeCoercion<T extends KnowledgeDocument> {
  /** The document to serialize to YAML. */
  document: T;
  /** True when the model response parsed into the expected shape. */
  parsed: boolean;
}

/**
 * Unicode-aware chapter slug: lowercase, keep any Unicode letters/digits,
 * collapse every other run to a single hyphen, and trim hyphens. Falls back to
 * `chapter` when the title yields no usable characters (mirrors the exporter's
 * `slugifyBase`, copied locally so this module stays free of the node-oriented
 * `@ai-focused-editor/book-export` package and its webpack footprint).
 */
export function slugifyChapter(title: string): string {
  const base = String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'chapter';
}

/**
 * Robustly extract a JSON value from a model response. Tries, in order:
 *   1. the trimmed text as-is,
 *   2. the contents of any ```json / ``` fenced code block,
 *   3. the outermost `{...}` object slice,
 *   4. the outermost `[...]` array slice.
 * Returns `undefined` when nothing parses.
 */
export function extractJsonValue(text: string): unknown {
  if (typeof text !== 'string') {
    return undefined;
  }
  for (const candidate of collectJsonCandidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

export function coerceSummary(meta: KnowledgeMeta, rawText: string): KnowledgeCoercion<SummaryDocument> {
  const summary = readSummary(extractJsonValue(rawText));
  if (summary !== undefined) {
    return { document: { ...meta, summary }, parsed: true };
  }
  return { document: { ...meta, raw: cleanRaw(rawText) }, parsed: false };
}

export function coercePlan(meta: KnowledgeMeta, rawText: string): KnowledgeCoercion<PlanDocument> {
  const scenes = readScenes(extractJsonValue(rawText));
  if (scenes) {
    return { document: { ...meta, scenes }, parsed: true };
  }
  return { document: { ...meta, raw: cleanRaw(rawText) }, parsed: false };
}

export function coerceQuestions(meta: KnowledgeMeta, rawText: string): KnowledgeCoercion<QuestionsDocument> {
  const questions = readQuestions(extractJsonValue(rawText));
  if (questions) {
    return { document: { ...meta, questions }, parsed: true };
  }
  return { document: { ...meta, raw: cleanRaw(rawText) }, parsed: false };
}

/** Dispatches to the coercion for a given knowledge kind. */
export function coerceKnowledge(
  kind: KnowledgeKind,
  meta: KnowledgeMeta,
  rawText: string
): KnowledgeCoercion<KnowledgeDocument> {
  switch (kind) {
    case 'summary':
      return coerceSummary(meta, rawText);
    case 'plan':
      return coercePlan(meta, rawText);
    case 'questions':
      return coerceQuestions(meta, rawText);
  }
}

function collectJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed) {
    candidates.push(trimmed);
  }

  const fenceRegex = /```(?:json5?|yaml)?\s*([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const inner = fenceMatch[1].trim();
    if (inner) {
      candidates.push(inner);
    }
  }

  const objectSlice = sliceBetween(text, '{', '}');
  if (objectSlice) {
    candidates.push(objectSlice);
  }
  const arraySlice = sliceBetween(text, '[', ']');
  if (arraySlice) {
    candidates.push(arraySlice);
  }
  return candidates;
}

function sliceBetween(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}

function readSummary(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (isRecord(value) && typeof value.summary === 'string') {
    return value.summary.trim() || undefined;
  }
  return undefined;
}

function readScenes(value: unknown): ScenePlanEntry[] | undefined {
  const rawScenes = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.scenes)
      ? value.scenes
      : undefined;
  if (!rawScenes) {
    return undefined;
  }
  const scenes = rawScenes
    .map(toScene)
    .filter((scene): scene is ScenePlanEntry => scene !== undefined);
  return scenes.length > 0 ? scenes : undefined;
}

function toScene(entry: unknown): ScenePlanEntry | undefined {
  if (typeof entry === 'string') {
    const title = entry.trim();
    return title ? { title, beats: [] } : undefined;
  }
  if (!isRecord(entry)) {
    return undefined;
  }
  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  const purpose = typeof entry.purpose === 'string' ? entry.purpose.trim() : undefined;
  const beats = toStringArray(entry.beats);
  if (!title && !purpose && beats.length === 0) {
    return undefined;
  }
  const scene: ScenePlanEntry = { title: title || 'Untitled scene', beats };
  if (purpose) {
    scene.purpose = purpose;
  }
  return scene;
}

function readQuestions(value: unknown): string[] | undefined {
  const rawQuestions = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.questions)
      ? value.questions
      : undefined;
  if (!rawQuestions) {
    return undefined;
  }
  const questions = toStringArray(rawQuestions);
  return questions.length > 0 ? questions : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(item => {
      if (typeof item === 'string') {
        return item.trim();
      }
      if (typeof item === 'number' || typeof item === 'boolean') {
        return String(item);
      }
      return '';
    })
    .filter(item => item.length > 0);
}

function cleanRaw(rawText: string): string {
  return typeof rawText === 'string' ? rawText.trim() : String(rawText ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
