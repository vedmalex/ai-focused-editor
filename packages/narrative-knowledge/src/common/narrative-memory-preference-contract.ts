/**
 * The five preference keys of AD-5, and the rule that turns them into a
 * `configure(patch)` (TASK-022 WP-5).
 *
 * THEIA-FREE ON PURPOSE, even though preferences are a frontend concern.
 * `PreferenceSchema` and `nls` live in the schema module in `src/browser`; what
 * lives here is only the MAPPING — which key feeds which patch field, and which
 * key does not feed the patch at all — because that mapping is what the
 * readiness case "тест вызова `configure(patch)`" is about, and it must be
 * assertable in the ordinary `bun` lane.
 *
 * `narrativeMemory.diagnostics.enabled` IS DELIBERATELY NOT A PATCH FIELD.
 * `NarrativeMemoryConfig` carries `diagnosticsEnabled` because it is one
 * configuration record, but `NarrativeMemoryConfigPatch` (tech_spec ОВ-9б) does
 * not: the backend has no diagnostics to enable. Publishing markers is a
 * frontend act against `ProblemManager`, it takes effect immediately rather
 * than "со следующего окна вотчера", and routing it through the backend would
 * add a round trip that could only ever agree with the value the frontend
 * already holds.
 */

import type { NarrativeMemoryConfigPatch, NarrativeMemoryPatchKey } from './narrative-memory-configure';

/** `narrativeMemory.diagnostics.enabled` — frontend-only, immediate. */
export const NARRATIVE_MEMORY_DIAGNOSTICS_ENABLED = 'narrativeMemory.diagnostics.enabled';
export const NARRATIVE_MEMORY_DATABASE_PATH = 'narrativeMemory.index.databasePath';
export const NARRATIVE_MEMORY_DEBOUNCE_MS = 'narrativeMemory.index.debounceMs';
export const NARRATIVE_MEMORY_FALLBACK_TTL_MS = 'narrativeMemory.index.fallbackTtlMs';
export const NARRATIVE_MEMORY_MAX_OPEN_WORKSPACES = 'narrativeMemory.index.maxOpenWorkspaces';

/** Every key of AD-5, as data. The status-bar and diagnostics contributions
 *  watch this set rather than a hand-copied list of strings. */
export const NARRATIVE_MEMORY_PREFERENCE_KEYS = [
  NARRATIVE_MEMORY_DIAGNOSTICS_ENABLED,
  NARRATIVE_MEMORY_DATABASE_PATH,
  NARRATIVE_MEMORY_DEBOUNCE_MS,
  NARRATIVE_MEMORY_FALLBACK_TTL_MS,
  NARRATIVE_MEMORY_MAX_OPEN_WORKSPACES
] as const;

export type NarrativeMemoryPreferenceKey = (typeof NARRATIVE_MEMORY_PREFERENCE_KEYS)[number];

/**
 * Which preference feeds which field of the patch.
 *
 * A TOTAL `Record` over the patch keys, read in that direction rather than the
 * other: a sixth patch field added to ОВ-9б then fails to compile here until
 * somebody decides which preference (if any) drives it, instead of silently
 * being unreachable from the UI.
 */
export const PATCH_KEY_BY_PREFERENCE: Readonly<Record<NarrativeMemoryPatchKey, NarrativeMemoryPreferenceKey>> =
  Object.freeze({
    databasePath: NARRATIVE_MEMORY_DATABASE_PATH,
    debounceMs: NARRATIVE_MEMORY_DEBOUNCE_MS,
    fallbackTtlMs: NARRATIVE_MEMORY_FALLBACK_TTL_MS,
    maxOpenWorkspaces: NARRATIVE_MEMORY_MAX_OPEN_WORKSPACES
  });

/** What a preference lookup can hand back. `undefined` means "not set". */
export type PreferenceLookup = (key: NarrativeMemoryPreferenceKey) => unknown;

/**
 * Build the patch to send for the current preference values.
 *
 * SPARSE, AND THE SPARSENESS IS LOAD-BEARING (ОВ-9б, consequence 1). A key the
 * preference service has no value for is OMITTED — `'key' in patch` is false —
 * which the handler reads as "do not touch". A key present with `undefined` is
 * a different instruction: reset to the next source down the ladder. Writing
 * `{ debounceMs: preferences.get(...) }` unconditionally would send the second
 * instruction every time the first was meant, and every backend value set by a
 * CLI flag or `.theia/narrative-memory.json` would be wiped the moment a
 * frontend connected.
 *
 * Type-checking here is deliberate and not defensive noise: preference values
 * come back as `unknown` from a JSON document a user can hand-edit, and a
 * string in `debounceMs` would otherwise reach `configure` and be rejected as
 * `out-of-range` — a true refusal with a misleading reason.
 */
export function narrativeMemoryPatchFromPreferences(read: PreferenceLookup): NarrativeMemoryConfigPatch {
  const patch: NarrativeMemoryConfigPatch = {};
  const numeric = (key: NarrativeMemoryPreferenceKey): number | undefined => {
    const value = read(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };

  const databasePath = read(NARRATIVE_MEMORY_DATABASE_PATH);
  if (typeof databasePath === 'string' && databasePath.length > 0) {
    patch.databasePath = databasePath;
  }
  const debounceMs = numeric(NARRATIVE_MEMORY_DEBOUNCE_MS);
  if (debounceMs !== undefined) {
    patch.debounceMs = debounceMs;
  }
  const fallbackTtlMs = numeric(NARRATIVE_MEMORY_FALLBACK_TTL_MS);
  if (fallbackTtlMs !== undefined) {
    patch.fallbackTtlMs = fallbackTtlMs;
  }
  const maxOpenWorkspaces = numeric(NARRATIVE_MEMORY_MAX_OPEN_WORKSPACES);
  if (maxOpenWorkspaces !== undefined) {
    patch.maxOpenWorkspaces = maxOpenWorkspaces;
  }
  return patch;
}

/** Whether `key` is one this package cares about — the preference-change filter. */
export function isNarrativeMemoryPreference(key: string): key is NarrativeMemoryPreferenceKey {
  return (NARRATIVE_MEMORY_PREFERENCE_KEYS as readonly string[]).includes(key);
}
