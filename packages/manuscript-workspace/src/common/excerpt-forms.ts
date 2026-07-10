/**
 * Pure (Theia-free) row/field models for the Excerpts form editor
 * (`sources/excerpts.jsonl`).
 *
 * `sources/excerpts.jsonl` is a JSON-lines file: one JSON object per line
 * (see {@link ExcerptRecord} in `./source-analysis`, which the Sources view and
 * the node domain-knowledge reader consume). These helpers translate between the
 * raw text and the flat rows the React widget renders, plus validation and a
 * canonical, round-trip-safe serialization.
 *
 * Two invariants drive the design:
 *  - NEVER destroy data. A line that cannot be parsed as a JSON object is kept
 *    VERBATIM (in {@link ParseExcerptsResult.unparsed}) and re-emitted on save,
 *    and every unknown key on a parsed record round-trips via {@link ExcerptFormRow.extra}.
 *  - Stable output. Keys are always written in a fixed order so a save produces
 *    a minimal, deterministic diff.
 *
 * Keeping the coercion/validation/serialization here (with no Theia imports)
 * makes it unit-testable under `bun test`.
 */

import type { ExcerptRecord } from './source-analysis';

/**
 * A single editable excerpt row. A superset of {@link ExcerptRecord} (the shape
 * written by "Save Selection as Citation" and source analysis) that also carries
 * the `source`/`ref`/`targetAnchor` fields the reader understands but the narrow
 * `ExcerptRecord` type omits, plus any unknown keys in {@link extra} for a
 * lossless round-trip. `sourcePath` is optional here: not every excerpt has one.
 */
export interface ExcerptFormRow extends Partial<ExcerptRecord> {
  /** Stable excerpt id (required). */
  id: string;
  /** The quoted passage (required). */
  text: string;
  /** Citation id (or free label) the excerpt came from — read as `sourceId`. */
  source?: string;
  /** Workspace-relative path of the originating source document. */
  sourcePath?: string;
  /** Free-form reference string (e.g. "Bhagavad-gita 2.47") — folded into `note`. */
  ref?: string;
  /** Author note. */
  note?: string;
  /** Workspace-relative manuscript file this excerpt links back to. */
  targetPath?: string;
  /** Heading slug within {@link targetPath}. */
  targetAnchor?: string;
  /** 1-based line revealed when the Sources view opens the target file. */
  targetLine?: number;
  /** Unknown keys preserved verbatim (in original order) for round-trip. */
  extra?: Record<string, unknown>;
}

/** A raw line that could not be parsed as a JSON object, kept verbatim. */
export interface UnparsedExcerptLine {
  /** 1-based line number in the source text. */
  line: number;
  /** The exact original line (without its trailing newline). */
  raw: string;
}

/** The result of parsing `sources/excerpts.jsonl`. */
export interface ParseExcerptsResult {
  rows: ExcerptFormRow[];
  unparsed: UnparsedExcerptLine[];
}

/** A validation problem surfaced in the form (an `error` blocks Save). */
export interface ExcerptProblem {
  message: string;
  severity: 'error' | 'warning';
  /** Zero-based index of the offending row, when applicable. */
  index?: number;
}

/**
 * Canonical write order for the known excerpt keys. Extra (unknown) keys are
 * appended after these in their original order.
 */
const KNOWN_STRING_KEYS = [
  'id',
  'text',
  'source',
  'sourcePath',
  'ref',
  'note',
  'targetPath',
  'targetAnchor'
] as const;

/** All recognized keys (the string keys plus the numeric `targetLine`). */
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([...KNOWN_STRING_KEYS, 'targetLine']);

/** An empty row seeded by "Add Excerpt". */
export const EMPTY_EXCERPT_ROW: ExcerptFormRow = { id: '', text: '' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce a JSON scalar to a string; objects/arrays/null/undefined become ''. */
function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

/**
 * Turn one parsed JSON object into an {@link ExcerptFormRow}. Known string keys
 * are coerced to strings; `targetLine` is kept as a finite number (any other
 * value is preserved in `extra`); every other key is preserved verbatim in
 * `extra`, in its original key order.
 */
function recordToRow(record: Record<string, unknown>): ExcerptFormRow {
  const row: ExcerptFormRow = { id: '', text: '' };
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    switch (key) {
      case 'id':
        row.id = asString(value);
        break;
      case 'text':
        row.text = asString(value);
        break;
      case 'source':
        row.source = asString(value);
        break;
      case 'sourcePath':
        row.sourcePath = asString(value);
        break;
      case 'ref':
        row.ref = asString(value);
        break;
      case 'note':
        row.note = asString(value);
        break;
      case 'targetPath':
        row.targetPath = asString(value);
        break;
      case 'targetAnchor':
        row.targetAnchor = asString(value);
        break;
      case 'targetLine':
        if (typeof value === 'number' && Number.isFinite(value)) {
          row.targetLine = value;
        } else {
          // Preserve an unexpected targetLine value verbatim rather than drop it.
          extra.targetLine = value;
        }
        break;
      default:
        extra[key] = value;
    }
  }
  if (Object.keys(extra).length > 0) {
    row.extra = extra;
  }
  return row;
}

/**
 * Parse the raw text of `sources/excerpts.jsonl` tolerantly:
 *  - blank / whitespace-only lines are skipped;
 *  - a line that is valid JSON AND a plain object becomes a row (keeping all
 *    unknown keys for round-trip);
 *  - any other line (invalid JSON, or JSON that is not an object — a number,
 *    string, array, or null) is kept VERBATIM in `unparsed` so a save never
 *    destroys hand-authored or future-shaped data.
 */
export function parseExcerptsJsonl(text: string): ParseExcerptsResult {
  const rows: ExcerptFormRow[] = [];
  const unparsed: UnparsedExcerptLine[] = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((raw, index) => {
    if (raw.trim().length === 0) {
      return; // skip blank lines
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      unparsed.push({ line: index + 1, raw });
      return;
    }
    if (!isRecord(parsed)) {
      unparsed.push({ line: index + 1, raw });
      return;
    }
    rows.push(recordToRow(parsed));
  });
  return { rows, unparsed };
}

/** Build the canonical ordered JSON object for one row (undefined = omit key). */
function rowToOrderedObject(row: ExcerptFormRow): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  const putString = (key: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') {
      object[key] = value;
    }
  };
  putString('id', row.id);
  putString('text', row.text);
  putString('source', row.source);
  putString('sourcePath', row.sourcePath);
  putString('ref', row.ref);
  putString('note', row.note);
  putString('targetPath', row.targetPath);
  putString('targetAnchor', row.targetAnchor);
  if (typeof row.targetLine === 'number' && Number.isInteger(row.targetLine) && row.targetLine > 0) {
    object.targetLine = row.targetLine;
  }
  if (row.extra) {
    for (const [key, value] of Object.entries(row.extra)) {
      // A known key never lands in `extra` except an unexpected `targetLine`
      // value we deliberately preserved; either way, re-emit it verbatim.
      if (!(key in object)) {
        object[key] = value;
      }
    }
  }
  return object;
}

/**
 * Serialize rows (and any preserved `unparsed` lines) back to JSONL text:
 *  - one compact `JSON.stringify` per record, keys in the canonical order
 *    (id, text, source, sourcePath, ref, note, targetPath, targetAnchor,
 *    targetLine, then extra keys in original order);
 *  - undefined/empty-string fields are omitted; `targetLine` is written only
 *    when it is a positive integer;
 *  - preserved `unparsed` raw lines are re-emitted at the END in original order;
 *  - a trailing newline is added (an empty result is the empty string).
 */
export function serializeExcerptsJsonl(
  rows: ExcerptFormRow[],
  unparsed: UnparsedExcerptLine[] = []
): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(JSON.stringify(rowToOrderedObject(row)));
  }
  for (const entry of unparsed) {
    lines.push(entry.raw);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Validate the rows before a save. Errors block saving: an id is required and
 * must be unique, and the text is required. Warnings are advisory: a `targetLine`
 * without a `targetPath` has nothing to open, and a non-integer/non-positive
 * `targetLine` is dropped on save (line numbers are 1-based whole numbers).
 */
export function validateExcerpts(rows: ExcerptFormRow[]): ExcerptProblem[] {
  const problems: ExcerptProblem[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const where = `Excerpt ${index + 1}`;
    const id = row.id.trim();
    if (!id) {
      problems.push({ severity: 'error', index, message: `${where}: an id is required.` });
    } else if (seen.has(id)) {
      problems.push({ severity: 'error', index, message: `${where}: duplicate id "${id}".` });
    } else {
      seen.add(id);
    }

    if (!row.text.trim()) {
      problems.push({ severity: 'error', index, message: `${where}: excerpt text is required.` });
    }

    if (row.targetLine !== undefined) {
      if (!Number.isInteger(row.targetLine) || row.targetLine <= 0) {
        problems.push({
          severity: 'warning',
          index,
          message: `${where}: targetLine must be a positive whole number (it is dropped on save otherwise).`
        });
      }
      if (!(row.targetPath ?? '').trim()) {
        problems.push({
          severity: 'warning',
          index,
          message: `${where}: targetLine is set without a targetPath, so there is no file to open.`
        });
      }
    }
  });
  return problems;
}

/** Whether the rows are safe to save (no error-severity problems). */
export function hasBlockingExcerptProblems(problems: ExcerptProblem[]): boolean {
  return problems.some(problem => problem.severity === 'error');
}

/** Whether a key is one the form recognizes (used by tests / callers). */
export function isKnownExcerptKey(key: string): boolean {
  return KNOWN_KEYS.has(key);
}
