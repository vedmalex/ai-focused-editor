/**
 * ISS-357: the read-only step-down caused by a foreign writer must be
 * REVERSIBLE, because its cause — a neighbour's live process — is temporary
 * by nature (TASK-022, HC-1 defect).
 *
 * Before this file, `readOnly`/`foreignWriter` were latched true once, in
 * `claimWriterLock()` or in `transaction()`'s compare-and-set loss, and never
 * reset. `resetForRebuild()`'s own live check (`isRebuildBlockedByForeignWriter`,
 * called AT CALL TIME on purpose) could find the lock gone and still hit the
 * very next line's `if (this.readOnly) throw` — two adjacent statements
 * disagreeing about the same fact. The status bar had the identical problem
 * from the other side: `lifecycle()` returned the latched flags forever, so a
 * neighbour closing cleanly (or crashing) never turned the yellow status bar
 * green, contradicting the documented promise that the lock "just expires,
 * nothing to do".
 *
 * These teeth exercise `SqliteNarrativeIndexStore.tryReclaimWriterRole()`
 * (private, reached only through `lifecycle()` and `resetForRebuild()`)
 * through its two public entry points, plus the module-level
 * `isLockRowReclaimable` discrimination it depends on.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { META_KEYS } from '../../lib/node/narrative-index-schema.js';
import { SqliteNarrativeIndexStore, isLockRowReclaimable } from '../../lib/node/sqlite-narrative-index-store.js';
import { caught, disposeAll, makeWorkspace, messageOf } from './harness.mts';

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

function chapter(relPath: string) {
  return { relPath, kind: 'chapter', sizeBytes: 1, mtimeMs: 1, contentHash: 'h', indexedAt: 1 };
}

function seed(store: any, relPath = 'manuscript/ch-01.md') {
  store.transaction((writer: any) => writer.putDocument(chapter(relPath)));
}

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
// Recovery path 1 — the neighbour closed politely (lock row deleted)
// --------------------------------------------------------------------------

test('reclaim: a polite close frees the row, and lifecycle() alone gets the writer role back', () => {
  const workspace = makeWorkspace('reclaim-clean-close');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);

  const log: any[] = [];
  const reader = open(workspace, { bootId: 'writer-two', log: (entry: any) => log.push(entry) });
  assert.equal(reader.lifecycle().readOnly, true, 'reader did not step down while the owner was alive');
  assert.equal(reader.lifecycle().foreignWriter, true);

  owner.close(); // the polite path: DELETEs the writer_* rows.
  assert.equal(readMeta(workspace.databaseFile, META_KEYS.writerBootId), undefined, 'the row survived a polite close');

  // The exact call the status-bar poll makes — nothing else, no explicit
  // "reclaim" action from the user.
  const lifecycle = reader.lifecycle();
  assert.equal(lifecycle.readOnly, false, 'the reader did not reclaim the writer role after a clean close');
  assert.equal(lifecycle.foreignWriter, false, 'the status bar would still report a foreign writer');
  assert.ok(
    log.some(entry => entry.event === 'writer-reclaimed'),
    `no writer-reclaimed log entry: ${JSON.stringify(log)}`
  );
  assert.equal(readMeta(workspace.databaseFile, META_KEYS.writerBootId), 'writer-two', 'the row was not re-claimed');

  // And the capability the whole bug is about: Rebuild, which was reachable
  // but threw before this fix even though the live check just passed.
  reader.resetForRebuild();
  assert.equal(reader.listDocuments().length, 0, 'reset did not run');
  seed(reader);
  assert.equal(reader.listDocuments().length, 1, 'the reclaimed instance could not write afterwards');
});

// --------------------------------------------------------------------------
// Recovery path 2 — the neighbour crashed (lock row survives, stale heartbeat)
// --------------------------------------------------------------------------

test('reclaim: an abandoned (stale) lock is taken over the same way — a DIFFERENT path from a clean close', () => {
  const workspace = makeWorkspace('reclaim-stale-lock');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);
  const reader = open(workspace, { bootId: 'writer-two' });
  assert.equal(reader.lifecycle().readOnly, true);

  // Simulate `kill -9`: the row survives, the heartbeat does not advance.
  withRawConnection(workspace.databaseFile, db =>
    db
      .prepare('UPDATE meta SET value = ? WHERE key = ?')
      .run(String(Date.now() - 40_000), META_KEYS.writerHeartbeatAt)
  );
  assert.equal(readMeta(workspace.databaseFile, META_KEYS.writerBootId), 'writer-one', 'the row was deleted, not staled');

  const lifecycle = reader.lifecycle();
  assert.equal(lifecycle.readOnly, false, 'a stale foreign lock was not reclaimed');
  assert.equal(lifecycle.foreignWriter, false);

  reader.resetForRebuild();
  assert.equal(reader.listDocuments().length, 0);
});

// --------------------------------------------------------------------------
// resetForRebuild() reclaims ON ITS OWN — not only because lifecycle() (the
// status-bar poll) happened to run first and already did it. This is the
// EXACT defect ISS-357 reported: the live check inside resetForRebuild()
// passed while the very next line still threw over a latched `readOnly`.
// --------------------------------------------------------------------------

test('reclaim: resetForRebuild() reclaims by itself, with no prior lifecycle() call', () => {
  const workspace = makeWorkspace('reclaim-resetforrebuild-standalone');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);
  const reader = open(workspace, { bootId: 'writer-two' });
  assert.equal(reader.lifecycle().readOnly, true);

  owner.close();

  // NO call to reader.lifecycle() here — resetForRebuild() is the ONLY
  // thing touched, exactly as a user clicking "Rebuild" the instant the
  // Rebuild command's own live availability check (a SEPARATE, already
  // correct code path — `NarrativeIndexStoreRegistry.rebuildBlockedByForeignWriter`)
  // reports available, without waiting for the next 5s status poll.
  reader.resetForRebuild();
  assert.equal(reader.listDocuments().length, 0, 'reset did not run');
  assert.equal(reader.lifecycle().readOnly, false, 'resetForRebuild left the instance read-only afterwards');
  seed(reader);
  assert.equal(reader.listDocuments().length, 1, 'the reclaimed instance could not write afterwards');
});

// --------------------------------------------------------------------------
// Refusal — the neighbour is genuinely alive
// --------------------------------------------------------------------------

test('reclaim: refuses while the neighbour is genuinely alive, even polled repeatedly', () => {
  const workspace = makeWorkspace('reclaim-refuse-live');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);
  const reader = open(workspace, { bootId: 'writer-two' });
  assert.equal(reader.lifecycle().readOnly, true);

  // heartbeatIntervalMs is 0 for both (no background timer) — refresh the
  // owner's heartbeat by hand, which is what a LIVE neighbour looks like from
  // the reader's side: the row is foreign and fresh.
  owner.heartbeat();

  for (let i = 0; i < 5; i += 1) {
    const lifecycle = reader.lifecycle();
    assert.equal(lifecycle.readOnly, true, `poll ${i}: the reader took the role from a live neighbour`);
    assert.equal(lifecycle.foreignWriter, true, `poll ${i}`);
  }
  const error = caught(() => reader.resetForRebuild());
  assert.ok(error !== undefined, 'a live neighbour did not block the rebuild');
  assert.equal((error as any).kind, 'rebuild-refused', `unexpected error: ${messageOf(error)}`);
});

// --------------------------------------------------------------------------
// Race — two readers try to reclaim at once; exactly one wins
// --------------------------------------------------------------------------

test('reclaim: two readers racing to reclaim resolve to exactly one winner, and the loser stays clean', () => {
  const workspace = makeWorkspace('reclaim-race');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);

  const reader1 = open(workspace, { bootId: 'writer-two' });
  assert.equal(reader1.lifecycle().readOnly, true);

  // A counting clock for reader2 that forces REAL interleaving into the
  // EXACT window `isLockRowReclaimable`'s in-transaction re-check exists to
  // close: the gap between reader2's own cheap check (call 1, sees the row
  // absent — reclaimable) and the moment it commits to the expensive path
  // (call 2). Right there, BEFORE reader2 opens a writable connection or
  // touches `BEGIN IMMEDIATE`, reader1 is driven to complete a FULL reclaim
  // (open, `BEGIN IMMEDIATE`, insert, commit, close). So by the time reader2
  // reaches its own `BEGIN IMMEDIATE`, the file is free again (reader1
  // already committed and closed) — no SQLite-level lock contention, only
  // the re-check inside reader2's transaction stands between it and
  // clobbering reader1's claim. `armed` excludes the one `now()` call
  // `claimWriterLock` already made at construction time, while the owner
  // was still alive.
  let armed = false;
  let calls = 0;
  const reader2 = open(workspace, {
    bootId: 'writer-three',
    now: () => {
      if (armed) {
        calls += 1;
        if (calls === 2) {
          reader1.lifecycle(); // reader1 claims the row to completion, right here
        }
      }
      return Date.now();
    }
  });
  assert.equal(reader2.lifecycle().readOnly, true, 'reader2 did not step down while the owner was alive');

  owner.close(); // both readers now see a reclaimable (absent) row
  armed = true;
  const afterRace = reader2.lifecycle();

  assert.equal(calls, 3, 'the interleaving seam did not fire the expected number of times — this test is not exercising the in-transaction re-check');
  assert.equal(reader1.lifecycle().readOnly, false, 'reader1 (the winner) did not get the writer role');
  assert.equal(reader1.lifecycle().foreignWriter, false);
  assert.equal(afterRace.readOnly, true, 'reader2 (the loser) incorrectly took the writer role too');
  assert.equal(afterRace.foreignWriter, true, 'reader2 lost the race but no longer reports a foreign writer');
  assert.equal(readMeta(workspace.databaseFile, META_KEYS.writerBootId), 'writer-two', 'the winner is not who committed first');

  // The loser must be CLEAN: no half-open write handle, reads still work
  // through the same connection it always had, and writing is still refused.
  assert.equal(reader2.listDocuments().length, 1, 'the losing reader can no longer read');
  const writeError = caught(() => reader2.transaction((writer: any) => writer.putDocument(chapter('manuscript/ch-03.md'))));
  assert.ok(writeError !== undefined, 'the loser was left able to write despite losing the race');
  assert.equal((writeError as any).kind, 'read-only');

  // And the winner can actually write.
  seed(reader1, 'manuscript/ch-02.md');
  assert.equal(reader1.listDocuments().length, 2);
});

// --------------------------------------------------------------------------
// The discriminator itself — the logic BOTH the cheap check and the
// in-transaction re-check share (isLockRowReclaimable), tested directly
// against all four lock-row states without needing two live processes.
// --------------------------------------------------------------------------

test('isLockRowReclaimable: no row at all is reclaimable', () => {
  const workspace = makeWorkspace('discriminator-absent');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);
  owner.close();
  withRawConnection(workspace.databaseFile, db => {
    assert.equal(isLockRowReclaimable(db, 'anyone', Date.now(), 30_000), true);
  });
});

test('isLockRowReclaimable: a live FOREIGN row is not reclaimable', () => {
  const workspace = makeWorkspace('discriminator-foreign-live');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);
  withRawConnection(workspace.databaseFile, db => {
    assert.equal(isLockRowReclaimable(db, 'writer-two', Date.now(), 30_000), false);
  });
});

test('isLockRowReclaimable: a STALE foreign row is reclaimable', () => {
  const workspace = makeWorkspace('discriminator-foreign-stale');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);
  withRawConnection(workspace.databaseFile, db =>
    db
      .prepare('UPDATE meta SET value = ? WHERE key = ?')
      .run(String(Date.now() - 40_000), META_KEYS.writerHeartbeatAt)
  );
  withRawConnection(workspace.databaseFile, db => {
    assert.equal(isLockRowReclaimable(db, 'writer-two', Date.now(), 30_000), true);
  });
});

test('isLockRowReclaimable: OUR OWN row (a CAS-loss step-down) is NOT reclaimable — this is the load-bearing distinction', () => {
  const workspace = makeWorkspace('discriminator-own');
  const owner = open(workspace, { bootId: 'writer-one' });
  seed(owner);
  withRawConnection(workspace.databaseFile, db => {
    // Same bootId as the row already in the file: "is this caller's own
    // claim", not "is anyone's claim gone". A function that answered this
    // the same as the absent case would let `tryReclaimWriterRole` silently
    // re-arm a role this instance was just told to give up.
    assert.equal(isLockRowReclaimable(db, 'writer-one', Date.now(), 30_000), false);
  });
});

// --------------------------------------------------------------------------
// Boundary — a CAS-loss step-down is NOT auto-healed by polling
// --------------------------------------------------------------------------

test('reclaim: a CAS-loss step-down (the row is still OUR OWN) is left alone by polling — explicit scope boundary', () => {
  const workspace = makeWorkspace('reclaim-cas-loss-boundary');
  const store = open(workspace, { bootId: 'writer-one' });
  seed(store);

  // A writer that ignored the lock bumps generation from underneath us.
  withRawConnection(workspace.databaseFile, db =>
    db.exec(`UPDATE meta SET value = value + 1 WHERE key = '${META_KEYS.generation}'`)
  );
  const error = caught(() => store.transaction((writer: any) => writer.putDocument(chapter('manuscript/ch-02.md'))));
  assert.ok(error !== undefined, 'the compare-and-set did not fire');
  assert.equal((error as any).kind, 'foreign-writer-detected');
  assert.equal(readMeta(workspace.databaseFile, META_KEYS.writerBootId), 'writer-one', 'the row is still OUR OWN');

  // Poll repeatedly, as the status bar would. If reclaim treated "the row is
  // absent from a FOREIGN point of view" the same as "the row is ours", this
  // would self-heal — which is exactly the two-writers-both-ready failure the
  // compare-and-set exists to prevent.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(
      store.lifecycle().readOnly,
      true,
      `poll ${i}: a CAS-loss step-down self-healed via polling, undoing the compare-and-set's safety net`
    );
  }
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
