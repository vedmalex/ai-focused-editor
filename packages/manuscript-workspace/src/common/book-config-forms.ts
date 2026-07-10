/**
 * Pure (Theia-free) row/field models for the book-config form editors
 * (`metadata.yaml` and `manifest.yaml`).
 *
 * These helpers only translate between plain parsed objects (the output of
 * `yaml`'s `Document.toJS()`) and the flat models the React widgets render.
 * The actual on-disk rewrite is done by the widgets through the `yaml`
 * Document API so that comments, key order, and unknown structures survive a
 * round-trip. Keeping the coercion/validation here (with no Theia imports)
 * makes it unit-testable under `bun test`.
 */

/** A validation problem surfaced in a form (an `error` blocks Save). */
export interface FormProblem {
  message: string;
  severity: 'error' | 'warning';
  /** Optional identifier of the offending field/row (field name or path). */
  field?: string;
}

/* -------------------------------------------------------------------------- */
/* metadata.yaml                                                              */
/* -------------------------------------------------------------------------- */

/** Top-level keys the metadata form renders as dedicated inputs. */
export const METADATA_KNOWN_KEYS = ['title', 'author', 'language', 'cover'] as const;

export type MetadataKnownKey = (typeof METADATA_KNOWN_KEYS)[number];

/** One editable row in the free "other keys" section of the metadata form. */
export interface MetadataUnknownEntry {
  key: string;
  value: string;
}

export interface MetadataFields {
  title: string;
  author: string;
  language: string;
  cover: string;
  /** Any other top-level *scalar* key, rendered as an editable text row. */
  unknown: MetadataUnknownEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
 * A YAML scalar for form purposes: string/number/boolean/bigint or `null`.
 * Maps and sequences are "structures" — the form leaves them untouched.
 */
function isScalarValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  );
}

export function isMetadataKnownKey(key: string): key is MetadataKnownKey {
  return (METADATA_KNOWN_KEYS as readonly string[]).includes(key);
}

/**
 * Split a parsed metadata object into the known fields plus a list of
 * unknown *scalar* keys. Unknown non-scalar keys (nested maps/sequences) are
 * intentionally dropped from the model so the widget preserves them untouched.
 */
export function extractMetadataFields(value: unknown): MetadataFields {
  const record = isRecord(value) ? value : {};
  const unknown: MetadataUnknownEntry[] = [];
  for (const [key, raw] of Object.entries(record)) {
    if (isMetadataKnownKey(key)) {
      continue;
    }
    if (isScalarValue(raw)) {
      unknown.push({ key, value: raw === null ? '' : asString(raw) });
    }
    // Non-scalar structures are left out of the model (preserved on save).
  }
  return {
    title: asString(record.title),
    author: asString(record.author),
    language: asString(record.language),
    cover: asString(record.cover),
    unknown
  };
}

/** Required-field + custom-key validation for the metadata form. */
export function validateMetadata(fields: MetadataFields): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!fields.title.trim()) {
    problems.push({ severity: 'error', field: 'title', message: 'Title is required.' });
  }
  const language = fields.language.trim();
  if (!language) {
    problems.push({ severity: 'error', field: 'language', message: 'Language is required.' });
  } else if (language.length < 2) {
    problems.push({
      severity: 'error',
      field: 'language',
      message: 'Language must be at least 2 characters (e.g. "en", "ru").'
    });
  }

  const seen = new Set<string>();
  fields.unknown.forEach(entry => {
    const key = entry.key.trim();
    if (!key) {
      // Blank keys are ignored (dropped on save), not an error.
      return;
    }
    if (isMetadataKnownKey(key)) {
      problems.push({
        severity: 'warning',
        field: key,
        message: `Custom key "${key}" shadows a built-in field; edit it above instead.`
      });
    } else if (seen.has(key)) {
      problems.push({ severity: 'error', field: key, message: `Duplicate key "${key}".` });
    } else {
      seen.add(key);
    }
  });
  return problems;
}

/* -------------------------------------------------------------------------- */
/* manifest.yaml                                                              */
/* -------------------------------------------------------------------------- */

/** A flattened manifest content entry with tree depth for indentation. */
export interface ManifestRow {
  /** Workspace-relative path (read-only identity key). */
  path: string;
  /** Editable display title. */
  title: string;
  /** Build inclusion flag; `false` maps to `include: false` on disk. */
  include: boolean;
  /** Nesting level; 0 for top-level entries. */
  depth: number;
  /** Whether the entry has nested children (a folder/part). */
  hasChildren: boolean;
  /** Path of the parent folder entry; undefined for top-level rows. */
  parentPath?: string;
  /** Index among the siblings of the same parent (manifest order). */
  siblingIndex: number;
}

/**
 * Normalize a manifest path for matching (trim, forward slashes, drop a
 * leading `./` and trailing slashes). Mirrors the backend mutation service so
 * form edits address the same entries.
 */
export function normalizeManifestPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Flatten a parsed manifest (`{ version, content }` or a bare content array)
 * into a depth-tagged row list in document order. Entries without a `path`
 * are skipped because they cannot be addressed on save.
 */
export function flattenManifestRows(value: unknown): ManifestRow[] {
  const content = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.content)
      ? value.content
      : [];
  const rows: ManifestRow[] = [];
  const walk = (items: unknown[], depth: number, parentPath: string | undefined): void => {
    let siblingIndex = 0;
    for (const item of items) {
      if (!isRecord(item)) {
        continue;
      }
      const path = asString(item.path);
      if (!path) {
        continue;
      }
      const children = Array.isArray(item.children) ? item.children : [];
      rows.push({
        path,
        title: asString(item.title),
        // Absent `include` means included; only excluded entries carry `false`.
        include: item.include !== false,
        depth,
        hasChildren: children.length > 0,
        parentPath,
        siblingIndex
      });
      siblingIndex += 1;
      if (children.length > 0) {
        walk(children, depth + 1, path);
      }
    }
  };
  walk(content, 0, undefined);
  return rows;
}

/**
 * Manifest convention: an absent `include` key means "included"; only excluded
 * entries carry `include: false`. Returns the value to write, or `undefined`
 * to signal the key should be deleted (the included default).
 */
export function includeFlagToYaml(include: boolean): false | undefined {
  return include ? undefined : false;
}

/** Empty titles are a non-blocking warning (the navigator falls back to path). */
export function validateManifestRows(rows: ManifestRow[]): FormProblem[] {
  const problems: FormProblem[] = [];
  rows.forEach(row => {
    if (!row.title.trim()) {
      problems.push({
        severity: 'warning',
        field: row.path,
        message: `"${row.path}" has no title (the navigator will show its path).`
      });
    }
  });
  return problems;
}
