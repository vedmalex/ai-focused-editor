/**
 * The three coercions every YAML reader in this repository repeats (TASK-022
 * WP-2).
 *
 * They are copied in `node-narrative-graph-service.ts`, `node-domain-knowledge-
 * service.ts` and the manuscript validators, each time as a private helper.
 * WP-2 needs the SAME semantics — `asString` TRIMS, a non-string is the empty
 * string rather than `String(value)`, a non-array is an empty list — because
 * the extraction is meant to reproduce what those services see today, and a
 * quietly different coercion is exactly the kind of divergence that shows up as
 * a missing entity six months later.
 *
 * They live here rather than in `graph/` because the core may import nothing
 * outward and has no business parsing YAML (prohibition (e)).
 */

/** True for a YAML mapping — an object that is neither `null` nor an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed string, or `''` for anything that is not a string. */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A trimmed string, or `undefined` when the value is absent or blank. */
export function asOptionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text.length > 0 ? text : undefined;
}

/** The non-blank trimmed strings of a YAML list; `[]` for anything else. */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(asString).filter(item => item.length > 0);
}

/**
 * Workspace-relative form of a manifest path: forward slashes, no leading
 * `./`, trimmed. Byte-identical to `normalizePath` in
 * `node-narrative-graph-service.ts:437-439`, on purpose — the index keys
 * documents by this string, and a chapter that normalises differently here than
 * in the service it replaces is a chapter the index cannot match.
 */
export function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The file name of a workspace-relative path, without its `.yaml`/`.yml`
 * extension.
 *
 * String arithmetic rather than `basename`: `src/common` may not import
 * `node:path` (prohibition (a)), and this is the fallback entity id every
 * entity reader in the repository already computes the same way
 * (`fileName.replace(/\.(ya?ml)$/i, '')`).
 */
export function cardIdFromPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return path.slice(slash + 1).replace(/\.(ya?ml)$/i, '');
}
