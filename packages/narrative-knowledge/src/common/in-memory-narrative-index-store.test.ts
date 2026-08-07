/**
 * The BUN half of the two-harness scheme (TASK-022 WP-3).
 *
 * It is deliberately a few lines long. Every assertion lives in the
 * runner-agnostic contract core; this file only feeds it the in-memory adapter
 * and translates "threw" into `bun:test`'s idea of a failure. The node half
 * (`test/node/sqlite-store-contract.test.ts`) is the same few lines around the
 * SQLite adapter. There is one body of assertions, so the two cannot drift.
 *
 * WHAT A GREEN RUN HERE PROVES: the contract. WHAT IT DOES NOT: anything about
 * SQLite — no DDL, no `CHECK`, no `STRICT`, no writer lock, no durability.
 * `bun` cannot even resolve `node:sqlite`. If this file were the only thing
 * guarding the store, the store would be untested.
 */

import { describe, expect, test } from 'bun:test';
import { InMemoryNarrativeIndexStore } from './in-memory-narrative-index-store';
import {
  NARRATIVE_INDEX_STORE_CONTRACT,
  type MakeContractStore
} from './narrative-index-store-contract';

const makeStore: MakeContractStore = options =>
  new InMemoryNarrativeIndexStore({ readOnly: options?.readOnly === true });

describe('NarrativeIndexStore contract — in-memory adapter', () => {
  for (const contractCase of NARRATIVE_INDEX_STORE_CONTRACT) {
    test(contractCase.name, async () => {
      await contractCase.run(makeStore);
    });
  }

  test('the contract is not empty, and its case names are unique', () => {
    // A harness that iterates an empty list is green by vacuity — the exact
    // failure R-9 describes, applied to the device meant to prevent drift.
    expect(NARRATIVE_INDEX_STORE_CONTRACT.length).toBeGreaterThanOrEqual(20);
    const names = NARRATIVE_INDEX_STORE_CONTRACT.map(entry => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
