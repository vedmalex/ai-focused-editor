/**
 * Theia's backend watcher behind {@link NarrativeFileWatcher} (TASK-022 WP-4b).
 *
 * WHY IT ROUTES THROUGH `FileSystemWatcherServiceDispatcher` AND NOT THROUGH
 * `setClient`. `FileSystemWatcherService` is an `RpcServer` with exactly ONE
 * client, and Theia's own backend module has already set it — to the dispatcher
 * (`filesystem-backend-module.js`, both the single-threaded and the spawned
 * branch call `server.setClient(dispatcher)` / `serverProxy.setClient(dispatcher)`).
 * Calling `setClient` from here would REPLACE it and silently stop every other
 * consumer of file events in the application. The dispatcher exists precisely to
 * multiplex, keyed by a `clientId`, and `registerClient` is the supported way in.
 *
 * WHAT THE PROTOCOL GIVES AND WHAT IT DOES NOT. `FileChange { uri, type }` with
 * `FileChangeType = UPDATED(0) | ADDED(1) | DELETED(2)` — and NO RENAME. That
 * absence is the whole reason tech_spec ОВ-3 exists: a move has to be inferred
 * from a delete/add pair whose `content_hash` matches, and this adapter's job
 * ends at delivering both halves into one debounce window.
 *
 * `onError` IS THE ONLY INPUT TO `watcher-lost`, and it is real: the watcher can
 * die, and on Linux it can fail to start at all against the inotify handle
 * limit. Without subscribing to it the index would go on answering as `ready`
 * while changes arrived unseen — the exact failure `stale` was added for.
 *
 * NOT EXERCISED BY ANY TEST IN THIS REPOSITORY, AND SAID SO HERE RATHER THAN
 * DISCOVERED LATER. Running it needs an Inversify container, a spawned parcel
 * watcher process and a real directory, none of which the node lane has. What IS
 * exercised, in both lanes and against both store adapters, is everything
 * downstream of the port: coalescing, the guard, the pairing, the sweeps. The
 * risk this file carries is therefore narrow and nameable — that `clientId`
 * registration or the URI-to-relative-path conversion is wrong — and it would
 * show up as an index that never updates, not as a wrong index.
 */

import { relative, sep } from 'node:path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import {
  FileSystemWatcherService,
  type DidFilesChangedParams
} from '@theia/filesystem/lib/common/filesystem-watcher-protocol';
import { FileChangeType } from '@theia/filesystem/lib/common/files';
import { FileSystemWatcherServiceDispatcher } from '@theia/filesystem/lib/node/filesystem-watcher-dispatcher';
import type {
  NarrativeDisposable,
  NarrativeFileChange,
  NarrativeFileChangeType,
  NarrativeFileWatcher,
  NarrativeWatcherFailure
} from '../common';
import { NARRATIVE_SCAN_SKIPPED_DIRECTORIES } from './narrative-workspace-scan';

/** Client ids are per-process and only have to be unique within it. */
let nextClientId = 1;

export interface TheiaNarrativeFileWatcherOptions {
  watcherService: FileSystemWatcherService;
  dispatcher: FileSystemWatcherServiceDispatcher;
  /** Absolute path of the workspace root this watcher covers. */
  rootPath: string;
}

export class TheiaNarrativeFileWatcher implements NarrativeFileWatcher {
  private readonly changeListeners = new Set<(changes: readonly NarrativeFileChange[]) => void>();
  private readonly failListeners = new Set<(failure: NarrativeWatcherFailure) => void>();
  private readonly clientId = nextClientId++;
  private readonly options: TheiaNarrativeFileWatcherOptions;
  private watcherId: number | undefined;
  private disposed = false;
  /** See {@link whenReady}. Settles once, whichever way `watchFileChanges`
   *  goes — a rejection is reported through {@link emitFailure} already; it is
   *  not repeated as a rejection here (ISS-360 tooth: `whenReady()` is a
   *  TIMING signal for the warm-up sweep, not a second failure channel). */
  private readonly readyPromise: Promise<void>;

  constructor(options: TheiaNarrativeFileWatcherOptions) {
    this.options = options;
    options.dispatcher.registerClient(this.clientId, {
      onDidFilesChanged: (event: DidFilesChangedParams) => this.onDidFilesChanged(event),
      // The protocol's client-side `onError` takes no argument. There is nothing
      // to carry: ОВ-6 closes the stale reasons at three, so a richer message
      // could only be discarded one layer up.
      onError: () => this.emitFailure('the file watcher reported an error')
    });
    this.readyPromise = options.watcherService
      .watchFileChanges(this.clientId, FileUri.create(options.rootPath).toString(), {
        // The same skip list the walk uses. Watching `node_modules` or the
        // `.theia` directory that HOLDS THE INDEX DATABASE would make the index
        // an input to itself — every commit would produce a change event for the
        // `-wal` file and re-arm the debounce window forever.
        ignored: NARRATIVE_SCAN_SKIPPED_DIRECTORIES.map(directory => `**/${directory}/**`)
      })
      .then(id => {
        this.watcherId = id;
        if (this.disposed) {
          void options.watcherService.unwatchFileChanges(id);
        }
      })
      .catch(() => {
        // A watcher that never starts is exactly `watcher-lost`: on Linux this
        // is the inotify handle limit, and reporting it as anything softer would
        // let the index claim a freshness it cannot have for the whole session.
        this.emitFailure('the file watcher could not be started');
      });
  }

  /**
   * Resolves once `watchFileChanges()`'s own promise has settled — the
   * EARLIEST signal this adapter has, and, per ISS-360's measurement, NOT
   * proof that events are flowing yet: a live application showed the spawned
   * parcel watcher start delivering changes up to sixteen measured seconds
   * AFTER this resolves. `NarrativeIndexMaintainer` treats this resolution as
   * "start the warm-up phase", not "trust the watcher" — the warm-up sweep
   * cadence is what actually covers the remaining gap.
   */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  onDidChangeFiles(listener: (changes: readonly NarrativeFileChange[]) => void): NarrativeDisposable {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  onDidFail(listener: (failure: NarrativeWatcherFailure) => void): NarrativeDisposable {
    this.failListeners.add(listener);
    return { dispose: () => this.failListeners.delete(listener) };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.options.dispatcher.unregisterClient(this.clientId);
    if (this.watcherId !== undefined) {
      void this.options.watcherService.unwatchFileChanges(this.watcherId);
    }
    this.changeListeners.clear();
    this.failListeners.clear();
  }

  /**
   * Convert one Theia batch into the port's vocabulary.
   *
   * A change OUTSIDE this workspace root is dropped rather than relativized: a
   * `../` path is not a document identity in this index, and forwarding one
   * would put a row in the store keyed by something no walk will ever produce.
   */
  private onDidFilesChanged(event: DidFilesChangedParams): void {
    const changes: NarrativeFileChange[] = [];
    for (const change of event.changes) {
      const fsPath = FileUri.fsPath(change.uri);
      const relPath = relative(this.options.rootPath, fsPath).split(sep).join('/');
      if (relPath === '' || relPath.startsWith('../')) {
        continue;
      }
      changes.push({ path: relPath, type: toChangeType(change.type) });
    }
    if (changes.length === 0) {
      return;
    }
    for (const listener of [...this.changeListeners]) {
      listener(changes);
    }
  }

  private emitFailure(message: string): void {
    for (const listener of [...this.failListeners]) {
      listener({ message });
    }
  }
}

function toChangeType(type: FileChangeType): NarrativeFileChangeType {
  switch (type) {
    case FileChangeType.ADDED:
      return 'added';
    case FileChangeType.DELETED:
      return 'deleted';
    default:
      return 'updated';
  }
}
