/**
 * The maintainer really RUNS in a live service (TASK-022 ISS-359).
 *
 * WHY THIS FILE EXISTS. `NarrativeIndexMaintainer` owns the watcher
 * subscription, the debounce window and the fallback sweep, and every one of
 * those behaviours already had thorough coverage in
 * `narrative-index-maintenance-contract.ts` — run against a maintainer built
 * BY HAND, with its own session, its own `TestNarrativeFileWatcher` and its own
 * `start()` call. What NOTHING tested is whether `NodeNarrativeKnowledgeService`
 * — the thing an actual running backend constructs — ever calls any of that.
 * It did not: `maintainer(rootPath)` had exactly one caller, `updateDocument`,
 * and nothing in a real application ever calls `updateDocument`. The watcher
 * factory the backend module wires up (`narrative-knowledge-backend-module.ts`)
 * sat unused for the whole life of TASK-022's WP-4b, and the round-trip and
 * rebuild smokes never noticed because they always call `rebuild()` explicitly.
 *
 * THIS FILE IS THE SERVICE-LEVEL COUNTERPART OF THAT GAP. It builds
 * `NodeNarrativeKnowledgeService` the way `rebuild-availability.test.mts`
 * already does — by field assignment, no DI container — and asserts what a
 * caller that only ever asks `getIndexStatus()` (the frontend's five-second
 * poll, `narrative-memory-contribution.ts`) actually starts.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestNarrativeFileWatcher } from '../../lib/common/index.js';
import { NarrativeIndexStoreRegistry } from '../../lib/node/narrative-index-store-registry.js';
import { NodeNarrativeKnowledgeService } from '../../lib/node/node-narrative-knowledge-service.js';
import { NarrativeMemoryConfigResolver } from '../../lib/node/narrative-memory-config-resolver.js';
import { disposeAll, makeWorkspace } from './harness.mts';

after(() => {
  disposeAll();
});

/**
 * A workspace that really is a manuscript, with one chapter already on disk —
 * otherwise the service short-circuits before ever touching a maintainer.
 *
 * `canonicalRoot` IS SEPARATE FROM `root` ON PURPOSE. Every observable side
 * effect this file asserts (`createWatcher(rootPath)`'s argument, the
 * `maintainers`/`sessions` map keys) is keyed by `canonicalWorkspaceKey()` —
 * `realpath`, not the raw `mkdtemp` path — and on macOS `/tmp` is itself a
 * symlink into `/private/tmp`, so the two differ for every temp workspace this
 * harness creates. Calling the service with `root` (as a real RPC caller
 * would, with an uncanonicalized URI) while asserting against `canonicalRoot`
 * is what makes this file test the SAME canonicalization the product does,
 * rather than assuming the two paths already match.
 */
function manuscriptWorkspace(name: string, chapterText = 'Chapter one.\n') {
  const workspace = makeWorkspace(name);
  writeFileSync(join(workspace.root, 'manifest.yaml'), 'chapters: []\n', 'utf8');
  mkdirSync(join(workspace.root, 'content'), { recursive: true });
  writeFileSync(join(workspace.root, 'content', 'ch-01.md'), chapterText, 'utf8');
  return { ...workspace, canonicalRoot: realpathSync(workspace.root) };
}

/**
 * A service wired the way `NodeNarrativeKnowledgeService` documents itself as
 * needing: field-injected `registry`/`resolver` (the DI-free shape
 * `rebuild-availability.test.mts` already established), plus a spy in place of
 * the backend module's real `createWatcher` so this file can see how many
 * watchers get built, for which roots, and whether they were ever disposed —
 * WITHOUT a Theia container or a real filesystem watcher.
 */
function serviceFor(options: { maxOpenWorkspaces?: number } = {}) {
  const resolver = new NarrativeMemoryConfigResolver();
  if (options.maxOpenWorkspaces !== undefined) {
    resolver.setRuntimeOverrides({ maxOpenWorkspaces: options.maxOpenWorkspaces });
  }
  const registry = new NarrativeIndexStoreRegistry({ resolver });
  const service = new NodeNarrativeKnowledgeService();
  // Field injection is what the class is built with in production (inversify
  // `@inject`); a test container here would add a DI dependency to prove
  // nothing this file is about.
  (service as any).registry = registry;
  (service as any).resolver = resolver;
  const watchersByRoot = new Map<string, InstanceType<typeof TestNarrativeFileWatcher>>();
  const createWatcherCalls: string[] = [];
  service.createWatcher = (rootPath: string) => {
    createWatcherCalls.push(rootPath);
    const watcher = new TestNarrativeFileWatcher();
    watchersByRoot.set(rootPath, watcher);
    return watcher as any;
  };
  return { service, registry, resolver, watchersByRoot, createWatcherCalls };
}

test('ISS-359 trap 4: getIndexStatus() on a manuscript starts exactly ONE maintainer, ONE watcher', async () => {
  const workspace = manuscriptWorkspace('maintainer-wiring-single');
  const { service, createWatcherCalls } = serviceFor();

  // The frontend's own entry point (`narrative-memory-contribution.ts`
  // `refresh()`), called the way it is at frontend start AND on every one of
  // its five-second polls.
  await service.getIndexStatus(workspace.root);
  await service.getIndexStatus(workspace.root);
  await service.getIndexStatus(workspace.root);

  assert.deepEqual(
    createWatcherCalls,
    [workspace.canonicalRoot],
    'the watcher factory must be called exactly once for a root touched repeatedly, not once per poll'
  );
});

test('ISS-359 trap 1: a workspace with no manifest.yaml never starts a maintainer', async () => {
  const workspace = makeWorkspace('maintainer-wiring-no-manuscript');
  const { service, createWatcherCalls } = serviceFor();

  await service.getIndexStatus(workspace.root);
  await service.getEntityTypeRegistry(workspace.root);
  await service.listDocuments(workspace.root);

  assert.deepEqual(
    createWatcherCalls,
    [],
    'a non-manuscript folder must get neither a database nor a live filesystem watcher'
  );
});

test('two different manuscript roots each get their own maintainer and their own watcher', async () => {
  const workspaceA = manuscriptWorkspace('maintainer-wiring-multi-a');
  const workspaceB = manuscriptWorkspace('maintainer-wiring-multi-b');
  const { service, createWatcherCalls } = serviceFor();

  await service.getIndexStatus(workspaceA.root);
  await service.getIndexStatus(workspaceB.root);
  await service.getIndexStatus(workspaceA.root);

  assert.deepEqual(
    [...createWatcherCalls].sort(),
    [workspaceA.canonicalRoot, workspaceB.canonicalRoot].sort(),
    'each root gets exactly one watcher, independent of the other'
  );
});

test('ISS-359 trap 4: dispose() stops every maintainer AND disposes its watcher', async () => {
  const workspace = manuscriptWorkspace('maintainer-wiring-dispose');
  const { service, watchersByRoot } = serviceFor();

  await service.getIndexStatus(workspace.root);
  const watcher = watchersByRoot.get(workspace.canonicalRoot);
  assert.ok(watcher, 'a watcher must have been built for the manuscript root');
  assert.equal(watcher!.isDisposed, false);

  service.dispose();

  assert.equal(
    watcher!.isDisposed,
    true,
    "stop() must dispose the watcher itself, not merely remove its listeners " +
      '(the subscriptions array only holds onDidChangeFiles/onDidFail removal, ' +
      'never the watcher’s own dispose())'
  );
});

test('ISS-359 trap 3: an evicted workspace (maxOpenWorkspaces) stops its maintainer and disposes its watcher', async () => {
  const workspaceA = manuscriptWorkspace('maintainer-wiring-evict-a');
  const workspaceB = manuscriptWorkspace('maintainer-wiring-evict-b');
  const { service, registry, watchersByRoot } = serviceFor({ maxOpenWorkspaces: 1 });

  await service.getIndexStatus(workspaceA.root);
  const watcherA = watchersByRoot.get(workspaceA.canonicalRoot);
  assert.ok(watcherA, 'root A must have started a maintainer/watcher');
  assert.equal(watcherA!.isDisposed, false);
  assert.equal(registry.isOpen(workspaceA.root), true);

  // Touching root B pushes the registry's LRU (bound to 1) past its limit,
  // which closes root A's store synchronously inside `registry.acquire()`.
  await service.getIndexStatus(workspaceB.root);

  assert.equal(registry.isOpen(workspaceA.root), false, 'the registry must have evicted root A, not root B');
  assert.equal(registry.isOpen(workspaceB.root), true);
  // At most ONE store open at a time — the setting is respected, not merely
  // consulted.
  assert.equal(registry.openRoots().length, 1);

  assert.equal(
    watcherA!.isDisposed,
    true,
    'the evicted root’s maintainer must be stopped (and its watcher disposed) — ' +
      'a maintainer left running against a CLOSED store would throw on every future ' +
      'file change and leak a live filesystem watcher forever'
  );

  // And root A is not permanently broken: touching it again reopens a fresh
  // store and starts a fresh maintainer, exactly like a first-ever open.
  await service.getIndexStatus(workspaceA.root);
  assert.equal(registry.isOpen(workspaceA.root), true);
});

test('rebuild() now runs through the maintainer’s own guard and still reaches ready with real data', async () => {
  const workspace = manuscriptWorkspace('maintainer-wiring-rebuild', 'Hello, manuscript.\n');
  const { service } = serviceFor();

  const before = await service.getIndexStatus(workspace.root);
  const envelope = await service.rebuild(workspace.root);

  assert.equal(envelope.state.state, 'ready');
  assert.ok(
    envelope.state.generation > (before.generation ?? -1),
    'generation must strictly advance — this call, not a leftover, produced the state'
  );
  // `manifest.yaml` itself is an indexable document alongside the one
  // chapter — see `documentsIndexed: indexable.length` in
  // `narrative-index-session.ts`.
  assert.equal(envelope.data.documentsIndexed, 2);
});

test('ISS-359 trap 5a: debounceMs really delays a watcher-driven update, sourced from live config', async () => {
  const workspace = manuscriptWorkspace('maintainer-wiring-debounce', 'Hello, manuscript.\n');
  const { service, resolver, watchersByRoot } = serviceFor();
  // Keyed by the CANONICAL root: the resolver is asked with the canonical
  // path (`maintainer()`'s own `canonicalWorkspaceKey(rootUriOrPath)`), and a
  // per-root override stored under the raw path would silently never match —
  // see `manuscriptWorkspace`'s doc comment.
  resolver.setRuntimeOverrides({ debounceMs: 150 }, workspace.canonicalRoot);

  await service.rebuild(workspace.root); // establish a real baseline index
  const watcher = watchersByRoot.get(workspace.canonicalRoot);
  assert.ok(watcher, 'a watcher must exist once the workspace has been touched');

  writeFileSync(join(workspace.root, 'content', 'ch-01.md'), 'Hello, EDITED manuscript.\n', 'utf8');
  watcher!.push({ path: 'content/ch-01.md', type: 'updated' });

  // Immediately after the event: the debounce window has not closed yet, so
  // the store must still hold the OLD bytes.
  const immediately = await service.listDocuments(workspace.root);
  const immediateDoc = immediately.data.find(doc => doc.relPath === 'content/ch-01.md');
  assert.ok(immediateDoc);
  assert.equal(
    immediateDoc!.sizeBytes,
    'Hello, manuscript.\n'.length,
    'a debounced change must not have landed yet — if it has, debounceMs is not being read at all'
  );

  // After the configured window (plus slack for real-timer scheduling): the
  // edit must have landed.
  const deadline = Date.now() + 5000;
  let settled;
  while (Date.now() < deadline) {
    const after2 = await service.listDocuments(workspace.root);
    settled = after2.data.find(doc => doc.relPath === 'content/ch-01.md');
    if (settled && settled.sizeBytes === 'Hello, EDITED manuscript.\n'.length) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(
    settled?.sizeBytes,
    'Hello, EDITED manuscript.\n'.length,
    'the debounced edit must have landed within a few debounce windows of real time'
  );
});

test('ISS-359 trap 5b: fallbackTtlMs really drives a live sweep with no watcher wired at all', async () => {
  const workspace = manuscriptWorkspace('maintainer-wiring-ttl-sweep');
  const resolver = new NarrativeMemoryConfigResolver();
  // Canonical root — see `manuscriptWorkspace`'s doc comment.
  resolver.setRuntimeOverrides({ fallbackTtlMs: 150 }, workspace.canonicalRoot);
  const registry = new NarrativeIndexStoreRegistry({ resolver });
  const service = new NodeNarrativeKnowledgeService();
  (service as any).registry = registry;
  (service as any).resolver = resolver;
  // `createWatcher` DELIBERATELY LEFT UNSET — the headless mode the service's
  // own doc comment blesses ("the index still works ... it simply has no live
  // events and depends on the fallback sweep"). Everything below can therefore
  // only have moved via the TTL sweep, sourced from live `resolver` config.

  await service.rebuild(workspace.root); // baseline: manifest.yaml + one chapter

  // A file added ENTIRELY OUTSIDE any watcher's knowledge.
  writeFileSync(join(workspace.root, 'content', 'ch-02.md'), 'A second chapter.\n', 'utf8');

  const before = await service.listDocuments(workspace.root);
  assert.equal(before.data.length, 2, 'the new file must not be indexed yet');

  const deadline = Date.now() + 5000;
  let documents = before.data;
  while (Date.now() < deadline && documents.length < 3) {
    await new Promise(resolve => setTimeout(resolve, 25));
    documents = (await service.listDocuments(workspace.root)).data;
  }
  assert.equal(
    documents.length,
    3,
    'the fallback sweep must have picked up the new file within a few TTL windows of real time — ' +
      'if fallbackTtlMs is not really wired, this never happens at all'
  );
});
