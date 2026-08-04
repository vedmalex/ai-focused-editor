import { nls } from '@theia/core/lib/common/nls';
import {
  PreferenceContribution,
  PreferenceSchema,
  PreferenceScope
} from '@theia/core/lib/common/preferences';
import {
  DEFAULT_NARRATIVE_MEMORY_CONFIG,
  NARRATIVE_MEMORY_CONFIG_RANGES,
  NARRATIVE_MEMORY_NLS_PREFIX
} from '../common';

/**
 * The five preference keys of AD-5 (TASK-022 WP-5).
 *
 * DEFAULTS AND RANGES ARE IMPORTED, NEVER RETYPED. `DEFAULT_NARRATIVE_MEMORY_CONFIG`
 * is what the backend falls back to at the bottom of the ОВ-9а ladder and
 * `NARRATIVE_MEMORY_CONFIG_RANGES` is what `configure()` validates against; a
 * literal `400` here would be a second edition of both, and the failure would
 * be silent in the worst way — the settings UI would show one number while the
 * index used another, which is the divergence-of-sources defect this whole epic
 * exists to remove.
 *
 * `minimum`/`maximum` MIRROR the backend ranges but do NOT replace them. Theia's
 * settings editor uses them to warn; a hand-edited `settings.json` reaches
 * `configure()` regardless, and ОВ-9б is explicit that an out-of-range value is
 * REJECTED there rather than clamped. So the same bound is stated in two places
 * on purpose — one as a hint, one as the rule — and both read from the same
 * constant, so they cannot drift.
 *
 * SCOPE IS `Folder` FOR EVERY KEY, matching `ai-focused-editor-preferences.ts`:
 * in Theia a property's `scope` is the WIDEST scope it may be set at, so
 * `Folder` (the most permissive) is what allows a workspace-level override. A
 * `User` scope would forbid one, and these are per-manuscript settings — a
 * 200-chapter book and a 4-chapter fixture legitimately want different debounce
 * windows (ОВ-9б, "Область действия").
 *
 * The literal `properties` object is also a hard requirement of the docs
 * inventory: `extract-feature-inventory.mjs` reads preference keys out of a
 * `const x: PreferenceSchema = { properties: { ... } }` object literal, and a
 * schema assembled by a function call would extract NOTHING — `docs:drift`
 * would then stay green about five undocumented keys, which is the "green
 * because it is looking away" failure mode plan R-9 names.
 */
export const narrativeMemoryPreferenceSchema: PreferenceSchema = {
  title: nls.localize(`${NARRATIVE_MEMORY_NLS_PREFIX}/command-category`, 'Narrative Memory'),
  scope: PreferenceScope.Folder,
  properties: {
    'narrativeMemory.diagnostics.enabled': {
      type: 'boolean',
      default: DEFAULT_NARRATIVE_MEMORY_CONFIG.diagnosticsEnabled,
      description: nls.localize(
        `${NARRATIVE_MEMORY_NLS_PREFIX}/pref-diagnostics-enabled`,
        'Publish unresolved narrative references as problems. Takes effect immediately.'
      )
    },
    'narrativeMemory.index.databasePath': {
      type: 'string',
      default: DEFAULT_NARRATIVE_MEMORY_CONFIG.databasePath,
      description: nls.localize(
        `${NARRATIVE_MEMORY_NLS_PREFIX}/pref-database-path`,
        'Where the narrative index database lives, relative to the workspace root. Changing it takes effect at the NEXT backend start — the current database stays open until then.'
      )
    },
    'narrativeMemory.index.debounceMs': {
      type: 'number',
      default: DEFAULT_NARRATIVE_MEMORY_CONFIG.debounceMs,
      minimum: NARRATIVE_MEMORY_CONFIG_RANGES.debounceMs[0],
      maximum: NARRATIVE_MEMORY_CONFIG_RANGES.debounceMs[1],
      description: nls.localize(
        `${NARRATIVE_MEMORY_NLS_PREFIX}/pref-debounce-ms`,
        'How long to wait after the last edit before re-indexing, in milliseconds. Takes effect at the next watcher window. A value outside 0-60000 is refused, not clamped.'
      )
    },
    'narrativeMemory.index.fallbackTtlMs': {
      type: 'number',
      default: DEFAULT_NARRATIVE_MEMORY_CONFIG.fallbackTtlMs,
      minimum: NARRATIVE_MEMORY_CONFIG_RANGES.fallbackTtlMs[0],
      maximum: NARRATIVE_MEMORY_CONFIG_RANGES.fallbackTtlMs[1],
      description: nls.localize(
        `${NARRATIVE_MEMORY_NLS_PREFIX}/pref-fallback-ttl-ms`,
        'How often to sweep the workspace when file notifications are unreliable, in milliseconds. Takes effect at the next watcher window. A value outside 1000-3600000 is refused, not clamped.'
      )
    },
    'narrativeMemory.index.maxOpenWorkspaces': {
      type: 'number',
      default: DEFAULT_NARRATIVE_MEMORY_CONFIG.maxOpenWorkspaces,
      minimum: NARRATIVE_MEMORY_CONFIG_RANGES.maxOpenWorkspaces[0],
      maximum: NARRATIVE_MEMORY_CONFIG_RANGES.maxOpenWorkspaces[1],
      description: nls.localize(
        `${NARRATIVE_MEMORY_NLS_PREFIX}/pref-max-open-workspaces`,
        'How many workspace indexes may stay open at once; the least recently used is closed beyond this. A value outside 1-32 is refused, not clamped.'
      )
    }
  }
};

export const NarrativeMemoryPreferenceContribution: PreferenceContribution = {
  schema: narrativeMemoryPreferenceSchema
};
