/**
 * `NarrativeIndexMaintainer` — the watcher, the sweeps and THE SINGLE GUARD
 * (TASK-022 WP-4b).
 *
 * WHAT IS INHERITED FROM `NoteIndexService`, AND WHAT IS NOT. The plan is exact
 * about this, and it matters because the obvious answer is wrong.
 * `NoteIndexService` is a FRONTEND service: it uses `WorkspaceService`,
 * `fileService.onDidFilesChange` and `FileSearchService`, none of which exist in
 * `src/node`. What carries over is the STRUCTURAL FORM — a debounce window, a
 * fallback TTL, a `rebuildInFlight`/`rebuildAgainAfter` pair, and no reaction to
 * keystrokes. What does not carry over is the event source, and with it the
 * hardest problem in this work package: Theia's backend watcher protocol has NO
 * RENAME EVENT, so a move has to be inferred (tech_spec ОВ-3).
 *
 * WHY THIS CLASS IS IN `src/common` WHEN IT SCHEDULES TIMERS AND READS FILES.
 * It does neither directly. Time arrives through {@link NarrativeTimerScheduler}
 * and files through {@link NarrativeWorkspaceSource}, both of which are ports
 * with a production implementation in `src/node` and a deterministic double that
 * ships in `lib`. That is the WP-4a arrangement applied to the harder half: one
 * body of assertions runs under `bun` against the in-memory store and under real
 * `node` against SQLite, so "an explicit rebuild during a watcher batch" is
 * proved against the engine that actually serializes transactions, not only
 * against a double that cannot fail the way SQLite can.
 *
 * THE GUARD SERIALIZES; IT DOES NOT SUBSUME. A request that arrives while a pass
 * is running is queued and runs after it, and every caller gets the report of
 * the pass it asked for. The tempting optimisation — let a queued rebuild
 * swallow a queued incremental batch — was rejected because it would have to
 * settle the batch's promise with a report of work that pass did not do, and a
 * caller reading `documentsReindexed` would be reading a fiction. Coalescing
 * happens where it is honest: WITHIN the debounce window, where fifty events
 * over fifty files become one pass and one transaction.
 *
 * `rebuilding` IS HELD ACROSS THE WHOLE DRAIN, not per pass. That is the
 * difference between "the consumer sees two rebuilds" and "the consumer sees a
 * momentary `ready` over a half-applied manuscript", and the second is what plan
 * WP-4b's first readiness case forbids in as many words.
 */

import { ENTITY_TYPES_PATH, MANIFEST_PATH } from './extraction/document-classification';
import { extractManifestChapters, type ManifestChapter } from './extraction/manifest-extraction';
import { resolveEffectiveEntityTypes } from './extraction/narrative-extraction';
import { normalizeWorkspacePath } from './extraction/yaml-values';
import type { EffectiveEntityType } from './entity-type-registry';
import type { Envelope } from './narrative-envelope';
import type { NarrativeDisposable, NarrativeFileChange, NarrativeFileWatcher } from './narrative-file-watcher';
import {
  documentNeedsReindex,
  NarrativeIndexSession,
  type IndexableFile,
  type NarrativeRebuildReport
} from './narrative-index-session';
import {
  changeForcesRebuild,
  foldFileChanges,
  isIndexablePath,
  pairMovedDocuments,
  type IndexUpdatePlan,
  type NarrativeUpdateReport
} from './narrative-index-update';
import type { NarrativeMemoryConfig } from './narrative-memory-config';
import type { NarrativeConfigChange, NarrativeMemoryConfigurator } from './narrative-memory-configure';
import { systemTimerScheduler, type NarrativeTimerHandle, type NarrativeTimerScheduler } from './narrative-timer';
import type { NarrativeWorkspaceSource } from './narrative-workspace-source';

/** Why a pass ran. Carried into the report so a log says what woke the index. */
export type MaintenanceTrigger = 'watcher' | 'explicit' | 'ttl-sweep' | 'recovery-sweep' | 'document' | 'warmup-sweep';

/**
 * How often a warm-up sweep runs while a watcher's arming is unproven
 * (TASK-022 UR-036 part 2, ISS-360).
 *
 * NOT SUB-SECOND, DELIBERATELY. The failure this closes is a real gap of up to
 * sixteen measured seconds between `watchFileChanges()`'s promise resolving and
 * the spawned watcher actually delivering an event — polling faster than an
 * editor's own save cadence would not close that gap any better and would only
 * add I/O for no observational gain. Two seconds bounds the loss window to
 * "barely noticeable" without turning the warm-up phase into the thing ОВ-1's
 * routine TTL sweep is deliberately cheap by NOT being.
 */
export const WATCHER_WARMUP_SWEEP_INTERVAL_MS = 2_000;

/**
 * How long the warm-up phase runs before yielding to the ordinary
 * `fallbackTtlMs` cadence (ISS-360).
 *
 * The measured worst case was sixteen seconds; sixty gives a wide margin for a
 * slower disk or a bigger manuscript's `stat()` pass without leaving the
 * frequent sweep running indefinitely on a workspace that is simply idle —
 * `fallbackTtlMs` is the setting for STEADY STATE, tech_spec ОВ-9б's own
 * wording, and this constant is deliberately a separate number so warming up
 * faster never means redefining what that setting means.
 */
export const WATCHER_WARMUP_DURATION_MS = 60_000;

/**
 * How long to wait, after the LAST completed pass, before telling
 * `onIndexChanged` about the generation reached (TASK-022 UR-043).
 *
 * NAMED AND CHOSEN DELIBERATELY, not left as an inline magic number — UR-043's
 * own boundary requires it: "частые изменения должны схлопываться (при
 * перестройке поколение растёт много раз подряд — нельзя перерисовывать на
 * каждое)". A full rebuild, or a `git checkout` that lands a whole burst of
 * watcher batches back to back, can drive several passes — several committed
 * transactions, several generation bumps — through {@link NarrativeIndexMaintainer.drain}
 * before the queue empties; pushing one RPC notification per pass would make
 * Narrative Map and Entity Cards redraw once per commit during exactly that
 * burst.
 *
 * THE SAME DEBOUNCE IDIOM ALREADY USED FOR THE WATCHER'S OWN BATCHING
 * ({@link NarrativeIndexMaintainerOptions.config}'s `debounceMs`): each
 * completed pass RE-ARMS a single timer rather than firing immediately, so a
 * burst collapses to one push carrying the LAST generation reached, exactly
 * as `onFileChanges` collapses a burst of file events into one batch.
 *
 * 250ms IS SHORTER THAN THE DEFAULT WATCHER `debounceMs` (400ms), ON PURPOSE.
 * This timer only ever starts AFTER a pass has already committed, so it adds
 * to a wait the user already sat through rather than compounding with it; the
 * five-second poll UR-036 replaces made "index caught up" invisible for up to
 * five seconds, so 250ms on top of an already-committed write is not a
 * regression against anything a reader could have noticed before.
 */
export const INDEX_CHANGE_NOTIFICATION_DEBOUNCE_MS = 250;

/** What one pass produced: an incremental report, or a full rebuild's. */
export type MaintenanceOutcome =
  | { kind: 'update'; trigger: MaintenanceTrigger; report: NarrativeUpdateReport }
  | { kind: 'rebuild'; trigger: MaintenanceTrigger; report: NarrativeRebuildReport };

export interface NarrativeIndexMaintainerOptions {
  session: NarrativeIndexSession;
  source: NarrativeWorkspaceSource;
  /**
   * The effective configuration, read FRESH at every arming.
   *
   * A FUNCTION AND NOT A VALUE, and that is how ОВ-9б's fourth consequence is
   * implemented rather than merely intended: a window already in flight was
   * armed with the old number and finishes on it, and the NEXT window picks up
   * whatever `configure` has since decided. Nothing has to notify anybody for
   * the common case to be right.
   */
  config: () => NarrativeMemoryConfig;
  scheduler?: NarrativeTimerScheduler;
  watcher?: NarrativeFileWatcher;
  /**
   * The `configure` handler, subscribed to for the case the paragraph above
   * does NOT cover: the fallback sweep's window can be an hour long, so a
   * shortened TTL that waited out the old one would not take effect until the
   * user had given up. Only a REAL change is announced (see
   * {@link NarrativeMemoryConfigurator.onDidChange}), which is what makes ОВ-9б
   * tooth 3 — "an idempotent call does not recreate the timer" — an assertion
   * about this class and not a hope.
   */
  configurator?: NarrativeMemoryConfigurator;
  /** Scope of config changes this maintainer answers to. */
  rootPath?: string;
  now?: () => number;
  /**
   * Debounced "generation advanced" push (TASK-022 UR-043). Called AT MOST
   * once per {@link INDEX_CHANGE_NOTIFICATION_DEBOUNCE_MS} window, with the
   * generation the session reports once the debounce settles — see that
   * constant's own doc for why a whole rebuild still collapses to one call.
   *
   * OPTIONAL, like {@link watcher}: a maintainer built for a test or for the
   * bun contract-core lane has nobody to push to, and omitting this callback
   * costs it nothing beyond the one timer it would otherwise arm.
   */
  onIndexChanged?: (generation: number) => void;
}

interface QueuedPass {
  run(): Promise<MaintenanceOutcome>;
  resolve(outcome: MaintenanceOutcome): void;
  reject(error: unknown): void;
}

export class NarrativeIndexMaintainer {
  private readonly session: NarrativeIndexSession;
  private readonly source: NarrativeWorkspaceSource;
  private readonly readConfig: () => NarrativeMemoryConfig;
  private readonly scheduler: NarrativeTimerScheduler;
  private readonly watcher: NarrativeFileWatcher | undefined;
  private readonly configurator: NarrativeMemoryConfigurator | undefined;
  private readonly rootPath: string | undefined;
  private readonly now: () => number;
  private readonly notifyIndexChanged: ((generation: number) => void) | undefined;

  private readonly subscriptions: NarrativeDisposable[] = [];
  private debounceTimer: NarrativeTimerHandle | undefined;
  private sweepTimer: NarrativeTimerHandle | undefined;
  /** Armed only during the warm-up phase (ISS-360); `undefined` once it ends. */
  private warmupTimer: NarrativeTimerHandle | undefined;
  /** When the warm-up phase gives up and defers to `fallbackTtlMs`; `undefined`
   *  outside the phase (before it starts, and after it ends either way). */
  private warmupDeadline: number | undefined;
  /** Changes accumulated since the current debounce window opened. */
  private pending: NarrativeFileChange[] = [];
  private queue: QueuedPass[] = [];
  private draining: Promise<void> | undefined;
  private started = false;
  /** Armed by {@link scheduleIndexChangedNotification}; re-armed (not
   *  stacked) by every pass that completes while it is pending — the
   *  coalescing {@link INDEX_CHANGE_NOTIFICATION_DEBOUNCE_MS} exists for. */
  private notifyTimer: NarrativeTimerHandle | undefined;
  /** The generation last handed to {@link notifyIndexChanged}, so a pass that
   *  committed nothing new (an empty sweep) does not re-announce the same
   *  number when its own debounce window settles. */
  private lastNotifiedGeneration: number | undefined;

  /**
   * How many passes are executing RIGHT NOW.
   *
   * It must never exceed one, and the concurrency readiness case asserts exactly
   * that. It is a counter rather than a boolean so that a violation shows up as
   * a number greater than one instead of as a silently overwritten flag.
   */
  private inFlight = 0;
  /** The high-water mark of {@link inFlight}, for the assertion above. */
  maxConcurrentPasses = 0;

  constructor(options: NarrativeIndexMaintainerOptions) {
    this.session = options.session;
    this.source = options.source;
    this.readConfig = options.config;
    this.scheduler = options.scheduler ?? systemTimerScheduler;
    this.watcher = options.watcher;
    this.configurator = options.configurator;
    this.rootPath = options.rootPath;
    this.now = options.now ?? (() => Date.now());
    this.notifyIndexChanged = options.onIndexChanged;
  }

  // ---- lifecycle ---------------------------------------------------------

  /**
   * Subscribe to the watcher and arm the fallback sweep.
   *
   * THE FALLBACK SWEEP IS ARMED AT START, not on the first change: it is
   * insurance against a watcher that is ALIVE BUT LOSSY, and a watcher that has
   * never delivered anything is exactly the case where the insurance is needed.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    if (this.watcher !== undefined) {
      this.subscriptions.push(this.watcher.onDidChangeFiles(changes => this.onFileChanges(changes)));
      this.subscriptions.push(this.watcher.onDidFail(failure => this.onWatcherLost(failure.message)));
      this.beginWatcherWarmup(this.watcher);
    }
    if (this.configurator !== undefined) {
      this.subscriptions.push(this.configurator.onDidChange(change => this.onConfigChange(change)));
    }
    this.armSweep();
  }

  /**
   * Release timers, subscriptions AND the watcher itself. Idempotent; safe
   * before `start`.
   *
   * `this.subscriptions` ONLY HOLDS LISTENER-REMOVAL DISPOSABLES —
   * `onDidChangeFiles`/`onDidFail` return "stop calling me back", not "stop
   * watching". The watcher's OWN `dispose()` (ISS-359, TASK-022 WP-4b) is what
   * unregisters it from `FileSystemWatcherServiceDispatcher` and releases its
   * OS watch handle; skipping it here was harmless only because nothing ever
   * called `start()` in a running application. The moment `start()` is called
   * for real, every `stop()` that omitted this line would leak one dispatcher
   * client and one live filesystem watcher per workspace closed or evicted —
   * exactly what `NodeNarrativeKnowledgeService.dispose()`'s own doc comment
   * already promises does NOT happen.
   */
  stop(): void {
    this.started = false;
    this.debounceTimer?.cancel();
    this.debounceTimer = undefined;
    this.sweepTimer?.cancel();
    this.sweepTimer = undefined;
    // Same reasoning as the two cancellations above (UR-043): a maintainer
    // that is stopping must not fire a push moments later for a workspace
    // whose session may already be gone — `NodeNarrativeKnowledgeService.dispose()`
    // clears `this.sessions` synchronously, and an unarmed timer is a timer
    // that cannot read it.
    this.notifyTimer?.cancel();
    this.notifyTimer = undefined;
    this.stopWarmup();
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.watcher?.dispose();
  }

  /** Wait for the queue to drain. Shutdown needs it; so does every test. */
  async flush(): Promise<void> {
    while (this.draining !== undefined) {
      await this.draining;
    }
  }

  // ---- the public operations --------------------------------------------

  /**
   * Re-index ONE document (the protocol's `updateDocument(uri)`).
   *
   * It goes through the same guard as everything else, so a caller cannot use it
   * to sneak a write past a rebuild in flight.
   */
  async updateDocument(path: string): Promise<Envelope<NarrativeUpdateReport>> {
    return this.applyChanges([{ path: normalizeWorkspacePath(path), type: 'updated' }], 'document');
  }

  /**
   * Apply one batch of changes and wait for its report.
   *
   * THE SAME ENTRY THE DEBOUNCE TIMER USES, exposed. The watcher path is fire
   * and forget by nature — nothing is waiting on it — so without this method the
   * only way to assert what a batch DID would be to infer it from the store
   * afterwards, and an inference cannot tell a move from a delete-plus-add that
   * happened to land on the same content. `documentsMoved` can, and ОВ-3's
   * second tooth is exactly that distinction.
   */
  async applyChanges(
    changes: readonly NarrativeFileChange[],
    trigger: MaintenanceTrigger = 'explicit'
  ): Promise<Envelope<NarrativeUpdateReport>> {
    const outcome = await this.enqueue(() => this.runChanges(changes, trigger));
    return this.asUpdateEnvelope(outcome);
  }

  /**
   * The explicit Rebuild Index command.
   *
   * THROUGH THE SAME GUARD, which is the plan's requirement and not a courtesy:
   * `NoteIndexService`'s pattern protects only watcher-against-watcher, and the
   * command is a THIRD writer. Without this it could open a transaction while a
   * watcher batch held one.
   */
  async rebuildNow(options: { fresh?: boolean } = {}): Promise<Envelope<NarrativeRebuildReport>> {
    const outcome = await this.enqueue(async () => ({
      kind: 'rebuild' as const,
      trigger: 'explicit' as const,
      report: this.session.rebuild(await this.source.readAll(), {
        indexedAt: this.now(),
        ...(options.fresh === true ? { fresh: true } : {})
      }).data
    }));
    if (outcome.kind !== 'rebuild') {
      throw new Error('rebuildNow received an incremental outcome');
    }
    return { state: this.session.state(), data: outcome.report };
  }

  /**
   * A sweep over the whole workspace.
   *
   * TWO MODES, AND THE DIFFERENCE IS WHICH FILES GET READ (ОВ-1, ОВ-6):
   *
   *   - `prefiltered` (the routine TTL sweep): `stat` everything, read only what
   *     the `(size, mtime)` prefilter says might have moved. Cheap, and it
   *     leaves the residual false-negative window open — a same-size edit inside
   *     the same second is invisible. That window is a FIXED, TESTED behaviour
   *     (tooth C2), not an accident.
   *   - `hash-authoritative` (leaving `watcher-lost`): read and hash EVERY file,
   *     no prefilter. It is the only honest way back to `ready` after the
   *     watcher was down, because the whole meaning of `watcher-lost` is that
   *     changes arrived unseen — declaring freshness on a prefilter would be
   *     declaring freshness nobody checked (tooth C1). ОВ-6 spells this out
   *     specifically so an implementer reading only ОВ-6 does not build the
   *     cheap one and then weaken C1 to match.
   */
  async sweep(
    mode: 'prefiltered' | 'hash-authoritative',
    trigger: MaintenanceTrigger = mode === 'prefiltered' ? 'ttl-sweep' : 'recovery-sweep'
  ): Promise<Envelope<NarrativeUpdateReport>> {
    const outcome = await this.enqueue(() => this.runSweep(mode, trigger));
    return this.asUpdateEnvelope(outcome);
  }

  /**
   * Report the watcher as lost. The index goes `stale/watcher-lost` at once.
   *
   * AT ONCE, AND NOT AFTER A SWEEP: from this instant the index cannot promise
   * freshness, and saying so late would be saying it falsely in between.
   */
  noteWatcherLost(reason = 'watcher stopped'): void {
    this.onWatcherLost(reason);
  }

  /**
   * Recover from `watcher-lost`: ONE hash-authoritative sweep, then `ready`.
   *
   * THE SWEEP IS THE PRICE OF THE CLAIM. Returning to `ready` the moment the
   * watcher comes back would announce a freshness nobody verified — the events
   * missed while it was down are not re-delivered. The staleness is cleared only
   * if the sweep completed.
   */
  async recoverWatcher(): Promise<Envelope<NarrativeUpdateReport>> {
    const answer = await this.sweep('hash-authoritative', 'recovery-sweep');
    if (this.session.staleReason() === 'watcher-lost') {
      this.session.clearStale();
    }
    return { state: this.session.state(), data: answer.data };
  }

  // ---- the guard ---------------------------------------------------------

  /**
   * Queue one pass and wait for its own result.
   *
   * THE `rebuilding` FLAG IS OPENED WHEN THE QUEUE STARTS DRAINING AND CLOSED
   * WHEN IT IS EMPTY, which is why a consumer polling across a batch and the
   * rebuild queued behind it never observes `ready` in the gap. The session's
   * pass depth is a counter for exactly this: `rebuild` opens its own inner pass
   * and closing it must not close the outer one.
   */
  private enqueue(run: () => Promise<MaintenanceOutcome>): Promise<MaintenanceOutcome> {
    return new Promise<MaintenanceOutcome>((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      if (this.draining === undefined) {
        this.draining = this.drain();
      }
    });
  }

  private async drain(): Promise<void> {
    this.session.beginPass();
    try {
      while (this.queue.length > 0) {
        const pass = this.queue.shift()!;
        this.inFlight++;
        this.maxConcurrentPasses = Math.max(this.maxConcurrentPasses, this.inFlight);
        try {
          const outcome = await pass.run();
          pass.resolve(outcome);
          // A REJECTED pass wrote nothing, so it is deliberately excluded —
          // scheduling a push after a failed write would announce a change
          // that never committed. A pass that resolves may still have
          // written NOTHING (an empty sweep, ОВ-4's "пустой проход бесплатен"),
          // which `scheduleIndexChangedNotification` itself is what filters:
          // it reads the CURRENT generation only once the debounce settles,
          // so a no-op pass followed by silence re-announces nothing.
          this.scheduleIndexChangedNotification();
        } catch (error) {
          pass.reject(error);
        } finally {
          this.inFlight--;
        }
      }
    } finally {
      this.session.endPass();
      this.draining = undefined;
    }
    // A pass that enqueued more work while this drain was finishing must not be
    // left sitting: the check-and-restart has to happen AFTER `draining` is
    // cleared, or the restart would be swallowed by the guard it just released.
    if (this.queue.length > 0 && this.draining === undefined) {
      this.draining = this.drain();
    }
  }

  /**
   * (Re)arm the debounced `onIndexChanged` push (TASK-022 UR-043).
   *
   * CALLED AFTER EVERY RESOLVED PASS, not once per `drain()` call. The two
   * read the same as a single coalesced push in the common case — a burst of
   * passes runs inside one `drain()` — but they are not the same event: a
   * pass can also arrive AFTER a `drain()` has already returned (the restart
   * branch just above), and re-arming per pass is what keeps that second
   * burst debounced too, with no dependence on how the queue happened to be
   * shaped.
   */
  private scheduleIndexChangedNotification(): void {
    const notify = this.notifyIndexChanged;
    if (notify === undefined) {
      return;
    }
    this.notifyTimer?.cancel();
    this.notifyTimer = this.scheduler.schedule(INDEX_CHANGE_NOTIFICATION_DEBOUNCE_MS, () => {
      this.notifyTimer = undefined;
      const generation = this.session.state().generation;
      if (generation === this.lastNotifiedGeneration) {
        // Every pass since the last push committed nothing new — most often
        // a "Check for Changes Now" that found nothing. UR-043 forbids
        // announcing a change that did not happen exactly as it forbids
        // announcing one too often; silence is the honest answer here.
        return;
      }
      this.lastNotifiedGeneration = generation;
      notify(generation);
    });
  }

  // ---- the watcher path --------------------------------------------------

  /**
   * Accumulate a batch and (re)arm the debounce window.
   *
   * ACCUMULATION IS ACROSS CALLS, not per batch: ОВ-3's pairing is defined over
   * a SET, and a rename usually arrives as a DELETE in one notification and an
   * ADD in the next. Trusting one notification to be complete would make every
   * move a delete-plus-add, which is correct but throws away the `docId` the
   * pairing exists to preserve.
   *
   * THE WINDOW IS RE-ARMED FROM ZERO ON EVERY EVENT — that is what a debounce
   * is, and it is why a `git checkout` touching two hundred files produces ONE
   * pass. The delay is read from the config AT THIS MOMENT, which is how a
   * `configure` lands on the next window and never on one in flight.
   */
  private onFileChanges(changes: readonly NarrativeFileChange[]): void {
    if (changes.length === 0) {
      return;
    }
    // A REAL EVENT IS DELIBERATELY *NOT* TREATED AS PROOF THE WHOLE WATCHER IS
    // ARMED (ISS-360). The spawned watcher behind this port covers a subtree,
    // and there is no guarantee every directory in it armed at the same
    // instant — one event proves coverage for the path it names, not for the
    // rest of the manuscript. Cancelling the warm-up phase on the strength of
    // a single event would re-open ISS-360's own window for whatever had not
    // armed yet, just narrower and far less likely to be noticed. The warm-up
    // phase therefore runs to its own deadline regardless of events arriving
    // alongside it; the cost is bounded (at most `WATCHER_WARMUP_DURATION_MS`
    // / `WATCHER_WARMUP_SWEEP_INTERVAL_MS` prefiltered sweeps, each a `stat()`
    // walk that reads a file only when its (size, mtime) prefilter says so —
    // ОВ-1 C2's own tooth), and the single guard this maintainer already owns
    // serializes a warm-up sweep against a debounced watcher pass exactly as
    // it does an explicit rebuild against either.
    this.pending.push(...changes.map(change => ({ ...change, path: normalizeWorkspacePath(change.path) })));
    this.debounceTimer?.cancel();
    this.debounceTimer = this.scheduler.schedule(this.readConfig().debounceMs, () => {
      this.debounceTimer = undefined;
      const batch = this.pending;
      this.pending = [];
      if (batch.length === 0) {
        return;
      }
      // Fire and forget: nothing awaits a watcher-driven pass, and swallowing
      // its rejection here would hide a real failure. It is recorded on the
      // session instead, where the state machine can show it.
      void this.enqueue(() => this.runChanges(batch, 'watcher')).catch(() => {
        this.session.recordFailure({
          code: 'extraction-failed',
          incidentId: `watcher-${this.now()}`,
          occurrences: 1
        });
      });
    });
  }

  private onWatcherLost(reason: string): void {
    this.session.recordStale('watcher-lost');
    void reason;
  }

  /**
   * Re-arm the fallback sweep, and NOTHING ELSE.
   *
   * The debounce window in flight is deliberately left alone: ОВ-9б's fourth
   * consequence pins the moment a new `debounceMs` takes effect to the NEXT
   * window, and cancelling the current one to re-arm it with a new delay would
   * both violate that and reset a window a user is waiting on.
   */
  private onConfigChange(change: NarrativeConfigChange): void {
    if (this.rootPath !== undefined && change.rootPath !== this.rootPath) {
      return;
    }
    if (!change.changed.includes('fallbackTtlMs')) {
      return;
    }
    this.armSweep();
  }

  /**
   * Start the warm-up phase for a watcher whose arming this maintainer cannot
   * take on faith (ISS-360).
   *
   * `watcher.whenReady()` ABSENT MEANS SKIP ENTIRELY. A watcher with no such
   * method (every test double in this codebase today) is claiming its events
   * are live the instant `onDidChangeFiles` returned, and the warm-up phase
   * has nothing to wait for — arming it anyway would schedule timers a caller
   * of `start()` never asked for and no readiness case here has ever assumed
   * exist (`scheduler.armedDelays` is asserted EXACTLY elsewhere in this file).
   *
   * THE FIRST RECONCILE PASS RUNS THE INSTANT `whenReady()` RESOLVES, before
   * any interval timer — that pass is what closes the gap between
   * "subscribed" and "provably armed", which is exactly the gap an edit could
   * have landed in and which no event will ever be delivered for.
   */
  private beginWatcherWarmup(watcher: NarrativeFileWatcher): void {
    const ready = watcher.whenReady?.();
    if (ready === undefined) {
      return;
    }
    void ready.then(() => {
      if (!this.started) {
        return;
      }
      this.warmupDeadline = this.now() + WATCHER_WARMUP_DURATION_MS;
      void this.sweep('prefiltered', 'warmup-sweep').catch(() => this.recordSweepFailure('warmup-sweep'));
      this.armWarmupSweep();
    });
  }

  /**
   * Re-arm one short-interval warm-up sweep, or stop the phase.
   *
   * THE PHASE ENDS BY ITS OWN DEADLINE, DELIBERATELY NOT BY THE FIRST REAL
   * EVENT (see {@link onFileChanges}'s own comment) — this method's only exit
   * is "give up after `WATCHER_WARMUP_DURATION_MS`", handled by simply not
   * re-arming; the long `fallbackTtlMs` sweep armed in `start()` was never
   * paused and keeps standing insurance from here on, unchanged from what it
   * did before this phase existed. `stop()` is the other door, via
   * {@link stopWarmup} directly.
   */
  private armWarmupSweep(): void {
    if (!this.started || this.warmupDeadline === undefined || this.now() >= this.warmupDeadline) {
      this.warmupTimer = undefined;
      this.warmupDeadline = undefined;
      return;
    }
    this.warmupTimer = this.scheduler.schedule(WATCHER_WARMUP_SWEEP_INTERVAL_MS, () => {
      this.warmupTimer = undefined;
      void this.sweep('prefiltered', 'warmup-sweep')
        .catch(() => this.recordSweepFailure('warmup-sweep'))
        .finally(() => this.armWarmupSweep());
    });
  }

  /** Cancel the warm-up phase, if one is running. Idempotent. */
  private stopWarmup(): void {
    this.warmupTimer?.cancel();
    this.warmupTimer = undefined;
    this.warmupDeadline = undefined;
  }

  /**
   * Record a failed background sweep — or deliberately stay quiet (ISS-361, gh#72's sibling gh#71).
   *
   * THE ASYMMETRY THIS CLOSES. A watcher-driven pass that rejects records a
   * failure ({@link onFileChanges}); a sweep that rejected used to swallow the
   * rejection whole, so the fallback lane — the one that exists precisely for
   * when the watcher is not delivering — could fail every five minutes with
   * nothing anywhere saying so. That is the worst of the options gh#71 lists.
   *
   * WHY A FOREIGN LOCK IS THE ONE CASE THAT STAYS SILENT, AND WHY THAT IS NOT
   * THE OLD SWALLOWING. Read-only is ALREADY reported, and by a better channel:
   * `state()` derives `stale`/`foreign-writer` from `store.lifecycle().readOnly`
   * fresh on every call, and the status bar renders it as "another process owns
   * the index, so this window is read-only". Recording a failure on top would
   * REPLACE that accurate report with a worse one — `failed` means "recovery
   * REFUSED" (see `IndexStaleReason`'s own doc), a strictly stronger and wrong
   * claim about a window that is merely not the writer. The silence here is a
   * deferral to an existing, more precise indicator, not an absence of one.
   *
   * `extraction-failed` IS THE HONEST CODE FOR THE REST. `IndexFailureCode` is
   * closed and has no lock member; the sweep's remaining failure modes are the
   * same read/extract work the watcher lane already reports under that code.
   */
  private recordSweepFailure(trigger: MaintenanceTrigger): void {
    const state = this.session.state();
    if (state.state === 'stale' && state.staleReason === 'foreign-writer') {
      return;
    }
    this.session.recordFailure({
      code: 'extraction-failed',
      incidentId: `${trigger}-${this.now()}`,
      occurrences: 1
    });
  }

  private armSweep(): void {
    this.sweepTimer?.cancel();
    const ttl = this.readConfig().fallbackTtlMs;
    this.sweepTimer = this.scheduler.schedule(ttl, () => {
      this.sweepTimer = undefined;
      void this.enqueue(() => this.runSweep('prefiltered', 'ttl-sweep'))
        .catch(() => this.recordSweepFailure('ttl-sweep'))
        .finally(() => {
          if (this.started) {
            this.armSweep();
          }
        });
    });
  }

  // ---- the passes --------------------------------------------------------

  /** Read the two workspace-level files every pass needs to classify anything. */
  private async readContext(): Promise<{ types: EffectiveEntityType[]; chapters: ManifestChapter[] }> {
    const [typesFile, manifestFile] = await Promise.all([
      this.source.read(ENTITY_TYPES_PATH),
      this.source.read(MANIFEST_PATH)
    ]);
    return {
      types: resolveEffectiveEntityTypes(typesFile?.text).types,
      chapters: extractManifestChapters(manifestFile?.text).chapters
    };
  }

  private async runChanges(
    changes: readonly NarrativeFileChange[],
    trigger: MaintenanceTrigger
  ): Promise<MaintenanceOutcome> {
    const { types, chapters } = await this.readContext();
    const folded = foldFileChanges(changes);

    // Read every ADD that the index could conceivably hold. It has to be read
    // anyway to be extracted, and its hash is the pairing key (ОВ-3 step 2).
    const addedFiles: IndexableFile[] = [];
    const unreadable: string[] = [];
    for (const path of folded.added) {
      if (!isIndexablePath(path, types)) {
        continue;
      }
      const file = await this.source.read(path);
      if (file === undefined) {
        unreadable.push(path);
        continue;
      }
      addedFiles.push(file);
    }

    // A delete's hash comes from the row that is still there (ОВ-3 step 3).
    const deletedDocuments = folded.deleted
      .map(path => this.session.documentOf(path))
      .filter((document): document is NonNullable<typeof document> => document !== undefined);

    const pairing = pairMovedDocuments(deletedDocuments, addedFiles);

    const upsert = [...pairing.unpairedAdds];
    for (const path of folded.updated) {
      if (!isIndexablePath(path, types)) {
        continue;
      }
      const file = await this.source.read(path);
      if (file === undefined) {
        // Gone, or unreadable. If the index still holds it and the file is not
        // on disk any more, the honest answer is a removal; if it is on disk and
        // simply would not open, that is `partial-update-failed` (ОВ-6).
        unreadable.push(path);
        continue;
      }
      upsert.push(file);
    }

    // WHAT REALLY CHANGED, AND THE ESCALATION DECIDED FROM THAT, NOT FROM WHAT
    // WAS REPORTED. A watcher event is not proof a byte moved: an editor that
    // writes on a timer, a `touch`, a `git checkout` restoring identical
    // content all deliver one. Deciding escalation from the reported set would
    // rebuild the whole manuscript because somebody saved a card without
    // editing it.
    const changed = this.changedOnly(upsert);

    // Only the RESIDUAL changes can force a rebuild. A paired move never does:
    // its bytes are identical, so nothing workspace-level can have shifted.
    const residual = [
      ...changed.map(file => file.path),
      ...pairing.unpairedDeletes
    ];
    if (residual.some(path => changeForcesRebuild(path, types))) {
      return { kind: 'rebuild', trigger, report: await this.fullRebuild() };
    }

    const plan: IndexUpdatePlan = {
      moves: pairing.moves,
      upsert,
      remove: pairing.unpairedDeletes,
      types,
      chapters,
      unreadable
    };
    return { kind: 'update', trigger, report: this.session.applyUpdate(plan, { indexedAt: this.now() }).data };
  }

  private async runSweep(
    mode: 'prefiltered' | 'hash-authoritative',
    trigger: MaintenanceTrigger
  ): Promise<MaintenanceOutcome> {
    const { types, chapters } = await this.readContext();
    const stats = await this.source.stat();
    const indexed = new Map(this.session.documents().map(document => [document.relPath, document]));

    const onDisk = new Set<string>();
    const candidates: string[] = [];
    for (const stat of stats) {
      const path = normalizeWorkspacePath(stat.path);
      if (!isIndexablePath(path, types)) {
        continue;
      }
      onDisk.add(path);
      const previous = indexed.get(path);
      if (previous === undefined) {
        candidates.push(path);
        continue;
      }
      if (mode === 'hash-authoritative') {
        // NO PREFILTER. This is the whole difference between the two sweeps, and
        // ОВ-1's teeth C1/C2 are a matched pair about precisely this line.
        candidates.push(path);
        continue;
      }
      if (previous.sizeBytes !== stat.sizeBytes || previous.mtimeMs !== stat.mtimeMs) {
        candidates.push(path);
      }
    }

    const upsert: IndexableFile[] = [];
    const unreadable: string[] = [];
    for (const path of candidates) {
      const file = await this.source.read(path);
      if (file === undefined) {
        unreadable.push(path);
        continue;
      }
      upsert.push(file);
    }

    const remove = [...indexed.keys()].filter(path => !onDisk.has(path));

    // A sweep that finds a CHANGED CARD is in the same position as a watcher
    // batch that does: resolvedness is workspace-level, so it escalates. The
    // files are already in hand, which is why `fullRebuild` re-reads rather than
    // being handed them — a hash-authoritative sweep has read everything, but a
    // prefiltered one has not, and one code path that is right beats two that
    // diverge.
    //
    // THE DECISION IS OVER WHAT CHANGED, NOT OVER WHAT WAS READ, and getting
    // that wrong is not a subtlety: the hash-authoritative sweep reads EVERY
    // file by definition, so a check over the read set escalates ALWAYS — every
    // recovery from `watcher-lost` would silently be a full rebuild, and ОВ-1's
    // tooth C1, which asks which documents an INCREMENT re-indexed, would come
    // back empty on a green-looking system. It did exactly that here.
    const changed = this.changedOnly(upsert);
    const forcing = [...changed.map(file => file.path), ...remove];
    if (forcing.some(path => changeForcesRebuild(path, types))) {
      return { kind: 'rebuild', trigger, report: await this.fullRebuild() };
    }

    const plan: IndexUpdatePlan = { moves: [], upsert, remove, types, chapters, unreadable };
    return { kind: 'update', trigger, report: this.session.applyUpdate(plan, { indexedAt: this.now() }).data };
  }

  /**
   * The files whose bytes really differ from the row already indexed.
   *
   * HASH-AUTHORITATIVE, because every file here has already been read — the
   * prefilter exists to avoid reads and there is no read left to avoid. This is
   * the same rule `applyUpdate` applies one layer down; it is repeated here
   * because the ESCALATION decision needs the answer BEFORE the write path sees
   * it, and a rebuild triggered by an unchanged file is the expensive kind of
   * wrong.
   */
  private changedOnly(files: readonly IndexableFile[]): IndexableFile[] {
    return files.filter(file =>
      documentNeedsReindex(this.session.documentOf(file.path), file, { hashAuthoritative: true })
    );
  }

  private async fullRebuild(): Promise<NarrativeRebuildReport> {
    return this.session.rebuild(await this.source.readAll(), { indexedAt: this.now() }).data;
  }

  /**
   * Present a possibly-escalated outcome as an update report.
   *
   * THE ESCALATION IS NOT HIDDEN: `mode: 'rebuild'` travels, and the counts are
   * the rebuild's real ones. A caller that wanted to know whether its one-file
   * edit cost a whole rebuild can find out, which is the only reason the field
   * exists.
   */
  private asUpdateEnvelope(outcome: MaintenanceOutcome): Envelope<NarrativeUpdateReport> {
    if (outcome.kind === 'update') {
      return { state: this.session.state(), data: outcome.report };
    }
    const report = outcome.report;
    return {
      state: this.session.state(),
      data: {
        mode: 'rebuild',
        // EMPTY BY CONSTRUCTION, NOT BY OMISSION. A full rebuild re-extracts
        // every document and reports COUNTS, not identities, so there is no
        // honest per-document list to put here — and inventing one from
        // `listDocuments` would say "these were reindexed" about rows that
        // happen to exist. `mode` is what a caller reads, and the rebuild's own
        // report travels verbatim below.
        documentsReindexed: [],
        documentsRemoved: [],
        documentsMoved: [],
        unchangedDocuments: report.unchangedDocuments,
        mentionsWritten: report.mentions,
        derivedRelations: report.derivedRelations,
        unreadableDocuments: [],
        rebuild: report
      }
    };
  }
}
