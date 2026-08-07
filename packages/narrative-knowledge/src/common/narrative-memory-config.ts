/**
 * `NarrativeMemoryConfig` — the settable surface of the narrative index
 * (TASK-022 WP-1, plan AD-5 plus the fifth key added by tech_spec ОВ-9б).
 *
 * WP-1 OWNS THE TYPE AND THE DEFAULTS, AND NOTHING ELSE. The ladder of sources
 * that produces a value (a frontend patch over CLI flags over environment over
 * a per-workspace file over these defaults) is resolved on the backend and
 * belongs to WP-3; the live `configure(patch)` handler with its accepted/
 * deferred/rejected result and its valid ranges belongs to WP-4b; the
 * preference contribution belongs to WP-5. Printing any of those here would
 * create a second edition of a decision whose single printed edition is
 * tech_spec ОВ-9а/ОВ-9б — the failure mode this task has already paid for
 * repeatedly.
 *
 * The consumers of this type — the store adapter and the watcher — receive a
 * finished `NarrativeMemoryConfig` by injection and read NO source themselves.
 * That is what keeps them testable without an environment.
 */

export interface NarrativeMemoryConfig {
  /**
   * Whether the index publishes editor diagnostics.
   *
   * Preference `narrativeMemory.diagnostics.enabled`. Takes effect
   * IMMEDIATELY — a user silencing noisy markers should not have to keep the
   * index off to get quiet.
   */
  diagnosticsEnabled: boolean;
  /**
   * Where the index database file lives, RELATIVE TO THE WORKSPACE ROOT.
   *
   * Preference `narrativeMemory.index.databasePath`. NOT changeable at
   * runtime: the file is already open, and re-aiming it mid-flight would drop
   * the writer lock.
   */
  databasePath: string;
  /**
   * How long the watcher coalesces file events before re-indexing, in ms.
   *
   * Preference `narrativeMemory.index.debounceMs`. A 200-chapter manuscript and
   * a 4-chapter fixture want different windows. Takes effect from the NEXT
   * watcher window; a window already in flight finishes on the old value.
   */
  debounceMs: number;
  /**
   * How often to sweep for changes the watcher may have missed, in ms.
   *
   * Preference `narrativeMemory.index.fallbackTtlMs`. Insurance against a
   * watcher that is alive but lossy.
   */
  fallbackTtlMs: number;
  /**
   * How many workspace databases the backend keeps open at once.
   *
   * Preference `narrativeMemory.index.maxOpenWorkspaces`. The backend serves N
   * workspaces addressed by root URI; this bounds the LRU of open databases.
   * This is the fifth key — a deliberate delta over AD-5's four, recorded in
   * tech_spec ОВ-9б.
   */
  maxOpenWorkspaces: number;
}

/**
 * The bottom rung of the source ladder: what the index uses when nothing else
 * said otherwise.
 *
 * Frozen because it is a shared value read from several places; a caller that
 * mutated it would be editing everyone else's defaults, and the bug would
 * surface far from the edit.
 */
export const DEFAULT_NARRATIVE_MEMORY_CONFIG: Readonly<NarrativeMemoryConfig> = Object.freeze({
  diagnosticsEnabled: true,
  databasePath: '.theia/narrative-index.db',
  debounceMs: 400,
  fallbackTtlMs: 300000,
  maxOpenWorkspaces: 4
});
