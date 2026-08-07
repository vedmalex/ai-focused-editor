/**
 * ISS-374 (gh#69) — teeth for the watcher liveness probe.
 *
 * THE ONE gh#69 NAMES IN AS MANY WORDS: "должен краснеть, если проверка начнёт
 * отвечать «жив» там, где событий нет — иначе это будет второй индикатор,
 * которому нельзя верить". That is the first case below. The environment with
 * no events needs no special stub: `TestNarrativeFileWatcher` delivers only
 * what `push()` gives it, so a watcher nobody pushes to IS a hung service as
 * far as this port can tell.
 *
 * WHAT THESE PIN AND WHAT THEY DO NOT. They pin the MECHANISM against the port:
 * write, wait, decide. They do NOT reproduce the macOS FSEvents hang this issue
 * was born from — that needs a hung system service on a machine this repository
 * has no way to stand up, and saying so here is cheaper than someone later
 * mistaking green for "the symptom is covered".
 *
 * A SECOND DIVERGENCE, NAMED BECAUSE IT ALREADY HID A REAL DEFECT ONCE. The
 * `buildMaintainer` harness below makes `probeWatcherTouch` push the event
 * itself, i.e. it models "a touch always produces an event". Production does
 * not guarantee that — it depends on the probe file being written somewhere the
 * watcher is not told to ignore, which is a property of the NODE adapter and is
 * invisible from here. The first version of this feature wrote into `.theia/`,
 * a directory the watcher receives as an `ignored` glob, so every healthy
 * session would have answered `silent`; these tests stayed green throughout,
 * because the double injected the very event production suppressed. The path
 * choice is therefore load-bearing and lives with its reasoning in
 * `node-narrative-knowledge-service.ts`; no test in this lane can defend it.
 */

import { describe, expect, test } from 'bun:test';
import { InMemoryNarrativeIndexStore } from './in-memory-narrative-index-store';
import { InMemoryConfigStore, NarrativeMemoryConfigurator } from './narrative-memory-configure';
import { NarrativeIndexMaintainer, WATCHER_WARMUP_DURATION_MS } from './narrative-index-maintainer';
import { NarrativeIndexSession, type IndexableFile } from './narrative-index-session';
import { TestNarrativeFileWatcher } from './narrative-file-watcher';
import { ManualTimerScheduler } from './narrative-timer';
import { InMemoryWorkspaceSource } from './narrative-workspace-source';
import { probeWatcherLiveness, WATCHER_LIVENESS_TIMEOUT_MS } from './narrative-watcher-liveness';

/** Run the probe and fire the timeout the moment it is armed. */
async function runProbe(options: {
  watcher: TestNarrativeFileWatcher;
  touch: () => Promise<void> | void;
  timeoutMs?: number;
}) {
  const scheduler = new ManualTimerScheduler();
  const verdict = probeWatcherLiveness({
    watcher: options.watcher,
    scheduler,
    touch: options.touch,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });
  // Let the probe subscribe, touch and arm its timer before the clock moves.
  await Promise.resolve();
  await Promise.resolve();
  scheduler.advance(options.timeoutMs ?? WATCHER_LIVENESS_TIMEOUT_MS);
  return verdict;
}

describe('watcher liveness probe (ISS-374)', () => {
  test('THE LOAD-BEARING ONE: a watcher that delivers NOTHING is `silent`, never `alive`', async () => {
    // A probe that answered `alive` here would be the second untrustworthy
    // indicator gh#69 forbids — worse than no probe, because it would be
    // believed.
    const watcher = new TestNarrativeFileWatcher();
    expect(await runProbe({ watcher, touch: () => undefined })).toBe('silent');
  });

  test('PAIRED POSITIVE: a watcher that delivers is `alive` — "always silent" must fail here', async () => {
    const watcher = new TestNarrativeFileWatcher();
    expect(
      await runProbe({
        watcher,
        touch: () => {
          // A live watcher's event for our own write.
          watcher.push({ path: '.afe/watcher-probe.tmp', type: 'updated' });
        }
      })
    ).toBe('alive');
  });

  test('an event arriving AFTER the touch but before the timeout still counts as alive', async () => {
    // The real path is asynchronous: the write returns, the event follows. An
    // implementation that only looked at the instant `touch()` resolved would
    // call a healthy watcher silent.
    const watcher = new TestNarrativeFileWatcher();
    const scheduler = new ManualTimerScheduler();
    const verdict = probeWatcherLiveness({ watcher, scheduler, touch: () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    watcher.push({ path: '.afe/watcher-probe.tmp', type: 'updated' });
    scheduler.advance(WATCHER_LIVENESS_TIMEOUT_MS);
    expect(await verdict).toBe('alive');
  });

  test('a touch that throws is `inconclusive` — it blames nobody', async () => {
    // Reporting `silent` here would accuse the watcher of a failure that was
    // ours, and `watcher-lost` is a user-visible claim.
    const watcher = new TestNarrativeFileWatcher();
    expect(
      await runProbe({
        watcher,
        touch: () => {
          throw new Error('read-only filesystem');
        }
      })
    ).toBe('inconclusive');
  });

  test('the probe leaves no subscription behind, on every path', async () => {
    // It runs once per session next to long-lived listeners; a leaked
    // subscription would keep answering for the rest of the session.
    for (const touch of [() => undefined, () => { throw new Error('nope'); }]) {
      const watcher = new TestNarrativeFileWatcher();
      await runProbe({ watcher, touch });
      expect(watcher.listenerCount).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The verdict has to REACH the author, or the probe is a diary entry.
// ---------------------------------------------------------------------------

const ROOT = '/workspace/book';
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

async function buildMaintainer(options: { touch?: () => Promise<void> | void; deliver: boolean }) {
  const configStore = new InMemoryConfigStore();
  const watcher = new TestNarrativeFileWatcher();
  const scheduler = new ManualTimerScheduler();
  const session = new NarrativeIndexSession({
    store: new InMemoryNarrativeIndexStore(),
    schemaVersion: 3,
    now: () => NOW
  });
  // The warm-up phase — and with it the probe — only runs when the watcher
  // claims an arming moment; see `TestNarrativeFileWatcher.whenReady`'s doc.
  watcher.whenReady = () => Promise.resolve();
  const maintainer = new NarrativeIndexMaintainer({
    session,
    source: new InMemoryWorkspaceSource([
      file('manifest.yaml', 'content:\n  - path: content/ch-01.md\n    title: One'),
      file('content/ch-01.md', 'Prose about [[char:krishna|Кришна]].')
    ]),
    config: () => configStore.resolve(ROOT),
    scheduler,
    watcher,
    configurator: new NarrativeMemoryConfigurator(configStore),
    rootPath: ROOT,
    now: () => NOW,
    ...(options.touch === undefined
      ? {}
      : {
          probeWatcherTouch: () => {
            if (options.deliver) {
              watcher.push({ path: '.afe/watcher-probe.tmp', type: 'updated' });
            }
            return options.touch?.();
          }
        })
  });
  maintainer.start();
  await maintainer.rebuildNow();
  // Let `whenReady().then(...)` and the probe's own awaits run, then expire the
  // probe's timeout.
  for (let tick = 0; tick < 6; tick++) {
    await Promise.resolve();
  }
  // The maintainer passes its own, longer window (the whole warm-up phase), so
  // the harness must advance by THAT rather than the module default.
  scheduler.advance(WATCHER_WARMUP_DURATION_MS);
  for (let tick = 0; tick < 6; tick++) {
    await Promise.resolve();
  }
  // The delivering case pushes a real event, which enqueues a real pass; drain
  // it so the assertion reads a settled state rather than `rebuilding`.
  scheduler.advance(configStore.resolve(ROOT).debounceMs);
  await maintainer.flush();
  return { session, maintainer, watcher, scheduler };
}

describe('the liveness verdict reaches the index state (ISS-374)', () => {
  test('a silent watcher makes the index `stale/watcher-lost` — the whole point of gh#69', async () => {
    const built = await buildMaintainer({ touch: () => undefined, deliver: false });
    const state = built.session.state();
    expect(state.state).toBe('stale');
    expect(state.state === 'stale' && state.staleReason).toBe('watcher-lost');
  });

  test('QUIET WHEN HEALTHY: a delivering watcher leaves the state alone', async () => {
    // "Не шуметь при исправной работе" is one of gh#69's own boundaries. An
    // implementation that reported on every session must fail here.
    const built = await buildMaintainer({ touch: () => undefined, deliver: true });
    expect(built.session.state().state).toBe('ready');
  });

  test('no touch supplied means no probe, and therefore no verdict', async () => {
    // Every existing fixture omits `probeWatcherTouch`; none of them may start
    // reporting a lost watcher because this feature was added.
    const built = await buildMaintainer({ deliver: false });
    expect(built.session.state().state).toBe('ready');
  });
});
