/**
 * Frontend-side sink of the backend's `onIndexChanged` push (TASK-022
 * UR-043). Bound to {@link NarrativeIndexChangeWatcher} (the common-declared
 * DI symbol) in `narrative-knowledge-frontend-module.ts`, and handed as the
 * `target` argument to `ServiceConnectionProvider.createProxy` for the SAME
 * RPC path `NarrativeKnowledgeService` already proxies — one connection, one
 * channel, two directions.
 *
 * SAME SHAPE AS `GitWatcher` (`theia-git-fork/src/common/git-watcher.ts`),
 * deliberately: a class implementing the RPC-invoked client method under one
 * name and re-firing it through a LOCAL `Emitter` under a different public
 * name, because a single identifier cannot be both an RPC method the proxy
 * factory dispatches to and a plain `Event` property a widget subscribes to.
 */

import { injectable } from '@theia/core/shared/inversify';
import { Disposable, DisposableCollection, Emitter, type Event } from '@theia/core/lib/common';
import type {
  NarrativeIndexChangedEvent,
  NarrativeKnowledgeServiceClient
} from '../common/narrative-knowledge-protocol';
import type { NarrativeIndexChangeWatcher as NarrativeIndexChangeWatcherInterface } from '../common/narrative-index-change-watcher';

@injectable()
export class BrowserNarrativeIndexChangeWatcher
  implements NarrativeIndexChangeWatcherInterface, NarrativeKnowledgeServiceClient, Disposable {
  private readonly toDispose = new DisposableCollection();
  private readonly onIndexChangedEmitter = new Emitter<NarrativeIndexChangedEvent>();

  constructor() {
    this.toDispose.push(this.onIndexChangedEmitter);
  }

  dispose(): void {
    this.toDispose.dispose();
  }

  get onDidIndexChange(): Event<NarrativeIndexChangedEvent> {
    return this.onIndexChangedEmitter.event;
  }

  /** Invoked BY THE RPC FRAMEWORK when the backend pushes — never called
   *  directly by application code, which subscribes to {@link onDidIndexChange}
   *  instead. */
  onIndexChanged(event: NarrativeIndexChangedEvent): void {
    this.onIndexChangedEmitter.fire(event);
  }
}
