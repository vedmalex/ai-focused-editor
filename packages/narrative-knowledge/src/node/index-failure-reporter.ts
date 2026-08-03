/**
 * Turning a thrown error into an {@link IndexFailureReason} (TASK-022 WP-1,
 * tech_spec ОВ-8).
 *
 * EVERY RULE HERE RUNS ON NODE, BEFORE THE VALUE CROSSES RPC. That placement is
 * the whole design: once a free-form string is on the wire there is no later
 * layer that can un-leak it.
 *
 *   1. An absolute path becomes workspace-relative. If it does not relativize
 *      INTO the workspace, the field is DROPPED ENTIRELY rather than emitted as
 *      `../..` — a path that escapes the workspace is exactly the one that
 *      spells out the home directory and the user's name, and a truncated
 *      version still gives away the shape.
 *   2. `Error.message` and `Error.stack` NEVER cross. They go to the backend
 *      log under `incidentId`, which is what lets a user connect what they were
 *      shown to what was recorded.
 *   3. Node's own error codes are MAPPED into a closed union, never forwarded
 *      raw. Anything unrecognised collapses to `internal` AND IS LOGGED — the
 *      silent collapse is the failure mode this rule exists to prevent, because
 *      a code that quietly becomes `internal` is a code nobody ever adds.
 *   4. `IndexFailureReason` is the only type that crosses on the failure path.
 *      There is no `Error` forwarding anywhere.
 *
 * WHY THIS FILE IS IN `src/node`. Relativizing a path honestly means
 * `node:path`, which `src/common` may not import. The TYPE lives in
 * `src/common` because every layer must be able to read it; only the
 * SANITIZATION lives here.
 */

import { isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IndexFailureCode, IndexFailureReason } from '../common';

/**
 * What goes to the backend log, and only there.
 *
 * It carries everything the reason deliberately does not: the raw message, the
 * stack, the absolute path, and the underlying code when the mapping did not
 * recognise it.
 */
export interface IndexFailureLogEntry {
  incidentId: string;
  code: IndexFailureCode;
  /** The unrecognised `errno`/SQLite code, present only when `code` is the
   *  `internal` fallback. Its presence is what makes rule 3 observable. */
  unmappedCode?: string;
  /** The path AS THROWN — absolute, and never sent anywhere else. */
  absolutePath?: string;
  message?: string;
  stack?: string;
}

export type IndexFailureLogger = (entry: IndexFailureLogEntry) => void;

export interface IndexFailureReporterOptions {
  /** Absolute path of the workspace root, the frame every path is relative to. */
  workspaceRoot: string;
  /** Where the unsanitized detail goes. */
  log: IndexFailureLogger;
  /** Overridable so tests can assert on a stable id. */
  newIncidentId?: () => string;
}

/**
 * The mapping from underlying error codes to the closed union.
 *
 * Stated as a table rather than a chain of `if`s so the set of recognised codes
 * is readable at a glance, and so the fallback is visibly a fallback.
 */
const CODE_MAP: Readonly<Record<string, IndexFailureCode>> = Object.freeze({
  ENOSPC: 'disk-full',
  EACCES: 'permission-denied',
  EPERM: 'permission-denied',
  SQLITE_CORRUPT: 'storage-corrupted',
  SQLITE_NOTADB: 'storage-corrupted',
  SQLITE_CANTOPEN: 'storage-unavailable'
});

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function errorPathOf(error: unknown): string | undefined {
  const path = (error as { path?: unknown } | null | undefined)?.path;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/**
 * Session-scoped sanitizer.
 *
 * It is a class rather than a function because `occurrences` is a count over
 * THIS SESSION, and a count needs somewhere to live. One reporter per backend
 * session; the count is per failure code, since that is the granularity a user
 * is shown.
 */
export class IndexFailureReporter {
  protected readonly occurrences = new Map<IndexFailureCode, number>();
  protected readonly newIncidentId: () => string;

  constructor(protected readonly options: IndexFailureReporterOptions) {
    this.newIncidentId = options.newIncidentId ?? (() => randomUUID());
  }

  /**
   * Sanitize `error` into something safe to send, and log everything that is
   * not.
   *
   * `path` overrides the path carried by the error itself, for callers that
   * know which file they were working on when a pathless error was thrown.
   */
  report(error: unknown, options: { code?: IndexFailureCode; path?: string } = {}): IndexFailureReason {
    const underlying = errorCodeOf(error);
    const mapped = underlying ? CODE_MAP[underlying] : undefined;
    const code = options.code ?? mapped ?? 'internal';
    // Rule 3: an unrecognised code is only ever `internal` WITH a log line
    // naming it. `unmappedCode` is absent when the caller named the code, or
    // when the map recognised it — including when it legitimately mapped to
    // something else.
    const unmappedCode = options.code === undefined && mapped === undefined ? underlying : undefined;

    const absolutePath = options.path ?? errorPathOf(error);
    const incidentId = this.newIncidentId();
    const occurrences = (this.occurrences.get(code) ?? 0) + 1;
    this.occurrences.set(code, occurrences);

    this.options.log({
      incidentId,
      code,
      ...(unmappedCode !== undefined ? { unmappedCode } : {}),
      ...(absolutePath !== undefined ? { absolutePath } : {}),
      ...(error instanceof Error
        ? { message: error.message, ...(error.stack !== undefined ? { stack: error.stack } : {}) }
        : { message: String(error) })
    });

    const relPath = absolutePath === undefined ? undefined : this.relativize(absolutePath);
    return {
      code,
      ...(relPath !== undefined ? { relPath } : {}),
      incidentId,
      occurrences
    };
  }

  /**
   * A workspace-relative path, or nothing.
   *
   * Rule 1's teeth are here: a result that starts with `..` — the file is
   * outside the workspace — yields `undefined`, not a shortened path. So does
   * an empty result, which is what `relative` returns for the workspace root
   * itself and which would render as a blank filename.
   */
  protected relativize(path: string): string | undefined {
    const rel = relative(this.options.workspaceRoot, path);
    if (rel.length === 0 || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
      return undefined;
    }
    return rel;
  }
}
