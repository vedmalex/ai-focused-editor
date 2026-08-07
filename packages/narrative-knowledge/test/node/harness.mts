/**
 * Shared plumbing for the node-only half of the store's tests (TASK-022 WP-3).
 *
 * WHY THESE TESTS RUN UNDER REAL `node` AND NOT UNDER `bun`. `bun` cannot
 * resolve `node:sqlite` at all — not "slowly", not "with a shim": the import
 * fails. So the production store is unreachable from `bun test packages`, and
 * anything asserted only there would be asserted about the in-memory double.
 * These files are the other half of the scheme, and they are wired into the
 * root `test` script so that `bun run verify` really executes them.
 *
 * WHY THEY IMPORT `lib/` AND NOT `src/`. Node's type stripping runs ESM rules,
 * where a relative import needs its extension; the package's sources use
 * extensionless specifiers throughout, so `src/` is not importable this way.
 * Importing the BUILT output is not a workaround but the better test: it is the
 * artefact every other package actually consumes, and `verify` builds before it
 * tests for exactly that reason.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

export const PACKAGE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = resolvePath(PACKAGE_ROOT, '..', '..');
export const LIB_NODE = join(PACKAGE_ROOT, 'lib', 'node');
export const LIB_COMMON = join(PACKAGE_ROOT, 'lib', 'common');

/** A throwaway workspace directory, plus the database path inside it. */
export interface TempWorkspace {
  root: string;
  databaseFile: string;
  dispose(): void;
}

const pendingCleanups: (() => void)[] = [];

export function makeWorkspace(name = 'narrative-index'): TempWorkspace {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const workspace: TempWorkspace = {
    root,
    databaseFile: join(root, '.theia', 'narrative-index.db'),
    dispose(): void {
      rmSync(root, { recursive: true, force: true });
    }
  };
  pendingCleanups.push(() => workspace.dispose());
  return workspace;
}

/** Run every deferred cleanup. Called once at the end of each test file. */
export function disposeAll(): void {
  while (pendingCleanups.length > 0) {
    try {
      pendingCleanups.pop()?.();
    } catch {
      // A temp directory that resists deletion must not turn a green run red.
    }
  }
}

/** The message of an unknown throw, for assertions about SQLite's own errors. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Call `body` and return what it threw, or `undefined` if it did not throw.
 *
 * Returning the error rather than asserting inside is deliberate: several teeth
 * need to assert WHICH LAYER refused — a `CHECK constraint failed` from SQLite
 * is a different fact from a refusal by the adapter, and only the first proves
 * the schema.
 */
export function caught(body: () => unknown): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Narrow away an `undefined` with a message worth reading.
 *
 * `assert.ok(x)` narrows for TypeScript only through an assertion signature,
 * and a bare `!` narrows without asserting anything at all — so a row that went
 * missing would surface as "cannot read property of undefined" instead of as
 * the fact that the row went missing.
 */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be present, got ${String(value)}`);
  }
  return value;
}
