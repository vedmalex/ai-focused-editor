/**
 * ISS-361 (gh#71) — a background sweep that fails must not fail SILENTLY.
 *
 * WHY THIS FILE SITS OUTSIDE THE MAINTENANCE CONTRACT. The paired case needs a
 * store that is populated AND read-only. The shared contract is adapter-neutral
 * and takes its store from `makeHarness`, so pinning that there would mean
 * importing a specific adapter into the adapter-neutral file.
 *
 * WHAT gh#71 IS ACTUALLY ABOUT, HAVING CHECKED. Its second proposed remedy —
 * "or the state is visible in the status bar" — is ALREADY satisfied, with
 * teeth elsewhere: `assembleIndexState` derives `stale`/`foreign-writer`
 * straight from `lifecycle().readOnly` (`index-state-assembly.test.ts`) and the
 * status bar renders it as "another process owns the index, so this window is
 * read-only" (`narrative-memory-presentation.test.ts`). What was genuinely
 * missing is the ASYMMETRY these two cases pin: a watcher-driven pass that
 * rejects records a failure, while a sweep that rejected swallowed it whole.
 */

import { describe, expect, test } from 'bun:test';
import { InMemoryNarrativeIndexStore } from './in-memory-narrative-index-store';
import type { NarrativeIndexStoreLifecycle } from './graph';
import { InMemoryConfigStore, NarrativeMemoryConfigurator } from './narrative-memory-configure';
import { NarrativeIndexSession, type IndexableFile } from './narrative-index-session';
import { NarrativeIndexMaintainer } from './narrative-index-maintainer';
import { TestNarrativeFileWatcher } from './narrative-file-watcher';
import { ManualTimerScheduler } from './narrative-timer';
import { InMemoryWorkspaceSource } from './narrative-workspace-source';

const ROOT = '/workspace/book';
const SCHEMA_VERSION = 3;
const NOW = 1_700_000_500_000;

function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function file(path: string, text: string): IndexableFile {
  return {
    path,
    uri: `file:///workspace/${path}`,
    text,
    sizeBytes: text.length,
    mtimeMs: 1_700_000_000_000,
    contentHash: textHash(text)
  };
}

function manuscript(): IndexableFile[] {
  return [
    file('manifest.yaml', 'content:\n  - path: content/ch-01.md\n    title: One'),
    file('content/ch-01.md', 'Prose about [[char:krishna|Кришна]].')
  ];
}

/**
 * A store that can LOSE the writer role after it was populated — which is what
 * the real SQLite adapter does when a compare-and-set is lost mid-session
 * (`NarrativeIndexSession.state`'s own doc says `readOnly` can flip that way).
 * The in-memory adapter only takes `readOnly` at construction, and a store that
 * was read-only from birth is EMPTY, hence `absent/not-built` — which would
 * never reach the `foreign-writer` branch this case is about.
 */
class LoseableWriterStore extends InMemoryNarrativeIndexStore {
  foreignLocked = false;

  override lifecycle(): NarrativeIndexStoreLifecycle {
    const base = super.lifecycle();
    return this.foreignLocked ? { ...base, readOnly: true } : base;
  }
}

/**
 * A source whose `stat()` throws on demand — the cheapest way to make a sweep
 * reject for a reason that is NOT a lock, i.e. exactly the case that used to
 * vanish without trace.
 */
class FailingStatSource extends InMemoryWorkspaceSource {
  failStat = false;

  override async stat(): ReturnType<InMemoryWorkspaceSource['stat']> {
    if (this.failStat) {
      throw new Error('stat failed');
    }
    return super.stat();
  }
}

async function buildStack() {
  const store = new LoseableWriterStore();
  const configStore = new InMemoryConfigStore();
  const source = new FailingStatSource(manuscript());
  const scheduler = new ManualTimerScheduler();
  const session = new NarrativeIndexSession({ store, schemaVersion: SCHEMA_VERSION, now: () => NOW });
  const maintainer = new NarrativeIndexMaintainer({
    session,
    source,
    config: () => configStore.resolve(ROOT),
    scheduler,
    watcher: new TestNarrativeFileWatcher(),
    configurator: new NarrativeMemoryConfigurator(configStore),
    rootPath: ROOT,
    now: () => NOW
  });
  maintainer.start();
  await maintainer.rebuildNow();
  return { store, configStore, source, scheduler, session, maintainer };
}

describe('a failing background sweep is reported, not swallowed (ISS-361)', () => {
  test('a TTL sweep that rejects leaves the index `failed`, not silently unchanged', async () => {
    const built = await buildStack();
    expect(built.session.state().state).toBe('ready');

    built.source.failStat = true;
    built.scheduler.advance(built.configStore.resolve(ROOT).fallbackTtlMs);
    await built.maintainer.flush();

    const state = built.session.state();
    expect(state.state).toBe('failed');
    // The honest code: `IndexFailureCode` is closed and has no lock member, and
    // this is the same read/extract work the watcher lane reports the same way.
    expect(state.state === 'failed' && state.reason.code).toBe('extraction-failed');
  });

  test('PAIRED, THE LOAD-BEARING ONE: under a foreign lock it stays `stale/foreign-writer`, NOT `failed`', async () => {
    // A window that merely is not the writer is not a broken index. `failed`
    // means "recovery REFUSED" — a strictly stronger claim — and recording it
    // would REPLACE the accurate `foreign-writer` report the status bar already
    // shows with a worse one. An implementation that reported every sweep
    // rejection uniformly must fail here.
    const built = await buildStack();
    built.store.foreignLocked = true;

    const before = built.session.state();
    expect(before.state).toBe('stale');
    expect(before.state === 'stale' && before.staleReason).toBe('foreign-writer');

    built.source.failStat = true;
    built.scheduler.advance(built.configStore.resolve(ROOT).fallbackTtlMs);
    await built.maintainer.flush();

    const after = built.session.state();
    expect(after.state).toBe('stale');
    expect(after.state === 'stale' && after.staleReason).toBe('foreign-writer');
  });
});
