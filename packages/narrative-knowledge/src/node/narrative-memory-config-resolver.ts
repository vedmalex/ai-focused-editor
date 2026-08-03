/**
 * Where the backend's `NarrativeMemoryConfig` comes from (TASK-022 WP-3,
 * tech_spec ОВ-9а, plan AD-5 / R-11).
 *
 * THE PREMISE THAT MADE THIS LOOK HARD WAS TOO STRONG. The plan said the value
 * is needed "before preferences can possibly have arrived". It is not: the
 * first store open happens on the first RPC call CARRYING A `rootUri`, not at
 * process boot — before that the backend does not even know the directory the
 * relative `databasePath` is relative to. So what is actually needed is a
 * value for the case where the frontend has not spoken YET, which is a ladder
 * of defaults and nothing more exotic.
 *
 * THE PATTERN IS NOT INVENTED HERE. `BrowserAuthCliContribution` +
 * `BrowserAuthConfiguration.resolve()` in the manuscript workspace package
 * already do CLI flag, environment variable, file, and an idempotent `resolve`
 * guarded by a `resolved` flag — in production, in this repository. This class
 * is that pattern applied to a second subject, which is why the split of
 * ownership (backend resolves, frontend only patches) rests on a PRECEDENT
 * rather than on an assertion that backends cannot read configuration.
 *
 * RESOLUTION IS PER ROOT, NOT PER PROCESS. Rung 4 is a per-workspace file by
 * definition, and the backend serves several workspaces at once.
 *
 * WHAT THIS CLASS DOES NOT OWN. The live `configure(patch)` handler — its
 * `applied`/`deferred`/`rejected` result, its range validation, its
 * idempotence and its effect on the watcher timer — is WP-4b's, and printing a
 * second edition of it here is exactly the failure this task keeps paying for.
 * What IS here is rung 1's storage and the ONE asymmetry ОВ-9а pins to the
 * ladder itself: a `--narrative-index-db` flag LOCKS `databasePath` for the
 * whole process.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { injectable } from '@theia/core/shared/inversify';
import { DEFAULT_NARRATIVE_MEMORY_CONFIG, type NarrativeMemoryConfig } from '../common';

/** The three flags `NarrativeKnowledgeCliContribution` declares. */
export interface NarrativeMemoryCliOptions {
  databasePath?: string;
  debounceMs?: number;
  fallbackTtlMs?: number;
}

/** Environment variable names, rung 3. */
export const NARRATIVE_MEMORY_ENV = {
  databasePath: 'AI_EDITOR_NARRATIVE_INDEX_DB',
  debounceMs: 'AI_EDITOR_NARRATIVE_INDEX_DEBOUNCE_MS',
  fallbackTtlMs: 'AI_EDITOR_NARRATIVE_INDEX_FALLBACK_TTL_MS'
} as const;

/** Per-workspace file, rung 4. Read LAZILY, on first use of that root — never
 *  at boot, because at boot there is no root to read it from. */
export const NARRATIVE_MEMORY_CONFIG_FILE = '.theia/narrative-memory.json';

/** Why a `databasePath` change was refused. Mirrors ОВ-9б's `rejected` reasons;
 *  the full result type belongs to WP-4b. */
export type DatabasePathRejection = 'locked-by-cli';

export interface NarrativeMemoryConfigResolverOptions {
  /** Overridable so a test can set rung 3 without mutating `process.env`. */
  env?: Record<string, string | undefined>;
  /** Overridable so a test can supply rung 4 without touching a disk. */
  readConfigFile?: (rootPath: string) => string | undefined;
}

function readNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number(raw);
  // A malformed value is IGNORED rather than coerced: `Number('abc')` is `NaN`,
  // and a `NaN` debounce window would make the watcher misbehave in a way no
  // one would trace back to a typo in an environment variable.
  return Number.isFinite(parsed) ? parsed : undefined;
}

function defaultReadConfigFile(rootPath: string): string | undefined {
  try {
    return readFileSync(join(rootPath, NARRATIVE_MEMORY_CONFIG_FILE), 'utf8');
  } catch {
    // Absent or unreadable are the same thing to a ladder: fall through to the
    // next rung. It is a per-workspace convenience file, not a contract.
    return undefined;
  }
}

@injectable()
export class NarrativeMemoryConfigResolver {
  private readonly env: Record<string, string | undefined>;
  private readonly readConfigFile: (rootPath: string) => string | undefined;

  /** Rung 2. Set once by the CLI contribution, before `initialize()`. */
  private cli: NarrativeMemoryCliOptions = {};
  /** Rung 1, global. */
  private runtimeGlobal: Partial<NarrativeMemoryConfig> = {};
  /** Rung 1, per root. */
  private readonly runtimeByRoot = new Map<string, Partial<NarrativeMemoryConfig>>();
  /** Memoized results — the `resolved` flag of the precedent, one per root. */
  private readonly resolvedByRoot = new Map<string, NarrativeMemoryConfig>();

  constructor(options: NarrativeMemoryConfigResolverOptions = {}) {
    this.env = options.env ?? process.env;
    this.readConfigFile = options.readConfigFile ?? defaultReadConfigFile;
  }

  /** Called by the CLI contribution's `setArguments`, before anything resolves. */
  setCliOptions(options: NarrativeMemoryCliOptions): void {
    this.cli = { ...options };
    this.resolvedByRoot.clear();
  }

  /**
   * Whether `--narrative-index-db` was given.
   *
   * THE ONE ASYMMETRY IN THE LADDER. For `debounceMs` and `fallbackTtlMs` the
   * frontend patch wins over the flag, because those are live knobs a user
   * turns and a launch flag that silently overrode them would make the settings
   * UI a lie. For `databasePath` it is the reverse: that flag is what an
   * operator uses when there is NO choice — a read-only workspace, a test
   * harness, a network volume without locking — and a setting able to override
   * it would make the flag useless.
   */
  isDatabasePathLockedByCli(): boolean {
    return this.cli.databasePath !== undefined;
  }

  /**
   * Record rung-1 values.
   *
   * Returns the keys REFUSED, which today can only be `databasePath` under a
   * CLI lock. The full `ConfigureResult` — `applied`, `deferred`, `rejected`,
   * `configVersion`, range validation — is WP-4b's surface; this is the storage
   * underneath it.
   */
  setRuntimeOverrides(
    patch: Partial<NarrativeMemoryConfig>,
    rootPath?: string
  ): { rejected: { key: 'databasePath'; reason: DatabasePathRejection }[] } {
    const rejected: { key: 'databasePath'; reason: DatabasePathRejection }[] = [];
    const accepted: Partial<NarrativeMemoryConfig> = { ...patch };
    if ('databasePath' in accepted && this.isDatabasePathLockedByCli()) {
      delete accepted.databasePath;
      rejected.push({ key: 'databasePath', reason: 'locked-by-cli' });
    }
    if (rootPath === undefined) {
      this.runtimeGlobal = { ...this.runtimeGlobal, ...accepted };
    } else {
      this.runtimeByRoot.set(rootPath, { ...(this.runtimeByRoot.get(rootPath) ?? {}), ...accepted });
    }
    this.resolvedByRoot.clear();
    return { rejected };
  }

  /** Forget memoized results, so the next `resolve` reads the rungs again. */
  invalidate(rootPath?: string): void {
    if (rootPath === undefined) {
      this.resolvedByRoot.clear();
    } else {
      this.resolvedByRoot.delete(rootPath);
    }
  }

  /**
   * The effective configuration for one workspace root. Idempotent per root.
   *
   * The ladder, strongest first: runtime patch, CLI flag, environment, the
   * per-workspace file, then the defaults from WP-1.
   *
   * WHY CLI OUTRANKS ENVIRONMENT. A flag is per-launch and explicit; an
   * environment variable leaks from the parent shell into everything spawned
   * below it — and in this repository that is not theoretical:
   * `node-book-build-task-runner.ts:43` hands `env: process.env` wholesale to
   * the book-build child process. A variable exported for the editor would ride
   * along; a flag would not.
   *
   * WHY THE FILE OUTRANKS DEFAULTS BUT NOT CLI/ENV. It is per-workspace and
   * outside git (`.gitignore` covers `.theia/`), so it is the natural home for
   * "this manuscript is huge, give it a bigger window". But an operator
   * starting the backend by hand must be able to override a file they did not
   * write.
   */
  resolve(rootPath: string): NarrativeMemoryConfig {
    const memoized = this.resolvedByRoot.get(rootPath);
    if (memoized !== undefined) {
      return memoized;
    }
    const fileValues = this.readFileRung(rootPath);
    const envValues: Partial<NarrativeMemoryConfig> = {};
    const envDatabasePath = this.env[NARRATIVE_MEMORY_ENV.databasePath];
    if (envDatabasePath !== undefined && envDatabasePath !== '') {
      envValues.databasePath = envDatabasePath;
    }
    const envDebounce = readNumber(this.env[NARRATIVE_MEMORY_ENV.debounceMs]);
    if (envDebounce !== undefined) {
      envValues.debounceMs = envDebounce;
    }
    const envTtl = readNumber(this.env[NARRATIVE_MEMORY_ENV.fallbackTtlMs]);
    if (envTtl !== undefined) {
      envValues.fallbackTtlMs = envTtl;
    }
    const cliValues: Partial<NarrativeMemoryConfig> = {};
    if (this.cli.databasePath !== undefined) {
      cliValues.databasePath = this.cli.databasePath;
    }
    if (this.cli.debounceMs !== undefined) {
      cliValues.debounceMs = this.cli.debounceMs;
    }
    if (this.cli.fallbackTtlMs !== undefined) {
      cliValues.fallbackTtlMs = this.cli.fallbackTtlMs;
    }
    const runtime = { ...this.runtimeGlobal, ...(this.runtimeByRoot.get(rootPath) ?? {}) };

    const resolved: NarrativeMemoryConfig = {
      ...DEFAULT_NARRATIVE_MEMORY_CONFIG,
      ...fileValues,
      ...envValues,
      ...cliValues,
      ...runtime
    };
    // The asymmetry, applied last so it cannot be undone by ordering: the flag
    // LOCKS the key rather than merely outranking one rung of it.
    if (this.cli.databasePath !== undefined) {
      resolved.databasePath = this.cli.databasePath;
    }
    this.resolvedByRoot.set(rootPath, resolved);
    return resolved;
  }

  private readFileRung(rootPath: string): Partial<NarrativeMemoryConfig> {
    const text = this.readConfigFile(rootPath);
    if (text === undefined) {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A malformed file is a rung that does not answer, not a reason to refuse
      // to start: the index must come up on the defaults and say so in the log.
      return {};
    }
    if (parsed === null || typeof parsed !== 'object') {
      return {};
    }
    const source = parsed as Record<string, unknown>;
    const values: Partial<NarrativeMemoryConfig> = {};
    if (typeof source.databasePath === 'string' && source.databasePath !== '') {
      values.databasePath = source.databasePath;
    }
    if (typeof source.diagnosticsEnabled === 'boolean') {
      values.diagnosticsEnabled = source.diagnosticsEnabled;
    }
    for (const key of ['debounceMs', 'fallbackTtlMs', 'maxOpenWorkspaces'] as const) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        values[key] = value;
      }
    }
    return values;
  }
}
