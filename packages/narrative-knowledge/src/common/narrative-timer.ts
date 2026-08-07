/**
 * `NarrativeTimerScheduler` — the one-shot timer behind the debounce window and
 * the fallback sweep (TASK-022 WP-4b).
 *
 * WHY A PORT FOR SOMETHING `setTimeout` ALREADY DOES. Because two of this work
 * package's readiness cases are ABOUT THE TIMER, not merely delayed by it:
 *
 *   - "the watcher takes its INITIAL window from the config" is an assertion
 *     about the DELAY a timer was armed with, and no amount of waiting observes
 *     a number;
 *   - tech_spec ОВ-9б tooth 3 requires that an idempotent `configure` call not
 *     RECREATE the timer, "проверяется счётчиком пересозданий, а не отсутствием
 *     видимого эффекта" — a counter of `schedule` calls is precisely that, and a
 *     test that merely observed the window still firing on time would pass
 *     against an implementation that tore the timer down and rebuilt it
 *     identically on every keystroke, which is the failure being guarded.
 *
 * A real-clock test would also have to sleep for the real window, and the window
 * defaults to 400 ms with a fallback TTL of five minutes.
 */

/** A scheduled callback that has not fired yet. */
export interface NarrativeTimerHandle {
  /** Prevent the callback from firing. Idempotent, and safe after it fired. */
  cancel(): void;
}

export interface NarrativeTimerScheduler {
  /** Run `callback` once, `delayMs` from now. */
  schedule(delayMs: number, callback: () => void): NarrativeTimerHandle;
}

/**
 * The production scheduler: `setTimeout`.
 *
 * `setTimeout` IS A GLOBAL, NOT AN IMPORT, so prohibition (a) is untouched —
 * this file names no `node:*` module and runs unchanged under `bun`.
 *
 * `unref` IS CALLED WHEN IT EXISTS, and that is not cosmetic: the fallback sweep
 * re-arms itself forever, and a referenced five-minute timer would keep a Node
 * backend alive after everything else had finished. The guard is a duck-type
 * check because the browser's `setTimeout` returns a number, which has no
 * `unref` and needs none.
 */
export const systemTimerScheduler: NarrativeTimerScheduler = {
  schedule(delayMs: number, callback: () => void): NarrativeTimerHandle {
    const handle = setTimeout(callback, delayMs) as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') {
      handle.unref();
    }
    return { cancel: () => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>) };
  }
};

interface ScheduledEntry {
  id: number;
  dueAt: number;
  callback: () => void;
  cancelled: boolean;
}

/**
 * A scheduler driven by a virtual clock.
 *
 * IT SHIPS IN `lib` RATHER THAN LIVING UNDER `test/`, for the reason the
 * in-memory store adapter does: the contract core that uses it runs in BOTH
 * lanes, and the node lane imports the built package.
 *
 * `creations` COUNTS ARMINGS, NOT LIVE TIMERS, and that is the number ОВ-9б
 * tooth 3 asks for: an implementation that cancels and re-arms an identical
 * window is indistinguishable from one that leaves it alone by any observation
 * of WHEN it fires, and distinguishable immediately by this counter.
 */
export class ManualTimerScheduler implements NarrativeTimerScheduler {
  private readonly entries: ScheduledEntry[] = [];
  private nextId = 1;
  private clock = 0;
  /** Every delay ever armed, in arming order. */
  readonly armedDelays: number[] = [];

  /** How many timers were ARMED over this scheduler's whole life. */
  get creations(): number {
    return this.armedDelays.length;
  }

  /** Timers armed and not yet fired or cancelled. */
  get pending(): number {
    return this.entries.filter(entry => !entry.cancelled).length;
  }

  /** Virtual now, in ms since this scheduler was created. */
  get now(): number {
    return this.clock;
  }

  schedule(delayMs: number, callback: () => void): NarrativeTimerHandle {
    const entry: ScheduledEntry = {
      id: this.nextId++,
      dueAt: this.clock + delayMs,
      callback,
      cancelled: false
    };
    this.entries.push(entry);
    this.armedDelays.push(delayMs);
    return {
      cancel: () => {
        entry.cancelled = true;
      }
    };
  }

  /**
   * Move the clock forward and fire everything that came due.
   *
   * FIRES IN DUE ORDER, and re-checks after every callback: a fallback sweep
   * re-arms itself from inside its own callback, so a naive "snapshot the list,
   * then run it" would either miss the re-armed timer or run it at the wrong
   * virtual instant. The `guard` bounds the loop so a timer armed with delay 0
   * inside its own callback fails loudly instead of hanging the test run.
   */
  advance(ms: number): void {
    const target = this.clock + ms;
    let guard = 0;
    for (;;) {
      const due = this.entries
        .filter(entry => !entry.cancelled && entry.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (due === undefined) {
        break;
      }
      if (++guard > 10_000) {
        throw new Error('ManualTimerScheduler.advance: a timer kept re-arming itself inside the same window');
      }
      due.cancelled = true;
      this.clock = due.dueAt;
      due.callback();
    }
    this.clock = target;
  }
}
