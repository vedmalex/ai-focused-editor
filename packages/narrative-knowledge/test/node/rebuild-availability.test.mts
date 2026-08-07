/**
 * Where the "is Rebuild refused" boolean comes from (TASK-022 WP-5, ОВ-4 /
 * ISS-321).
 *
 * THE OTHER HALF OF ОВ-4 TOOTH 8. The bun-lane suite
 * (`narrative-memory-presentation.test.ts`) asserts what the two commands look
 * like GIVEN the boolean, and holds `stale`/`failed` constant while only the
 * lock moves, so a state-keyed implementation cannot pass it. That is a
 * complete test of the presentation and no test at all of the ANSWER: it hands
 * itself the boolean. This file is where the boolean is produced, and it needs
 * a real database file with a real lock row in it — `bun` cannot resolve
 * `node:sqlite`, so it has to live here.
 *
 * The pair the plan asks for is the point: a LIVE foreign lock refuses, an
 * EXPIRED one does not. Without the second half, "always refuse" would pass.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { META_KEYS } from '../../lib/node/narrative-index-schema.js';
import { SqliteNarrativeIndexStore } from '../../lib/node/sqlite-narrative-index-store.js';
import { NarrativeIndexStoreRegistry } from '../../lib/node/narrative-index-store-registry.js';
import { NodeNarrativeKnowledgeService } from '../../lib/node/node-narrative-knowledge-service.js';
import { NarrativeMemoryConfigResolver } from '../../lib/node/narrative-memory-config-resolver.js';
import { disposeAll, makeWorkspace } from './harness.mts';

const opened: { close(): void }[] = [];

after(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  disposeAll();
});

/** A workspace that really is a manuscript — otherwise the service short-circuits. */
function manuscriptWorkspace() {
  const workspace = makeWorkspace('rebuild-availability');
  writeFileSync(join(workspace.root, 'manifest.yaml'), 'chapters: []\n', 'utf8');
  mkdirSync(join(workspace.root, '.theia'), { recursive: true });
  return workspace;
}

/**
 * Create the database and leave a LIVE writer lock in it owned by `bootId`.
 *
 * THE STORE IS LEFT OPEN, and that is not laziness — it is what "live" means.
 * `close()` DELETES the four lock rows so a politely departing writer does not
 * make the next one wait out the liveness window, so a seed that closed would
 * leave a file with no lock at all and every refusal case below would go green
 * for the wrong reason. Writing the rows by hand would test the reader against
 * a fixture instead of against the writer.
 */
function seedForeignLock(databaseFile: string, workspaceRoot: string, bootId: string): void {
  const store = new SqliteNarrativeIndexStore({
    databaseFile,
    workspaceRoot,
    bootId,
    heartbeatIntervalMs: 0
  });
  opened.push(store);
  // A committed write, so the file has a schema, a generation and a lock row —
  // the state a real second backend is sitting in.
  store.transaction((writer: any) =>
    writer.putDocument({
      relPath: 'content/ch-01.md',
      kind: 'chapter',
      sizeBytes: 1,
      mtimeMs: 1,
      contentHash: 'h',
      indexedAt: 1
    })
  );
}

/** Rewrite the heartbeat so the lock looks `ageMs` old. */
function ageLock(databaseFile: string, ageMs: number): void {
  const db = new DatabaseSync(databaseFile);
  try {
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      String(Date.now() - ageMs),
      META_KEYS.writerHeartbeatAt
    );
  } finally {
    db.close();
  }
}

function serviceFor(workspace: { root: string }) {
  const resolver = new NarrativeMemoryConfigResolver();
  const registry = new NarrativeIndexStoreRegistry({ resolver });
  const service = new NodeNarrativeKnowledgeService();
  // Field injection is what the class is built with, so a test container would
  // add a DI dependency to prove nothing this file is about.
  (service as any).registry = registry;
  (service as any).resolver = resolver;
  return { service, registry };
}

test('a LIVE foreign lock refuses Rebuild — and the database file survives the question', async () => {
  const workspace = manuscriptWorkspace();
  seedForeignLock(workspace.databaseFile, workspace.root, 'someone-else');
  const { service } = serviceFor(workspace);

  const answer = await service.getRebuildAvailability(workspace.root);
  assert.equal(answer.available, false);
  assert.equal(answer.reason, 'foreign-writer');

  // ASKING MUST NOT WRITE. The question is asked in exactly the situation where
  // writing is forbidden, so an implementation that opened the store to answer
  // it would CLAIM the writer lock — the very act it is checking permission
  // for.
  assert.ok(existsSync(workspace.databaseFile));
  const db = new DatabaseSync(workspace.databaseFile);
  try {
    const owner = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEYS.writerBootId) as
      | { value?: string }
      | undefined;
    assert.equal(owner?.value, 'someone-else');
  } finally {
    db.close();
  }
});

test('an EXPIRED foreign lock does NOT refuse — "always refuse" must not pass', async () => {
  const workspace = manuscriptWorkspace();
  seedForeignLock(workspace.databaseFile, workspace.root, 'someone-else');
  // Older than the 30-second staleness window, which is the takeover rule a
  // lock FILE cannot give after `kill -9`.
  ageLock(workspace.databaseFile, 40_000);
  const { service } = serviceFor(workspace);

  const answer = await service.getRebuildAvailability(workspace.root);
  assert.equal(answer.available, true);
  assert.equal(answer.reason, undefined);
});

test('OUR OWN lock is not foreign — a rebuild is not refused because we hold the file', async () => {
  const workspace = manuscriptWorkspace();
  const { service, registry } = serviceFor(workspace);
  // Open through the REGISTRY, so the lock is written with the boot id the
  // registry recorded. Without that record every check would compare against a
  // fresh id, call our own lock foreign, and refuse a rebuild the user is
  // entitled to — with no way for a test that only ever looks at foreign locks
  // to notice.
  const store = registry.acquire(workspace.root);
  opened.push(store as any);
  (store as any).transaction((writer: any) =>
    writer.putDocument({
      relPath: 'content/ch-01.md',
      kind: 'chapter',
      sizeBytes: 1,
      mtimeMs: 1,
      contentHash: 'h',
      indexedAt: 1
    })
  );

  assert.equal(registry.rebuildBlockedByForeignWriter(workspace.root), false);
  assert.equal((await service.getRebuildAvailability(workspace.root)).available, true);
});

test('a workspace with no database yet is available — there is nothing to protect', async () => {
  const workspace = manuscriptWorkspace();
  const { service } = serviceFor(workspace);
  assert.equal(existsSync(workspace.databaseFile), false);
  assert.equal((await service.getRebuildAvailability(workspace.root)).available, true);
  // And asking did not create one.
  assert.equal(existsSync(workspace.databaseFile), false);
});

test('the refusal really is BY OWNERSHIP: the same live lock refuses whatever state it caused', async () => {
  // ОВ-4 words the rule "НЕЗАВИСИМО от того, какое состояние это породило". A
  // live foreign lock produces `stale/foreign-writer` when the file opens
  // read-only; the ANSWER here must not depend on that having happened, which
  // is why it is asked of the FILE and not of a session.
  const workspace = manuscriptWorkspace();
  seedForeignLock(workspace.databaseFile, workspace.root, 'someone-else');
  const { service, registry } = serviceFor(workspace);

  // Before any store of ours exists.
  assert.equal(registry.rebuildBlockedByForeignWriter(workspace.root), true);

  // And after one has been opened read-only against the same file.
  const store = registry.acquire(workspace.root);
  opened.push(store as any);
  assert.equal((store as any).lifecycle().foreignWriter, true);
  assert.equal((await service.getRebuildAvailability(workspace.root)).available, false);
});

test('a live lock in a folder that is NOT a manuscript answers "available"', async () => {
  // Ownership and "there is nothing here to index" are two different questions
  // with two different homes: this one is about the lock, and
  // `absent`/`no-manuscript` already lives in `IndexState`. Answering
  // "unavailable" here would give one condition two homes and let them
  // disagree — and the frontend hides both commands on that row anyway.
  const workspace = makeWorkspace('rebuild-availability-nomanifest');
  mkdirSync(join(workspace.root, '.theia'), { recursive: true });
  seedForeignLock(workspace.databaseFile, workspace.root, 'someone-else');
  const { service } = serviceFor(workspace);
  assert.equal((await service.getRebuildAvailability(workspace.root)).available, true);
});
