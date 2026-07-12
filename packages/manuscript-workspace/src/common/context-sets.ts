/**
 * Named context sets — reusable bundles of chat-context variables saved to
 * `ai/context-sets.yaml` so an author can re-attach a whole working set in one
 * action (or through the `#set:<id>` mention).
 *
 * File shape (spec):
 * ```yaml
 * version: 1
 * sets:
 *   - id: chapter-3-research
 *     label: Chapter 3 research
 *     items:
 *       - variable: chapter
 *         arg: content/chapter-03.md
 *       - variable: entities
 * ```
 *
 * This module is Theia-free so parsing, validation, id-slugging, and the
 * comment-preserving YAML upsert are all unit-testable under `bun test`. The
 * on-disk rewrite goes through the `yaml` Document API so the file header,
 * `version` key, and hand-authored comments survive a round-trip — only the
 * touched set entry is rebuilt.
 */

import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml';

/** One member of a context set: a variable name plus an optional argument. */
export interface ContextSetItem {
  variable: string;
  arg?: string;
}

/** A named set of context variables. */
export interface ContextSet {
  id: string;
  label: string;
  items: ContextSetItem[];
}

/** The parsed `ai/context-sets.yaml` document. */
export interface ContextSetsDocument {
  version: number;
  sets: ContextSet[];
}

/** Workspace-relative path of the context-sets file. */
export const CONTEXT_SETS_PATH = 'ai/context-sets.yaml';

/** A validation problem for a context set (an `error` blocks a save). */
export interface ContextSetProblem {
  severity: 'error' | 'warning';
  /** Stable kebab-case identifier for the problem kind. */
  code: string;
  /** English source-of-truth message (localized by the caller via `code`). */
  message: string;
  /** Positional values interpolated into the localized message (`{0}`, `{1}`…). */
  params?: (string | number)[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Coerce one raw `items` entry into a {@link ContextSetItem}, or skip it. */
function toItem(value: unknown): ContextSetItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const variable = asString(value.variable).trim();
  if (!variable) {
    return undefined;
  }
  const arg = asString(value.arg).trim();
  return arg ? { variable, arg } : { variable };
}

/** Coerce one raw `sets` entry into a {@link ContextSet}, or skip it. */
function toSet(value: unknown): ContextSet | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = asString(value.id).trim();
  if (!id) {
    return undefined;
  }
  const label = asString(value.label).trim() || id;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems.map(toItem).filter((item): item is ContextSetItem => item !== undefined);
  return { id, label, items };
}

/**
 * Tolerantly parse a context-sets file. Invalid/partial entries are skipped
 * rather than throwing so a hand-edited file never breaks the picker. An empty
 * or unparseable file yields `{ version: 1, sets: [] }`.
 */
export function parseContextSets(text: string | undefined): ContextSetsDocument {
  if (!text || text.trim().length === 0) {
    return { version: 1, sets: [] };
  }
  let parsed: unknown;
  try {
    parsed = parseDocument(text).toJS();
  } catch {
    return { version: 1, sets: [] };
  }
  if (!isRecord(parsed)) {
    return { version: 1, sets: [] };
  }
  const version = typeof parsed.version === 'number' ? parsed.version : 1;
  const rawSets = Array.isArray(parsed.sets) ? parsed.sets : [];
  const sets = rawSets.map(toSet).filter((set): set is ContextSet => set !== undefined);
  return { version, sets };
}

/** Look up a set by id in a parsed document. */
export function findContextSet(document: ContextSetsDocument, id: string): ContextSet | undefined {
  return document.sets.find(set => set.id === id);
}

/**
 * Slugify a label into a url-safe, kebab-case set id: lowercase, non-alphanumeric
 * runs collapsed to single dashes, edges trimmed. Empty input yields `'set'`.
 */
export function slugifyContextSetId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'set';
}

/** kebab-case check for set ids: `chapter-3`, `research`, `a1`. */
export function isContextSetId(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

/**
 * Validate a set before saving: a non-empty (softly kebab-case, unique) id, a
 * non-empty item list, and every item's `variable` present in
 * `knownVariableNames` (an unknown variable is a warning — it will simply
 * resolve to friendly "unknown" text, not crash).
 *
 * `existingIds` are the ids already in the file EXCLUDING the one being written
 * (so re-saving over the same id is not flagged as a duplicate).
 */
export function validateContextSet(
  set: ContextSet,
  knownVariableNames: readonly string[],
  existingIds: readonly string[] = []
): ContextSetProblem[] {
  const problems: ContextSetProblem[] = [];
  const id = set.id.trim();
  if (!id) {
    problems.push({ severity: 'error', code: 'id-required', message: 'A set id is required.' });
  } else {
    if (existingIds.includes(id)) {
      problems.push({ severity: 'error', code: 'duplicate-id', message: `A set with id "${id}" already exists.`, params: [id] });
    }
    if (!isContextSetId(id)) {
      problems.push({
        severity: 'warning',
        code: 'id-not-kebab-case',
        message: `Set id "${id}" should be kebab-case (lowercase letters, digits, dashes).`,
        params: [id]
      });
    }
  }

  if (set.items.length === 0) {
    problems.push({ severity: 'error', code: 'no-items', message: 'A set must contain at least one context item.' });
  }

  const known = new Set(knownVariableNames);
  set.items.forEach((item, index) => {
    if (!known.has(item.variable)) {
      problems.push({
        severity: 'warning',
        code: 'unknown-variable',
        message: `Item ${index + 1}: unknown context variable "${item.variable}".`,
        params: [index + 1, item.variable]
      });
    }
  });

  return problems;
}

/** Whether the problems block a save (any error-severity problem). */
export function hasBlockingProblems(problems: readonly ContextSetProblem[]): boolean {
  return problems.some(problem => problem.severity === 'error');
}

/** Build an ordered `{ variable, arg? }` node for one item (omitting a blank arg). */
function toItemNode(item: ContextSetItem): Record<string, string> {
  const node: Record<string, string> = { variable: item.variable };
  const arg = item.arg?.trim();
  if (arg) {
    node.arg = arg;
  }
  return node;
}

/** Build an ordered `{ id, label, items }` node for one set. */
function toSetNode(set: ContextSet): Record<string, unknown> {
  return {
    id: set.id.trim(),
    label: set.label.trim() || set.id.trim(),
    items: set.items.map(toItemNode)
  };
}

/**
 * Insert or replace a set in the YAML text, preserving the document header,
 * `version` key, comments, and untouched sets. An existing set with the same id
 * is replaced in place; otherwise the set is appended. Returns the new file
 * text. `existingText` may be undefined/empty for a fresh file.
 */
export function upsertContextSetInYaml(existingText: string | undefined, set: ContextSet): string {
  const document = existingText !== undefined && existingText.trim().length > 0
    ? parseDocument(existingText)
    : new Document({ version: 1, sets: [] });

  // Ensure the root is a map carrying a `sets` sequence.
  if (!isMap(document.contents)) {
    document.contents = document.createNode({ version: 1, sets: [] }) as unknown as YAMLMap;
  }
  if (document.get('version') === undefined) {
    document.set('version', 1);
  }
  let seq = document.get('sets');
  if (!isSeq(seq)) {
    seq = new YAMLSeq();
    document.set('sets', seq);
  }
  const setsSeq = seq as YAMLSeq;

  const node = document.createNode(toSetNode(set));
  const targetId = set.id.trim();
  const existingIndex = setsSeq.items.findIndex(entry => isMap(entry) && String(entry.get('id')) === targetId);
  if (existingIndex >= 0) {
    setsSeq.set(existingIndex, node);
  } else {
    setsSeq.add(node);
  }

  return document.toString();
}
