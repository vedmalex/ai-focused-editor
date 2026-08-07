/**
 * `IndexFailureReason` — the ONLY thing that crosses the RPC boundary when the
 * index fails (TASK-022 WP-1, tech_spec ОВ-8).
 *
 * A CLOSED UNION OF CODES, NEVER A MESSAGE STRING. Two reasons, and the second
 * is the load-bearing one:
 *
 *   - The backend does not know the user's locale. A sentence composed where
 *     the failure happened would freeze in whatever language the process
 *     happened to be built with; a code is localized on the frontend, where the
 *     locale actually lives.
 *   - An `Error.message` is a free-form channel out of the process. The
 *     messages Node produces routinely contain absolute paths — which is to say
 *     the user's home directory and their name. Nothing free-form crosses;
 *     `message` and `stack` go to the backend log under `incidentId`, and the
 *     correlation id is what lets a user connect what they were shown to what
 *     was logged.
 *
 * The sanitizer that produces these values lives in `src/node`, because
 * relativizing a path needs `node:path` and this layer may not import it.
 */

/**
 * Why the index failed.
 *
 * CLOSED. Adding a member is a user-visible decision: every member must have a
 * localized phrase, and a test walks this union to prove it. An unmappable
 * underlying error collapses to `internal` WITH a log entry — never silently.
 */
export type IndexFailureCode =
  /** The database file could not be opened or created. */
  | 'storage-unavailable'
  /** Corruption seen twice in a row in this session. */
  | 'storage-corrupted'
  | 'disk-full'
  | 'permission-denied'
  /** The manifest could not be read, so chapter order is unknown. */
  | 'manifest-unreadable'
  /** Extraction itself threw. */
  | 'extraction-failed'
  /** Anything the mapping did not recognise. Always logged. */
  | 'internal';

/**
 * Every member of {@link IndexFailureCode}, as data.
 *
 * The localization test walks this array, so a member added to the type but
 * forgotten here would leave a hole; `satisfies` closes that direction too — a
 * member added to the type and not here still compiles, but a value here that
 * is not in the type does not, and the localization test asserts the array's
 * length against the bundle's key count.
 */
export const INDEX_FAILURE_CODES = [
  'storage-unavailable',
  'storage-corrupted',
  'disk-full',
  'permission-denied',
  'manifest-unreadable',
  'extraction-failed',
  'internal'
] as const satisfies readonly IndexFailureCode[];

/** The localization key a frontend must use to render `code`. One key per
 *  member of the union, arity 0-2 (`relPath`, `occurrences`) — the incident id
 *  is deliberately NOT a substitution, see {@link IndexFailureReason.incidentId}. */
export function indexFailureLocalizationKey(code: IndexFailureCode): string {
  return `ai-focused-editor/narrative-memory/index-failure-${code}`;
}

/** What a failed index tells its consumers. Everything in it is safe to show. */
export interface IndexFailureReason {
  code: IndexFailureCode;
  /**
   * Workspace-RELATIVE path of the file involved, when there is one.
   *
   * NEVER absolute. OMITTED ENTIRELY when the file lies outside the workspace,
   * rather than rendered as `../..`: a path that escapes the workspace is
   * exactly the one that would spell out the home directory and the user's
   * name, and a truncated version of it still leaks the shape.
   */
  relPath?: string;
  /**
   * Correlation id, printed in the backend log next to the stack.
   *
   * Shown to the user as its own monospaced line with a copy button, never
   * inside a localized sentence: a translator may reorder or transform the
   * words around it, and this is a token that must survive verbatim.
   */
  incidentId: string;
  /** How many times this happened in this session. A number, not a phrase. */
  occurrences: number;
}
