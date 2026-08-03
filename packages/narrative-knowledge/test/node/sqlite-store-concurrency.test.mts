/**
 * The eight ОВ-4 teeth: multi-process access and several workspaces (TASK-022
 * WP-3).
 *
 * THE INVARIANT IS NOT ASSUMED, IT IS CHECKED. A cooperative lock that everyone
 * respects needs no test; the interesting cases are all the ones where somebody
 * does not — a stale build, a hand-edited row, a race between two claimants, a
 * `kill -9`. So every tooth below either breaks the cooperation on purpose or
 * asserts what happens after it was broken.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { META_KEYS } from '../../lib/node/narrative-index-schema.js';
import {
  SqliteNarrativeIndexStore,
  isRebuildBlockedByForeignWriter
} from '../../lib/node/sqlite-narrative-index-store.js';
import { NarrativeIndexStoreRegistry } from '../../lib/node/narrative-index-store-registry.js';
import { NarrativeMemoryConfigResolver } from '../../lib/node/narrative-memory-config-resolver.js';
import { caught, disposeAll, makeWorkspace, messageOf, must } from './harness.mts';

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

function seed(store: any, relPath = 'manuscript/ch-01.md') {
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

/** Reach into the file behind the adapter's back — which is exactly what a
 *  second, uncooperative writer would do. */
function withRawConnection<T>(databaseFile: string, body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

function readMeta(databaseFile: string, key: string): string | undefined {
  return withRawConnection(databaseFile, db => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as any;
    return row?.value;
  });
}

// --------------------------------------------------------------------------
// Tooth 1 — the second instance is read-only, and READS STILL WORK
// --------------------------------------------------------------------------

test('ОВ-4 tooth 1: a second instance on the same file is read-only and stale/foreign-writer, and reads', () => {
  const workspace = makeWorkspace('two-instances');
  const first = open(workspace, { bootId: 'writer-one' });
  seed(first);

  const log: any[] = [];
  const second = open(workspace, { bootId: 'writer-two', log: (entry: any) => log.push(entry) });
  const lifecycle = second.lifecycle();
  assert.equal(lifecycle.readOnly, true, 'the second instance took the writer role');
  assert.equal(lifecycle.foreignWriter, true, 'the read-only cause is not attributable to a foreign writer');
  assert.ok(
    log.some(entry => entry.event === 'read-only' && entry.reason === 'foreign-writer'),
    `the step-down was not logged: ${JSON.stringify(log)}`
  );

  // THIS IS THE FALSIFIER for the provenance claim that a read-only open of a
  // WAL database with a live foreign writer succeeds. If it did not, this line
  // would throw rather than return a row.
  assert.equal(second.listDocuments().length, 1, 'reading through the read-only instance failed');
  assert.equal(must(second.getDocument('manuscript/ch-01.md'), 'the chapter row').contentHash, 'h');
  assert.equal(second.lifecycle().generation, 1, 'the reader sees a different generation');
});

// --------------------------------------------------------------------------
// Tooth 2 — a write on the second instance is REFUSED, loudly
// --------------------------------------------------------------------------

test('ОВ-4 tooth 2: writing through the read-only instance is refused explicitly, never queued', () => {
  const workspace = makeWorkspace('refuse-write');
  open(workspace, { bootId: 'writer-one' });
  const second = open(workspace, { bootId: 'writer-two' });

  const error = caught(() => second.transaction((writer: any) => seed(writer)));
  assert.ok(error !== undefined, 'the write went through silently');
  assert.equal((error as any).kind, 'read-only', `unexpected error: ${messageOf(error)}`);
  // "Never queued" means exactly this: nothing appears later either.
  assert.equal(second.listDocuments().length, 0, 'the refused write landed anyway');
});

// --------------------------------------------------------------------------
// Tooth 3 — a stale lock is taken over
// --------------------------------------------------------------------------

test('ОВ-4 tooth 3: a heartbeat older than the liveness window is taken over', () => {
  const workspace = makeWorkspace('stale-lock');
  const first = open(workspace, { bootId: 'writer-one' });
  seed(first);
  // Simulate `kill -9`: the lock row survives, the heartbeat does not advance.
  // This is the recovery no lock FILE can offer — a file left behind by a
  // killed process is a lock nobody will ever release.
  withRawConnection(workspace.databaseFile, db =>
    db
      .prepare('UPDATE meta SET value = ? WHERE key = ?')
      .run(String(Date.now() - 40_000), META_KEYS.writerHeartbeatAt)
  );

  const second = open(workspace, { bootId: 'writer-two' });
  assert.equal(second.lifecycle().readOnly, false, 'the abandoned lock was not taken over');
  assert.equal(readMeta(workspace.databaseFile, META_KEYS.writerBootId), 'writer-two');
  second.transaction((writer: any) =>
    writer.putDocument({
      relPath: 'manuscript/ch-02.md',
      kind: 'chapter',
      sizeBytes: 1,
      mtimeMs: 1,
      contentHash: 'h',
      indexedAt: 1
    })
  );
  assert.equal(second.listDocuments().length, 2, 'the new writer could not write');
});

// --------------------------------------------------------------------------
// Tooth 4 — the compare-and-set catches a writer that ignored the lock
// --------------------------------------------------------------------------

test('ОВ-4 tooth 4 (rejecting): a foreign generation bump aborts the transaction and forces read-only', () => {
  const workspace = makeWorkspace('cas');
  const log: any[] = [];
  const store = open(workspace, { bootId: 'writer-one', log: (entry: any) => log.push(entry) });
  seed(store);
  assert.equal(store.lifecycle().generation, 1);

  // A writer that ignored the lock entirely — an old build, a repair script, a
  // lost takeover race. The compare-and-set is the ONLY thing standing between
  // this and two processes silently overwriting each other while both report
  // themselves ready.
  withRawConnection(workspace.databaseFile, db =>
    db.exec(`UPDATE meta SET value = value + 1 WHERE key = '${META_KEYS.generation}'`)
  );

  const error = caught(() =>
    store.transaction((writer: any) =>
      writer.putDocument({
        relPath: 'manuscript/ch-02.md',
        kind: 'chapter',
        sizeBytes: 1,
        mtimeMs: 1,
        contentHash: 'h',
        indexedAt: 1
      })
    )
  );
  assert.ok(error !== undefined, 'the compare-and-set did not fire');
  assert.equal((error as any).kind, 'foreign-writer-detected', `unexpected error: ${messageOf(error)}`);
  assert.equal(store.lifecycle().readOnly, true, 'the store kept writing after losing the compare-and-set');
  assert.equal(store.lifecycle().foreignWriter, true);
  assert.ok(
    log.some(entry => entry.event === 'foreign-writer-detected'),
    `the detection was not logged: ${JSON.stringify(log)}`
  );
  // The aborted transaction left nothing behind.
  assert.equal(store.getDocument('manuscript/ch-02.md'), undefined, 'the rolled-back write survived');
});

test('ОВ-4 tooth 4, paired positive: without a foreign bump the same write commits', () => {
  // Without this pairing, "always fail the second transaction" would satisfy
  // the tooth above.
  const workspace = makeWorkspace('cas-ok');
  const store = open(workspace, { bootId: 'writer-one' });
  seed(store);
  seed(store, 'manuscript/ch-02.md');
  assert.equal(store.lifecycle().generation, 2);
  assert.equal(store.lifecycle().readOnly, false);
});

// --------------------------------------------------------------------------
// Tooth 5 — canonicalization
// --------------------------------------------------------------------------

test('ОВ-4 tooth 5: two root spellings differing only by a trailing slash give ONE store', () => {
  const workspace = makeWorkspace('canonical');
  const resolver = new NarrativeMemoryConfigResolver({ env: {}, readConfigFile: () => undefined });
  const registry = new NarrativeIndexStoreRegistry({ resolver, heartbeatIntervalMs: 0 });
  const withoutSlash = registry.acquire(workspace.root);
  const withSlash = registry.acquire(`${workspace.root}/`);
  assert.equal(withSlash, withoutSlash, 'the same directory opened two stores');
  assert.equal(registry.openRoots().length, 1, 'the registry holds two entries for one directory');
  // And the consequence the canonicalization exists to prevent: a second store
  // on the same file WOULD have been read-only, i.e. the process would have
  // reported a foreign writer that was itself.
  assert.equal(withSlash.lifecycle().readOnly, false, 'the store went read-only against itself');
  registry.closeAll();
});

test('ОВ-4 tooth 5, via a file URI: the RPC spelling resolves to the same store', () => {
  const workspace = makeWorkspace('canonical-uri');
  const resolver = new NarrativeMemoryConfigResolver({ env: {}, readConfigFile: () => undefined });
  const registry = new NarrativeIndexStoreRegistry({ resolver, heartbeatIntervalMs: 0 });
  const byPath = registry.acquire(workspace.root);
  const byUri = registry.acquire(`file://${workspace.root}`);
  assert.equal(byUri, byPath);
  assert.equal(registry.openRoots().length, 1);
  registry.closeAll();
});

// --------------------------------------------------------------------------
// Tooth 6 — the LRU bound, and the lock it frees
// --------------------------------------------------------------------------

test('ОВ-4 tooth 6: opening one workspace past the bound closes the oldest and frees its lock', () => {
  const roots = [0, 1, 2].map(index => makeWorkspace(`lru-${index}`));
  const resolver = new NarrativeMemoryConfigResolver({
    env: {},
    readConfigFile: () => JSON.stringify({ maxOpenWorkspaces: 2 })
  });
  const registry = new NarrativeIndexStoreRegistry({ resolver, heartbeatIntervalMs: 0 });

  registry.acquire(roots[0].root);
  registry.acquire(roots[1].root);
  assert.equal(registry.openRoots().length, 2);
  assert.equal(readMeta(roots[0].databaseFile, META_KEYS.writerBootId) !== undefined, true);

  registry.acquire(roots[2].root);
  assert.equal(registry.openRoots().length, 2, 'the bound was not enforced');
  assert.equal(registry.isOpen(roots[0].root), false, 'the least recent workspace stayed open');

  // The lock row is GONE, not merely expired: an evicted workspace whose lock
  // nobody refreshes would leave the next process read-only for the whole
  // liveness window.
  assert.equal(
    readMeta(roots[0].databaseFile, META_KEYS.writerBootId),
    undefined,
    'the evicted store left its writer lock behind'
  );
  // And it can be re-acquired as a WRITER immediately.
  const reopened = registry.acquire(roots[0].root);
  assert.equal(reopened.lifecycle().readOnly, false, 'the re-opened workspace is read-only');
  registry.closeAll();
});

test('ОВ-4 tooth 6, paired: a recently used root is NOT the one evicted', () => {
  // Without this, "always evict the first key" and "evict at random" both pass.
  const roots = [0, 1, 2].map(index => makeWorkspace(`lru-order-${index}`));
  const resolver = new NarrativeMemoryConfigResolver({
    env: {},
    readConfigFile: () => JSON.stringify({ maxOpenWorkspaces: 2 })
  });
  const registry = new NarrativeIndexStoreRegistry({ resolver, heartbeatIntervalMs: 0 });
  registry.acquire(roots[0].root);
  registry.acquire(roots[1].root);
  registry.acquire(roots[0].root); // touch 0, making 1 the least recent
  registry.acquire(roots[2].root);
  assert.equal(registry.isOpen(roots[0].root), true, 'the recently touched root was evicted');
  assert.equal(registry.isOpen(roots[1].root), false, 'the least recent root survived');
  registry.closeAll();
});

// --------------------------------------------------------------------------
// Tooth 7 — a FAILED read-only open does not retry and does not rebuild
// --------------------------------------------------------------------------

test('ОВ-4 tooth 7 (ISS-314): if even the read-only open fails, it fails — no retry, no rebuild', () => {
  const workspace = makeWorkspace('unreadable');
  const first = open(workspace, { bootId: 'writer-one' });
  seed(first);
  const before = readFileSync(workspace.databaseFile);

  // Make the file unopenable while the lock is held. `chmod 000` is the honest
  // reproduction of the field cases (permissions, a network mount, a damaged
  // `-wal`); it is restored in the same test so the temp cleanup can run.
  chmodSync(workspace.databaseFile, 0o000);
  let error: unknown;
  try {
    error = caught(() =>
      new SqliteNarrativeIndexStore({
        databaseFile: workspace.databaseFile,
        workspaceRoot: workspace.root,
        bootId: 'writer-two',
        heartbeatIntervalMs: 0
      })
    );
  } finally {
    chmodSync(workspace.databaseFile, 0o600);
  }

  assert.ok(error !== undefined, 'an unreadable database opened successfully');
  assert.equal((error as any).kind, 'storage-unavailable', `unexpected error: ${messageOf(error)}`);
  // THE LOAD-BEARING ASSERTION. A rebuild is a WRITE, and we have just
  // established the file belongs to someone else — rebuilding would delete
  // their work. An implementation that "helpfully" recovered here, or that
  // spun in a retry loop, must fail this test.
  assert.equal(existsSync(workspace.databaseFile), true, 'the failing open deleted the database');
  assert.deepEqual(
    readFileSync(workspace.databaseFile),
    before,
    'the database was rewritten by a path that was supposed to give up'
  );
});

// --------------------------------------------------------------------------
// Tooth 8 — Rebuild is refused BY OWNERSHIP, not by state
// --------------------------------------------------------------------------

test('ОВ-4 tooth 8: with a LIVE foreign lock, a rebuild is refused and the file is untouched', () => {
  const workspace = makeWorkspace('rebuild-blocked');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);
  const generationBefore = readMeta(workspace.databaseFile, META_KEYS.generation);

  assert.equal(
    isRebuildBlockedByForeignWriter(workspace.databaseFile, { now: Date.now(), bootId: 'someone-else' }),
    true,
    'a live foreign lock did not block the rebuild'
  );

  const reader = open(workspace, { bootId: 'writer-two' });
  const error = caught(() => reader.resetForRebuild());
  assert.ok(error !== undefined, 'the rebuild went ahead over a live foreign lock');
  assert.equal((error as any).kind, 'rebuild-refused', `unexpected error: ${messageOf(error)}`);
  assert.equal(existsSync(workspace.databaseFile), true, 'the refused rebuild deleted the database anyway');
  assert.equal(
    readMeta(workspace.databaseFile, META_KEYS.generation),
    generationBefore,
    'the refused rebuild moved the generation'
  );
});

test('ОВ-4 tooth 8, rejecting case (a): the refusal is by OWNERSHIP, so a live lock blocks even a `failed` store', () => {
  // The rule is stated over the LOCK, never over the state that lock produced.
  // Whatever state the caller believes it is in — `stale/foreign-writer`,
  // `failed/storage-unavailable`, or something invented later — the answer at
  // call time is the same, and this call has no state to consult at all.
  const workspace = makeWorkspace('rebuild-ownership');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);
  assert.equal(
    isRebuildBlockedByForeignWriter(workspace.databaseFile, { now: Date.now(), bootId: 'any-other-process' }),
    true
  );
});

test('ОВ-4 tooth 8, rejecting case (b): a STALE lock does NOT block — "refuse always" must fail here', () => {
  const workspace = makeWorkspace('rebuild-stale-lock');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);
  withRawConnection(workspace.databaseFile, db =>
    db
      .prepare('UPDATE meta SET value = ? WHERE key = ?')
      .run(String(Date.now() - 40_000), META_KEYS.writerHeartbeatAt)
  );
  assert.equal(
    isRebuildBlockedByForeignWriter(workspace.databaseFile, { now: Date.now(), bootId: 'writer-two' }),
    false,
    'an expired lock still blocked the rebuild — "refuse always" would pass the live-lock test'
  );

  // And the rebuild really goes through afterwards.
  const taker = open(workspace, { bootId: 'writer-two' });
  taker.resetForRebuild();
  assert.equal(taker.listDocuments().length, 0, 'the rebuild did not empty the store');
  assert.equal(taker.lifecycle().readOnly, false);
});

test('ОВ-4 tooth 8: a missing or unreadable database does not count as owned', () => {
  // Refusing here would make an unreadable file permanently unrepairable — the
  // one situation where the user most needs the Rebuild button to work.
  const workspace = makeWorkspace('rebuild-missing');
  assert.equal(
    isRebuildBlockedByForeignWriter(workspace.databaseFile, { now: Date.now(), bootId: 'anyone' }),
    false
  );
  mkdirSync(join(workspace.root, '.theia'), { recursive: true });
  writeFileSync(workspace.databaseFile, 'not a database');
  assert.equal(
    isRebuildBlockedByForeignWriter(workspace.databaseFile, { now: Date.now(), bootId: 'anyone' }),
    false
  );
  rmSync(workspace.databaseFile, { force: true });
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
