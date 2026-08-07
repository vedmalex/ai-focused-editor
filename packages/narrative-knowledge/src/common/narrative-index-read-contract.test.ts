/**
 * The BUN half of the READING contract (TASK-022 WP-4a).
 *
 * A few lines by design, exactly like its WP-3 twin: every assertion lives in
 * the runner-agnostic core, this file only feeds it the in-memory adapter. The
 * node half (`test/node/narrative-index-read-contract.test.mts`) is the same
 * few lines around SQLite.
 *
 * WHAT A GREEN RUN HERE PROVES: that the service's answers are what the
 * contract says, against a double. WHAT IT DOES NOT: anything about SQLite —
 * `bun` cannot even resolve `node:sqlite`.
 */

import { describe, expect, test } from 'bun:test';
import { InMemoryNarrativeIndexStore } from './in-memory-narrative-index-store';
import type { MakeContractStore } from './narrative-index-store-contract';
import { NARRATIVE_INDEX_READ_CONTRACT } from './narrative-index-read-contract';

const makeStore: MakeContractStore = options =>
  new InMemoryNarrativeIndexStore({ readOnly: options?.readOnly === true });

describe('narrative index reads — in-memory adapter', () => {
  for (const contractCase of NARRATIVE_INDEX_READ_CONTRACT) {
    test(contractCase.name, async () => {
      await contractCase.run(makeStore);
    });
  }

  test('the reading contract is not empty, and its case names are unique', () => {
    // A harness that iterates an empty list is green by vacuity — the same
    // failure R-9 describes, applied to the device meant to prevent drift.
    expect(NARRATIVE_INDEX_READ_CONTRACT.length).toBeGreaterThanOrEqual(20);
    const names = NARRATIVE_INDEX_READ_CONTRACT.map(entry => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
