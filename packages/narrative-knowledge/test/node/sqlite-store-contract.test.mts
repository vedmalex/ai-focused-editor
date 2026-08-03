/**
 * The NODE half of the two-harness scheme (TASK-022 WP-3).
 *
 * Same contract core, other adapter. If this file and its `bun` twin ever
 * disagree, the two adapters have drifted — which is the whole reason the
 * assertions live in one runner-agnostic module instead of being written twice.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { NARRATIVE_INDEX_STORE_CONTRACT } from '../../lib/common/index.js';
import { SqliteNarrativeIndexStore } from '../../lib/node/sqlite-narrative-index-store.js';
import { disposeAll, makeWorkspace } from './harness.mts';

const opened: { close(): void }[] = [];

function newStore(options: Record<string, unknown> = {}) {
  const workspace = makeWorkspace('contract');
  const store = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0,
    ...options
  });
  opened.push(store);
  return store;
}

const makeStore = (options?: { readOnly?: boolean }) => {
  if (options?.readOnly !== true) {
    return newStore();
  }
  // The SQLite adapter has no read-only switch, and giving it one would be a
  // test-only door into production code. It reaches the state the only way it
  // does in the field: a first instance takes the writer lock, and a second one
  // opening the same file finds the lock alive and steps down.
  const workspace = makeWorkspace('contract-readonly');
  const writer = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0
  });
  opened.push(writer);
  const reader = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0
  });
  opened.push(reader);
  assert.equal(reader.lifecycle().readOnly, true, 'the second instance should have stepped down to read-only');
  return reader;
};

test('the contract core is not empty', () => {
  // Guard against the harness iterating nothing and reporting success — the
  // failure mode where a gate is green precisely because it checks nothing.
  assert.ok(
    NARRATIVE_INDEX_STORE_CONTRACT.length >= 20,
    `expected the contract core to carry at least 20 cases, saw ${NARRATIVE_INDEX_STORE_CONTRACT.length}`
  );
});

for (const contractCase of NARRATIVE_INDEX_STORE_CONTRACT) {
  test(`contract (sqlite): ${contractCase.name}`, async () => {
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
