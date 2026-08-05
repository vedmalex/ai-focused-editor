/**
 * `NarrativeFileWatcher` — the port the index hears about file changes through
 * (TASK-022 WP-4b, plan "Слои пакета и правило импортов").
 *
 * WHY A PORT AND NOT THE THEIA WATCHER DIRECTLY. Two reasons, and the second is
 * the one the plan states outright ("без порта случай конкурентности
 * невоспроизводим"):
 *
 *   1. LAYER. The event source in production is `FileSystemWatcherService`
 *      (`@theia/filesystem`), which lives on the backend and needs a container,
 *      a child process and a real directory. `src/common` may not import it
 *      (prohibition (a) reaches `node:*` transitively through it, and it is a
 *      backend entrypoint besides). Everything WP-4b decides — coalescing, the
 *      single guard, delete/create pairing, when a sweep runs — is a function of
 *      the CHANGE LIST, not of who produced it.
 *   2. TESTABILITY. The readiness case that matters most here is "an explicit
 *      rebuild arrives while a watcher batch is in flight". A real watcher
 *      cannot be made to deliver an event at a chosen instant; a pusher can, and
 *      {@link TestNarrativeFileWatcher} is that pusher.
 *
 * WHAT THIS PORT DELIBERATELY DOES NOT CARRY. There is NO rename event, and its
 * absence is a FACT about the protocol rather than a simplification here:
 * Theia's watcher emits `FileChange { uri, type }` with
 * `FileChangeType = UPDATED | ADDED | DELETED`
 * (`@theia/filesystem/lib/common/files.d.ts`), and nothing else. A move is
 * therefore something the index INFERS from a delete/add pair inside one
 * debounce window (tech_spec ОВ-3), and giving this port a rename event it
 * cannot receive would make the inference look optional.
 *
 * THERE IS ALSO NO EDITOR HOOK, AND THAT IS THE POINT OF "никакой реакции на
 * клавиши". The index reacts to FILES, not to typing: the only inputs on this
 * interface are a change list and a failure, both of which a filesystem
 * produces. An unsaved buffer is invisible here by construction rather than by
 * a rule somebody has to remember.
 */

/** What happened to one file. The three the watcher protocol can express. */
export type NarrativeFileChangeType = 'added' | 'updated' | 'deleted';

/** One file change, keyed the way the index keys documents. */
export interface NarrativeFileChange {
  /** Workspace-relative POSIX path — the index's document identity. */
  path: string;
  type: NarrativeFileChangeType;
}

/** Undo a subscription. Structural, so a Theia `Disposable` satisfies it. */
export interface NarrativeDisposable {
  dispose(): void;
}

/**
 * Why the watcher stopped being trustworthy.
 *
 * A SINGLE `message`, ON PURPOSE. It becomes `staleReason: 'watcher-lost'` and a
 * log line, never a branch: ОВ-6 closes the list of stale reasons at three, so a
 * richer failure vocabulary here could only be discarded one layer up.
 */
export interface NarrativeWatcherFailure {
  message: string;
}

export interface NarrativeFileWatcher {
  /**
   * Subscribe to batches of file changes.
   *
   * BATCHES, NOT SINGLE EVENTS. Theia's own protocol delivers
   * `DidFilesChangedParams { changes: FileChange[] }`, and the pairing rule of
   * ОВ-3 is defined over a SET — a delete and an add that arrive as two separate
   * calls are still one move if they land in one debounce window, which is why
   * the maintainer accumulates across calls rather than trusting one batch to be
   * complete.
   */
  onDidChangeFiles(listener: (changes: readonly NarrativeFileChange[]) => void): NarrativeDisposable;
  /**
   * Subscribe to watcher failure.
   *
   * This is the ONLY input that produces `stale/watcher-lost`, and the reason
   * that state exists: the watcher can die (`FileSystemWatcherServiceClient.onError`)
   * or never start at all (the Linux inotify handle limit), and in both cases
   * changes go on arriving unseen.
   */
  onDidFail(listener: (failure: NarrativeWatcherFailure) => void): NarrativeDisposable;
  dispose(): void;

  /**
   * Resolves once the underlying subscription is believed to be armed
   * (TASK-022 UR-036 part 2, ISS-360).
   *
   * OPTIONAL, AND ITS ABSENCE IS A CLAIM: "this watcher delivers changes from
   * the moment `onDidChangeFiles` is subscribed, with no arming lag worth
   * covering". That is true of {@link TestNarrativeFileWatcher} (its `push()`
   * is synchronous) and false of the real Theia adapter — measurement against
   * a running application showed the spawned parcel watcher can start
   * delivering events TENS OF SECONDS after `FileSystemWatcherService
   * .watchFileChanges()`'s own promise resolves, and in that gap an edit is
   * lost outright: no subscription is live to see it, and the only thing that
   * would otherwise notice is the fallback sweep on its full, minutes-long TTL.
   *
   * A watcher that can attest to this gap implements it, and
   * `NarrativeIndexMaintainer` uses the resolution as the trigger for a short
   * warm-up reconciliation phase (see `WATCHER_WARMUP_SWEEP_INTERVAL_MS` /
   * `WATCHER_WARMUP_DURATION_MS`) that closes exactly this window — cheaply,
   * through the same prefiltered sweep the routine TTL fallback already runs,
   * not a rebuild.
   */
  whenReady?(): Promise<void>;
}

/**
 * A watcher driven by hand.
 *
 * IT LIVES IN `src/common` AND SHIPS IN `lib`, exactly like the in-memory store
 * adapter, and for the same reason: the contract core that exercises it must run
 * under `bun` AND under `node`, and the node lane imports the built output. A
 * copy under `test/` would be a second implementation nobody runs against the
 * fast lane.
 */
export class TestNarrativeFileWatcher implements NarrativeFileWatcher {
  private readonly changeListeners = new Set<(changes: readonly NarrativeFileChange[]) => void>();
  private readonly failListeners = new Set<(failure: NarrativeWatcherFailure) => void>();
  private disposed = false;

  /**
   * UNSET BY EVERY EXISTING FIXTURE, ON PURPOSE (ISS-360). This double already
   * delivers `push()` synchronously, so it has no "not yet armed" phase to
   * model, and every readiness/timer assertion already written against it
   * (`narrative-index-maintenance-contract.ts`) depends on `start()` arming
   * NOTHING beyond the fallback sweep. A case that specifically wants to
   * exercise the warm-up phase assigns this field to a function BEFORE calling
   * `maintainer.start()` — see the ISS-360 cases in that same contract file.
   */
  whenReady: (() => Promise<void>) | undefined;

  onDidChangeFiles(listener: (changes: readonly NarrativeFileChange[]) => void): NarrativeDisposable {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  onDidFail(listener: (failure: NarrativeWatcherFailure) => void): NarrativeDisposable {
    this.failListeners.add(listener);
    return { dispose: () => this.failListeners.delete(listener) };
  }

  /** Deliver one batch, synchronously, to every subscriber. */
  push(...changes: NarrativeFileChange[]): void {
    for (const listener of [...this.changeListeners]) {
      listener(changes);
    }
  }

  /** Report the watcher as lost. */
  fail(message = 'watcher stopped'): void {
    for (const listener of [...this.failListeners]) {
      listener({ message });
    }
  }

  /** Whether anything is still listening — the assertion `dispose` needs. */
  get listenerCount(): number {
    return this.changeListeners.size + this.failListeners.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.changeListeners.clear();
    this.failListeners.clear();
  }
}
