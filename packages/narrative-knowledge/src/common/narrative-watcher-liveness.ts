/**
 * `probeWatcherLiveness` — does file watching actually DELIVER, or only claim to
 * (ISS-374, gh#69)?
 *
 * THE FAILURE THIS EXISTS FOR IS SILENT BY CONSTRUCTION. `watchFileChanges()`
 * resolves, `onDidFail` never fires, and no event ever arrives — on 2026-08-06 a
 * hung macOS FSEvents service did exactly that. Everything downstream keeps
 * answering `ready` while the five-minute fallback sweep quietly carries the
 * whole product. The existing `watcher-lost` channel cannot see it: it is fed
 * ONLY by `watcher.onDidFail` (`narrative-index-maintainer.ts`), and a hung
 * service does not fail, it goes quiet.
 *
 * COST OF THAT SILENCE, MEASURED ON OURSELVES. Half a day and three wrong
 * diagnoses in a row, by people with the whole source tree open — every one of
 * them wrong because it measured from INSIDE the broken environment. An author
 * would never get there; they would see "it is slow sometimes" and conclude the
 * editor is bad.
 *
 * WHY THIS LIVES IN `common/` AND TAKES PORTS. The real adapter
 * (`src/node/theia-narrative-file-watcher.ts`) says in its own header that it is
 * exercised by no test here — it needs an Inversify container and a spawned
 * watcher process. gh#69 requires a tooth that reddens if this probe ever
 * answers "alive" where no events arrive, and that tooth is only constructible
 * against the port. Time arrives through {@link NarrativeTimerScheduler}, events
 * through {@link NarrativeFileWatcher}, the write through `touch` — the same
 * arrangement `NarrativeIndexMaintainer` already uses, for the same reason.
 *
 * DELIBERATELY NOT AN ALTERNATIVE WATCHER. gh#69 rules out wiring a `kqueue`
 * fallback and it is right to: on a healthy system FSEvents works and is the
 * better mechanism (`kqueue` holds a descriptor per file). This answers one
 * question — are events flowing — and changes nothing about how they flow.
 */

import type { NarrativeFileWatcher } from './narrative-file-watcher';
import type { NarrativeTimerScheduler } from './narrative-timer';

/**
 * How long to wait for the probe's own write to come back as an event.
 *
 * SECONDS, ONCE PER SESSION (gh#69's own budget). Long enough that a loaded
 * machine's watcher is not slandered, short enough that nothing user-visible
 * waits on it — nothing does, the probe is fire-and-forget.
 */
export const WATCHER_LIVENESS_TIMEOUT_MS = 3_000;

export type WatcherLivenessVerdict =
  /** An event arrived for our own write. Watching works. */
  | 'alive'
  /** The write went in and no event came back within the timeout. */
  | 'silent'
  /** The probe could not run (the touch itself threw). Says nothing either way. */
  | 'inconclusive';

export interface WatcherLivenessProbeOptions {
  watcher: NarrativeFileWatcher;
  scheduler: NarrativeTimerScheduler;
  /**
   * Create/modify the probe file and resolve once the write is on disk.
   *
   * THE CALLER PICKS THE PATH, AND IT MUST BE OUTSIDE THE INDEXED TREE. Touching
   * anything the index reads would both trigger a real pass and leave debris in
   * the author's manuscript; gh#69 says "свой служебный каталог" for exactly
   * that reason. Cleanup is the caller's too, since only the caller knows what
   * it created.
   */
  touch: () => Promise<void> | void;
  timeoutMs?: number;
}

/**
 * Subscribe, write, wait briefly, report.
 *
 * ANY event ends the wait, not only one naming the probe file. The port delivers
 * batches and the adapter converts URIs to workspace-relative paths, so a probe
 * file deliberately kept OUTSIDE the workspace may arrive filtered or renamed —
 * matching on the path would then read "silent" on a perfectly live watcher,
 * which is the one verdict this must never invent. The question asked here is
 * "is this subscription delivering anything at all", and that is the question a
 * hung service answers with silence.
 */
export async function probeWatcherLiveness(options: WatcherLivenessProbeOptions): Promise<WatcherLivenessVerdict> {
  const timeoutMs = options.timeoutMs ?? WATCHER_LIVENESS_TIMEOUT_MS;

  let saw = false;
  const subscription = options.watcher.onDidChangeFiles(() => {
    saw = true;
  });

  try {
    try {
      await options.touch();
    } catch {
      // A probe that cannot write has learned nothing ABOUT THE WATCHER, and
      // saying "silent" here would blame it for the caller's failure.
      return 'inconclusive';
    }

    // An event delivered synchronously by a double (or by an already-queued real
    // batch) must not cost a full timeout.
    if (saw) {
      return 'alive';
    }
    await new Promise<void>(resolve => {
      options.scheduler.schedule(timeoutMs, resolve);
    });
    return saw ? 'alive' : 'silent';
  } finally {
    subscription.dispose();
  }
}
