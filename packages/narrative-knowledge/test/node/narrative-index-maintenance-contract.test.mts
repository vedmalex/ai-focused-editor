/**
 * The NODE half of the MAINTENANCE contract (TASK-022 WP-4b).
 *
 * Same core, other adapters — and here the second adapter is not only the store.
 * The config store is the REAL `NarrativeMemoryConfigResolver`, ladder and all,
 * so the `configure` cases are executed against the thing that ships rather than
 * against a record with a spread in it.
 *
 * WHAT ONLY THIS LANE PROVES. `moveDocument` keeps `doc_id` where `doc_id` is an
 * actual SQLite rowid that `mention`, `relation`, `relation_evidence` and
 * `entity` all reference — the in-memory adapter has to rewrite five
 * denormalized copies of the path to reach the same state, so "the two agree" is
 * a claim only a run against both can make. `clearDerivedRelations` really
 * deletes through a `DELETE ... WHERE origin = 'derived'` and not through an
 * array filter. And an incremental transaction really commits under the
 * generation compare-and-set.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { NARRATIVE_MAINTENANCE_CONTRACT } from '../../lib/common/index.js';
import { SqliteNarrativeIndexStore } from '../../lib/node/sqlite-narrative-index-store.js';
import { NarrativeMemoryConfigResolver } from '../../lib/node/narrative-memory-config-resolver.js';
import { disposeAll, makeWorkspace } from './harness.mts';

const opened: { close(): void }[] = [];

const makeHarness = () => {
  const workspace = makeWorkspace('maintenance-contract');
  const store = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0
  });
  opened.push(store);
  // A resolver with rungs 3 and 4 emptied ON PURPOSE: the ladder itself has its
  // own suite (`config-ladder.test.mts`), and a case here that accidentally read
  // the developer's environment would be a case that passes on one machine.
  const configStore = new NarrativeMemoryConfigResolver({ env: {}, readConfigFile: () => undefined });
  return {
    store,
    configStore,
    lockDatabasePathByCli: (locked: boolean) =>
      configStore.setCliOptions(locked ? { databasePath: 'locked/by-cli.db' } : {})
  };
};

test('the maintenance contract core is not empty', () => {
  assert.ok(
    NARRATIVE_MAINTENANCE_CONTRACT.length >= 18,
    `expected at least 18 maintenance cases, saw ${NARRATIVE_MAINTENANCE_CONTRACT.length}`
  );
});

for (const contractCase of NARRATIVE_MAINTENANCE_CONTRACT) {
  test(`maintenance (sqlite): ${contractCase.name}`, async () => {
    await contractCase.run(makeHarness);
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
