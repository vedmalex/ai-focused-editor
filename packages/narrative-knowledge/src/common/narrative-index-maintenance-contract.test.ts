/**
 * The BUN half of the MAINTENANCE contract (TASK-022 WP-4b).
 *
 * A few lines by design, like its two predecessors: every assertion lives in the
 * runner-agnostic core, and this file only feeds it the in-memory adapter and a
 * rung-1 config store with no ladder under it.
 *
 * WHAT A GREEN RUN HERE PROVES: the coalescing, the guard, the pairing rule and
 * the `configure` arithmetic are what the contract says. WHAT IT DOES NOT: that
 * `moveDocument` keeps `doc_id` when `doc_id` is a real SQLite rowid every other
 * table joins to, that a transaction really serializes, or that `configure` sits
 * correctly on the five-rung ladder — `bun` cannot resolve `node:sqlite`, and the
 * resolver reads a file.
 */

import { describe, expect, test } from 'bun:test';
import { InMemoryNarrativeIndexStore } from './in-memory-narrative-index-store';
import { InMemoryConfigStore } from './narrative-memory-configure';
import {
  NARRATIVE_MAINTENANCE_CONTRACT,
  type MakeMaintenanceHarness
} from './narrative-index-maintenance-contract';

const makeHarness: MakeMaintenanceHarness = () => {
  const configStore = new InMemoryConfigStore();
  return {
    store: new InMemoryNarrativeIndexStore(),
    configStore,
    lockDatabasePathByCli: locked => configStore.setDatabasePathLockedByCli(locked)
  };
};

describe('narrative index maintenance — in-memory adapter', () => {
  for (const contractCase of NARRATIVE_MAINTENANCE_CONTRACT) {
    test(contractCase.name, async () => {
      await contractCase.run(makeHarness);
    });
  }

  test('the maintenance contract is not empty, and its case names are unique', () => {
    // A harness that iterates an empty list is green by vacuity — R-9's failure,
    // applied to the device meant to prevent drift.
    expect(NARRATIVE_MAINTENANCE_CONTRACT.length).toBeGreaterThanOrEqual(18);
    const names = NARRATIVE_MAINTENANCE_CONTRACT.map(entry => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
