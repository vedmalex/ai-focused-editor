/**
 * The five NODE-ONLY behaviours, plus the rebuild log and the give-up rule
 * (TASK-022 WP-3, plan "Список node-only тестов", tech_spec ОВ-1 / ОВ-7).
 *
 * These are the behaviours the in-memory adapter cannot reproduce IN PRINCIPLE,
 * not merely ones nobody got round to: they are about a FILE, a SECOND PROCESS,
 * and a schema version. The contract core deliberately does not contain them —
 * putting them there would have forced weakening them until the in-memory
 * double passed, which is how a suite ends up thorough-looking and empty.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NARRATIVE_INDEX_SCHEMA_VERSION } from '../../lib/node/narrative-index-schema.js';
import {
  NARRATIVE_INDEX_REBUILD_CAUSES,
  SqliteNarrativeIndexStore,
  resetCorruptionMemory
} from '../../lib/node/sqlite-narrative-index-store.js';
import { NarrativeIndexStoreRegistry } from '../../lib/node/narrative-index-store-registry.js';
import { NarrativeMemoryConfigResolver } from '../../lib/node/narrative-memory-config-resolver.js';
import { caught, disposeAll, makeWorkspace, messageOf, PACKAGE_ROOT } from './harness.mts';

const opened: { close(): void }[] = [];

function open(workspace: { root: string; databaseFile: string }, options: Record<string, unknown> = {}) {
  const store = new SqliteNarrativeIndexStore({
    databaseFile: workspace.databaseFile,
    workspaceRoot: workspace.root,
    heartbeatIntervalMs: 0,
    ...options
  });
  opened.push(store);
  return store;
}

function seedOneDocument(store: any, relPath = 'manuscript/ch-01.md') {
  store.transaction((writer: any) =>
    writer.putDocument({
      relPath,
      kind: 'chapter',
      sizeBytes: 1,
      mtimeMs: 1,
      contentHash: 'h',
      indexedAt: 1
    })
  );
}

// --------------------------------------------------------------------------
// node-only #1 — data survives a PROCESS restart
// --------------------------------------------------------------------------

test('node-only 1: written data survives a real process restart', () => {
  const workspace = makeWorkspace('restart');
  // A CHILD PROCESS, not a second instance in this one. "Survives a restart" is
  // a claim about the FILE; an in-process re-open would also pass if the data
  // lived only in a module-level cache, so the test would not be testing the
  // thing it names.
  const script = join(workspace.root, 'writer.mjs');
  writeFileSync(
    script,
    `import { SqliteNarrativeIndexStore } from ${JSON.stringify(
      join(PACKAGE_ROOT, 'lib/node/sqlite-narrative-index-store.js')
    )};
const store = new SqliteNarrativeIndexStore({
  databaseFile: ${JSON.stringify(workspace.databaseFile)},
  workspaceRoot: ${JSON.stringify(workspace.root)},
  heartbeatIntervalMs: 0
});
store.transaction(writer => {
  writer.putDocument({ relPath: 'manuscript/ch-01.md', kind: 'chapter', sizeBytes: 42,
    mtimeMs: 7, contentHash: 'from-the-other-process', indexedAt: 9 });
});
process.stdout.write(String(store.lifecycle().generation));
store.close();
`
  );
  const printed = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
    encoding: 'utf8'
  });
  assert.equal(printed.trim(), '1', 'the child process did not commit');

  const store = open(workspace);
  const document = store.getDocument('manuscript/ch-01.md');
  assert.ok(document !== undefined, 'the row written by the other process is gone');
  assert.equal(document.contentHash, 'from-the-other-process');
  assert.equal(document.sizeBytes, 42);
  assert.equal(store.lifecycle().generation, 1, 'the generation did not survive');
});

// --------------------------------------------------------------------------
// node-only #2 — a schema version mismatch rebuilds SILENTLY, and says so
// --------------------------------------------------------------------------

test('node-only 2: a schema version mismatch rebuilds, quietly but not invisibly', () => {
  const workspace = makeWorkspace('version');
  const first = open(workspace);
  seedOneDocument(first);
  first.close();

  // Move the file to a version this build does not know.
  const db = new DatabaseSync(workspace.databaseFile);
  db.exec(`PRAGMA user_version = ${NARRATIVE_INDEX_SCHEMA_VERSION + 41}`);
  db.close();

  const log: any[] = [];
  const second = open(workspace, { log: (record: any) => log.push(record) });
  assert.equal(second.getDocument('manuscript/ch-01.md'), undefined, 'the stale content survived a rebuild');
  const rebuilds = log.filter(record => record.event === 'schema-rebuilt');
  assert.equal(rebuilds.length, 1, `expected exactly one rebuild record, saw ${JSON.stringify(log)}`);
  assert.equal(rebuilds[0].cause, 'schema-version-mismatch');
});

// --------------------------------------------------------------------------
// node-only #3 — a corrupt file rebuilds instead of taking the backend down
// --------------------------------------------------------------------------

test('node-only 3: a corrupt database rebuilds rather than crashing the backend', () => {
  const workspace = makeWorkspace('corrupt');
  const first = open(workspace);
  seedOneDocument(first);
  first.close();
  resetCorruptionMemory(workspace.databaseFile);

  writeFileSync(workspace.databaseFile, 'this is definitely not a database');

  const log: any[] = [];
  const second = open(workspace, { log: (record: any) => log.push(record) });
  assert.equal(second.lifecycle().corrupted, true, 'the corruption was not recorded');
  assert.equal(second.lifecycle().readOnly, false, 'the rebuilt store should be writable');
  seedOneDocument(second, 'manuscript/ch-02.md');
  assert.equal(second.listDocuments().length, 1, 'the rebuilt store is not usable');
  const rebuilds = log.filter(record => record.event === 'schema-rebuilt');
  assert.equal(rebuilds.length, 1);
  assert.equal(rebuilds[0].cause, 'corrupted');
});

// --------------------------------------------------------------------------
// node-only #4 — an absent file is created from nothing
// --------------------------------------------------------------------------

test('node-only 4: an absent database file is created, with its parent directory', () => {
  const workspace = makeWorkspace('absent');
  assert.equal(existsSync(workspace.databaseFile), false, 'the fixture was not empty');
  const log: any[] = [];
  const store = open(workspace, { log: (record: any) => log.push(record) });
  assert.equal(existsSync(workspace.databaseFile), true, 'no file was created');
  const rebuilds = log.filter(record => record.event === 'schema-rebuilt');
  assert.equal(rebuilds.length, 1);
  assert.equal(rebuilds[0].cause, 'absent');
  assert.equal(store.lifecycle().generation, 0);
});

// --------------------------------------------------------------------------
// node-only #5 — the R-2 smoke: which engine is actually underneath
// --------------------------------------------------------------------------

test('node-only 5: the pinned node:sqlite API subset exists, and the engine versions are printed', () => {
  // R-2 asks for the INTERSECTION of what Node 22.22 (what Electron 39.8.7
  // carries) and the local Node offer. The intersection is only meaningful if
  // someone can see which versions were actually measured, so this prints them
  // into the run rather than asserting silently.
  console.log(
    `[narrative-index] engine under test: node=${process.version} sqlite=${process.versions.sqlite}`
  );
  for (const member of ['exec', 'prepare', 'close']) {
    assert.equal(
      typeof (DatabaseSync.prototype as any)[member],
      'function',
      `DatabaseSync.${member} is missing on ${process.version}`
    );
  }
  const statement = new DatabaseSync(':memory:').prepare('SELECT 1 AS one');
  for (const member of ['run', 'get', 'all', 'iterate']) {
    assert.equal(
      typeof (Object.getPrototypeOf(statement) as any)[member],
      'function',
      `StatementSync.${member} is missing on ${process.version}`
    );
  }

  // THE ELECTRON HALF IS NOT RUN HERE, AND SAYING SO IS THE POINT. `electron` is
  // not installed in this working tree (`node_modules/electron` does not exist),
  // so no assertion in this file has touched Node 22.22. The probe that does
  // lives in `scripts/electron-smoke.mjs`, which runs under `verify:full`. A
  // test that pretended otherwise would be the exact failure mode this task
  // keeps finding: an artefact claiming something about code it never ran.
  const electronInstalled = existsSync(join(PACKAGE_ROOT, '..', '..', 'node_modules', 'electron'));
  console.log(
    `[narrative-index] electron present in this tree: ${electronInstalled}; ` +
      'the Node 22.22 half of R-2 is proven by scripts/electron-smoke.mjs under `verify:full`, not here'
  );
});

// --------------------------------------------------------------------------
// The three causes are DISTINGUISHABLE, and carry a duration
// --------------------------------------------------------------------------

test('all three rebuild causes are distinguishable in the log, and each carries a duration', () => {
  const seen = new Set<string>();
  const durations: number[] = [];

  const record = (log: any[]) => {
    const rebuild = log.find(entry => entry.event === 'schema-rebuilt');
    assert.ok(rebuild !== undefined, `no rebuild record in ${JSON.stringify(log)}`);
    seen.add(rebuild.cause);
    assert.equal(typeof rebuild.durationMs, 'number', 'the record carries no duration');
    assert.ok(rebuild.durationMs >= 0, 'a negative duration');
    durations.push(rebuild.durationMs);
    assert.equal(typeof rebuild.databaseFile, 'string', 'the record does not say WHICH database');
  };

  // absent
  const absent = makeWorkspace('cause-absent');
  const absentLog: any[] = [];
  open(absent, { log: (entry: any) => absentLog.push(entry) }).close();
  record(absentLog);

  // schema-version-mismatch
  const version = makeWorkspace('cause-version');
  open(version).close();
  const db = new DatabaseSync(version.databaseFile);
  db.exec('PRAGMA user_version = 99');
  db.close();
  const versionLog: any[] = [];
  open(version, { log: (entry: any) => versionLog.push(entry) }).close();
  record(versionLog);

  // corrupted
  const corrupt = makeWorkspace('cause-corrupt');
  open(corrupt).close();
  resetCorruptionMemory(corrupt.databaseFile);
  writeFileSync(corrupt.databaseFile, 'garbage');
  const corruptLog: any[] = [];
  open(corrupt, { log: (entry: any) => corruptLog.push(entry) }).close();
  record(corruptLog);

  assert.deepEqual([...seen].sort(), [...NARRATIVE_INDEX_REBUILD_CAUSES].sort());
  assert.equal(durations.length, 3);
});

// --------------------------------------------------------------------------
// A second corruption in a row gives up
// --------------------------------------------------------------------------

test("a SECOND corruption in a row does not rebuild again — it fails with 'storage-corrupted'", () => {
  const workspace = makeWorkspace('corrupt-twice');
  resetCorruptionMemory(workspace.databaseFile);
  open(workspace).close();

  writeFileSync(workspace.databaseFile, 'garbage once');
  const first = open(workspace);
  assert.equal(first.lifecycle().corrupted, true, 'the first corruption was not seen');
  first.close();

  writeFileSync(workspace.databaseFile, 'garbage twice');
  const error = caught(() => open(workspace));
  assert.ok(error !== undefined, 'the second corruption rebuilt again instead of giving up');
  assert.equal((error as any).kind, 'storage-corrupted', `unexpected error: ${messageOf(error)}`);
  // And the file is STILL THERE: giving up must not be a silent deletion of the
  // evidence someone may want to look at.
  assert.equal(existsSync(workspace.databaseFile), true, 'the corrupt file was deleted on give-up');
  assert.equal(readFileSync(workspace.databaseFile, 'utf8'), 'garbage twice');
});

test('rejecting case: a store that forgot the previous corruption rebuilds forever', () => {
  // The pairing that stops "give up on the second" from being satisfied by
  // "give up always": after the memory is cleared, the SAME second corruption
  // is recovered from rather than refused.
  const workspace = makeWorkspace('corrupt-forgetful');
  resetCorruptionMemory(workspace.databaseFile);
  open(workspace).close();
  writeFileSync(workspace.databaseFile, 'garbage once');
  open(workspace).close();
  writeFileSync(workspace.databaseFile, 'garbage twice');
  resetCorruptionMemory(workspace.databaseFile);
  const store = open(workspace);
  assert.equal(store.lifecycle().corrupted, true);
  assert.equal(store.lifecycle().readOnly, false, 'a forgetful store should have rebuilt happily');
});

// --------------------------------------------------------------------------
// The adapter opens the file the CONFIG names
// --------------------------------------------------------------------------

test('the store opens the database at the path the configuration names, not a hard-coded one', () => {
  const workspace = makeWorkspace('config-path');
  const resolver = new NarrativeMemoryConfigResolver({
    env: {},
    readConfigFile: () => JSON.stringify({ databasePath: 'custom/dir/my-index.sqlite' })
  });
  const registry = new NarrativeIndexStoreRegistry({ resolver, heartbeatIntervalMs: 0 });
  // Against the CANONICAL root: on macOS `/var` is a symlink to `/private/var`,
  // and the registry keys by `realpath` on purpose — see ОВ-4 Б, where the
  // alternative is opening one file twice in one process.
  const expected = join(realpathSync(workspace.root), 'custom/dir/my-index.sqlite');
  assert.equal(registry.databaseFileFor(workspace.root), expected);

  registry.acquire(workspace.root);
  assert.equal(existsSync(expected), true, 'the configured path holds no database');
  // The rejecting half: the DEFAULT path must NOT have been created, or the
  // assertion above would pass for an implementation that ignored the config
  // and happened to create both.
  assert.equal(existsSync(workspace.databaseFile), false, 'the default path was created too');
  registry.closeAll();
});

after(() => {
  for (const store of opened.reverse()) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  disposeAll();
});
