/**
 * The NODE half of the READING contract (TASK-022 WP-4a).
 *
 * Same core, other adapter. This is the run in which the group-B teeth of
 * tech_spec ОВ-1 are executed against a REAL schema: `bun` cannot resolve
 * `node:sqlite`, so a green fast lane says nothing about `CHECK`, `STRICT`,
 * `ORDER BY` or any collation — and the ordering cases here (ISS-349) are
 * precisely about a collation.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { NARRATIVE_INDEX_READ_CONTRACT } from '../../lib/common/index.js';
import { SqliteNarrativeIndexStore } from '../../lib/node/sqlite-narrative-index-store.js';
import { disposeAll, makeWorkspace } from './harness.mts';

const opened: { close(): void }[] = [];

const makeStore = () => {
  const workspace = makeWorkspace('read-contract');
  const store = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0
  });
  opened.push(store);
  return store;
};

test('the reading contract core is not empty', () => {
  // Guard against the harness iterating nothing and reporting success.
  assert.ok(
    NARRATIVE_INDEX_READ_CONTRACT.length >= 20,
    `expected at least 20 reading cases, saw ${NARRATIVE_INDEX_READ_CONTRACT.length}`
  );
});

for (const contractCase of NARRATIVE_INDEX_READ_CONTRACT) {
  test(`reads (sqlite): ${contractCase.name}`, async () => {
    await contractCase.run(makeStore);
  });
}

after(() => {
  for (const store of opened.reverse()) {
    try {
      store.close();
    } catch {
      // Already closed by the case itself.
    }
  }
  disposeAll();
});
