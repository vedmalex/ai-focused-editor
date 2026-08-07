/**
 * The readiness block's "тест вызова `configure(patch)`" (TASK-022 WP-5).
 *
 * WHAT IS ACTUALLY WORTH ASSERTING HERE, and it is not "configure was called".
 * The plan says so in as many words (`plan.md:288`): without a returned result
 * WP-5 could only prove it CALLED the method. `configure` returns
 * `ConfigureResult` precisely so that is not the assertion. What this file
 * pins is the half WP-5 owns — the SHAPE of the patch it sends — because
 * ОВ-9б's idempotence guarantees are stated over that shape and every one of
 * them is void if the patch is built wrong.
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_NARRATIVE_MEMORY_CONFIG } from './narrative-memory-config';
import {
  NARRATIVE_MEMORY_CONFIG_RANGES,
  NARRATIVE_MEMORY_PATCH_KEYS,
  InMemoryConfigStore,
  NarrativeMemoryConfigurator
} from './narrative-memory-configure';
import {
  NARRATIVE_MEMORY_DATABASE_PATH,
  NARRATIVE_MEMORY_DEBOUNCE_MS,
  NARRATIVE_MEMORY_DIAGNOSTICS_ENABLED,
  NARRATIVE_MEMORY_FALLBACK_TTL_MS,
  NARRATIVE_MEMORY_MAX_OPEN_WORKSPACES,
  NARRATIVE_MEMORY_PREFERENCE_KEYS,
  PATCH_KEY_BY_PREFERENCE,
  isNarrativeMemoryPreference,
  narrativeMemoryPatchFromPreferences,
  type NarrativeMemoryPreferenceKey
} from './narrative-memory-preference-contract';

/** A preference store standing in for `PreferenceService.get`. */
function reader(values: Partial<Record<NarrativeMemoryPreferenceKey, unknown>>) {
  return (key: NarrativeMemoryPreferenceKey): unknown => values[key];
}

describe('WP-5 — the preference contribution is AD-5, exactly', () => {
  test('all five keys, spelled as AD-5 spells them', () => {
    expect([...NARRATIVE_MEMORY_PREFERENCE_KEYS]).toEqual([
      'narrativeMemory.diagnostics.enabled',
      'narrativeMemory.index.databasePath',
      'narrativeMemory.index.debounceMs',
      'narrativeMemory.index.fallbackTtlMs',
      'narrativeMemory.index.maxOpenWorkspaces'
    ]);
  });

  test('every patch key of ОВ-9б is reachable from a preference', () => {
    // Read in THIS direction on purpose: a sixth field added to the patch is
    // then a compile error here until somebody decides which preference drives
    // it, rather than being silently unreachable from the UI.
    expect(Object.keys(PATCH_KEY_BY_PREFERENCE).sort()).toEqual([...NARRATIVE_MEMORY_PATCH_KEYS].sort());
  });

  test('`diagnostics.enabled` is deliberately NOT a patch field', () => {
    // The backend has no diagnostics to enable — publishing markers is an act
    // against `ProblemManager` on the frontend — so routing it through
    // `configure` would add a round trip that could only agree with the value
    // the frontend already holds.
    expect(Object.values(PATCH_KEY_BY_PREFERENCE)).not.toContain(NARRATIVE_MEMORY_DIAGNOSTICS_ENABLED);
  });

  test('the change filter accepts our keys and nothing else', () => {
    for (const key of NARRATIVE_MEMORY_PREFERENCE_KEYS) {
      expect(isNarrativeMemoryPreference(key)).toBe(true);
    }
    expect(isNarrativeMemoryPreference('narrativeMemory.index')).toBe(false);
    expect(isNarrativeMemoryPreference('editor.fontSize')).toBe(false);
  });
});

describe('WP-5 — the patch it sends', () => {
  test('an unset preference is OMITTED, not sent as undefined', () => {
    // THE LOAD-BEARING CASE (ОВ-9б consequence 1). "Ключа нет" means "do not
    // touch"; an explicit `undefined` means "reset to the next source down the
    // ladder". A patch built with `{ debounceMs: get(...) }` would send the
    // second instruction every time the first was meant, and every value set by
    // a CLI flag or `.theia/narrative-memory.json` would be wiped the moment a
    // frontend connected.
    const patch = narrativeMemoryPatchFromPreferences(reader({}));
    expect(patch).toEqual({});
    expect('debounceMs' in patch).toBe(false);
    expect('databasePath' in patch).toBe(false);
  });

  test('set preferences arrive as the fields ОВ-9б names', () => {
    const patch = narrativeMemoryPatchFromPreferences(
      reader({
        [NARRATIVE_MEMORY_DATABASE_PATH]: '.theia/other.db',
        [NARRATIVE_MEMORY_DEBOUNCE_MS]: 900,
        [NARRATIVE_MEMORY_FALLBACK_TTL_MS]: 60_000,
        [NARRATIVE_MEMORY_MAX_OPEN_WORKSPACES]: 8
      })
    );
    expect(patch).toEqual({
      databasePath: '.theia/other.db',
      debounceMs: 900,
      fallbackTtlMs: 60_000,
      maxOpenWorkspaces: 8
    });
  });

  test('`diagnostics.enabled` never reaches the patch even when set', () => {
    const patch = narrativeMemoryPatchFromPreferences(
      reader({ [NARRATIVE_MEMORY_DIAGNOSTICS_ENABLED]: false })
    );
    expect(patch).toEqual({});
  });

  test('a hand-edited settings.json with the wrong type is dropped, not forwarded', () => {
    // A string in `debounceMs` would otherwise reach `configure` and come back
    // as `out-of-range` — a true refusal with a misleading reason, which sends
    // the user to check a number that is not the problem.
    const patch = narrativeMemoryPatchFromPreferences(
      reader({
        [NARRATIVE_MEMORY_DEBOUNCE_MS]: '900',
        [NARRATIVE_MEMORY_FALLBACK_TTL_MS]: Number.NaN,
        [NARRATIVE_MEMORY_MAX_OPEN_WORKSPACES]: null,
        [NARRATIVE_MEMORY_DATABASE_PATH]: ''
      })
    );
    expect(patch).toEqual({});
  });
});

describe('WP-5 — the patch really is accepted by the handler WP-4b shipped', () => {
  test('the defaults round-trip: every key applies, none is rejected', () => {
    // The two halves of AD-5 were built in different work packages and could
    // agree on paper and disagree in fact. This joins them: the patch WP-5
    // builds from the schema defaults is fed to the handler WP-4b wrote.
    const configurator = new NarrativeMemoryConfigurator(new InMemoryConfigStore());
    const patch = narrativeMemoryPatchFromPreferences(
      reader({
        [NARRATIVE_MEMORY_DATABASE_PATH]: DEFAULT_NARRATIVE_MEMORY_CONFIG.databasePath,
        [NARRATIVE_MEMORY_DEBOUNCE_MS]: DEFAULT_NARRATIVE_MEMORY_CONFIG.debounceMs,
        [NARRATIVE_MEMORY_FALLBACK_TTL_MS]: DEFAULT_NARRATIVE_MEMORY_CONFIG.fallbackTtlMs,
        [NARRATIVE_MEMORY_MAX_OPEN_WORKSPACES]: DEFAULT_NARRATIVE_MEMORY_CONFIG.maxOpenWorkspaces
      })
    );
    const result = configurator.configure(patch);
    expect(result.rejected).toEqual([]);
    expect(result.effective.debounceMs).toBe(DEFAULT_NARRATIVE_MEMORY_CONFIG.debounceMs);
  });

  test('an out-of-range value comes back REJECTED, and the old value stands', () => {
    // ОВ-9б: "Значение вне диапазона попадает в `rejected` с `out-of-range`,
    // прежнее значение сохраняется. Зажим отвергнут" — and the price of that
    // decision, stated there, is that WP-5 must SHOW the rejection. This is the
    // case that proves there is something to show.
    const configurator = new NarrativeMemoryConfigurator(new InMemoryConfigStore());
    const tooBig = NARRATIVE_MEMORY_CONFIG_RANGES.debounceMs[1] + 1;
    const result = configurator.configure(
      narrativeMemoryPatchFromPreferences(reader({ [NARRATIVE_MEMORY_DEBOUNCE_MS]: tooBig }))
    );
    expect(result.rejected).toEqual([{ key: 'debounceMs', reason: 'out-of-range' }]);
    // NOT CLAMPED. A clamped value would leave the settings UI showing one
    // number while the index used another.
    expect(result.effective.debounceMs).toBe(DEFAULT_NARRATIVE_MEMORY_CONFIG.debounceMs);
    expect(result.effective.debounceMs).not.toBe(NARRATIVE_MEMORY_CONFIG_RANGES.debounceMs[1]);
  });

  test('a `databasePath` change comes back DEFERRED, so the UI can say when it starts', () => {
    const configurator = new NarrativeMemoryConfigurator(new InMemoryConfigStore());
    const result = configurator.configure(
      narrativeMemoryPatchFromPreferences(reader({ [NARRATIVE_MEMORY_DATABASE_PATH]: '.theia/moved.db' }))
    );
    expect(result.deferred).toEqual([{ key: 'databasePath', until: 'next-backend-start' }]);
  });

  test('sending the same patch twice does not move `configVersion`', () => {
    // ОВ-9б consequence 3 is what makes it safe for WP-5 to push on every
    // preference event — `PreferenceService` fires on each keystroke in a
    // settings field, and without this the watcher would be rebuilt dozens of
    // times while a user typed a number.
    const configurator = new NarrativeMemoryConfigurator(new InMemoryConfigStore());
    const patch = narrativeMemoryPatchFromPreferences(reader({ [NARRATIVE_MEMORY_DEBOUNCE_MS]: 700 }));
    const first = configurator.configure(patch);
    const second = configurator.configure(patch);
    expect(second.configVersion).toBe(first.configVersion);
  });
});
