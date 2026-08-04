import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { BackendApplicationContribution, CliContribution } from '@theia/core/lib/node';
import { FileSystemWatcherService } from '@theia/filesystem/lib/common/filesystem-watcher-protocol';
import { FileSystemWatcherServiceDispatcher } from '@theia/filesystem/lib/node/filesystem-watcher-dispatcher';
import {
  NarrativeKnowledgeService,
  NarrativeKnowledgeServicePath
} from '../common';
import { NodeNarrativeKnowledgeService } from './node-narrative-knowledge-service';
import { NarrativeMemoryConfigResolver } from './narrative-memory-config-resolver';
import { NarrativeKnowledgeCliContribution } from './narrative-knowledge-cli-contribution';
import { NarrativeIndexStoreRegistry } from './narrative-index-store-registry';
import { TheiaNarrativeFileWatcher } from './theia-narrative-file-watcher';

/**
 * Backend module: binds the node service and exposes it over RPC on
 * {@link NarrativeKnowledgeServicePath}. The frontend module binds the
 * matching proxy on the same path — the two together are the round-trip WP-0
 * has to prove in the browser and the electron target alike.
 */
export default new ContainerModule(bind => {
  // Configuration (WP-3, ОВ-9а). The CLI contribution's `setArguments` runs
  // before `initialize()`, so the flags reach the resolver before anything can
  // ask it for a value — the same ordering `BrowserAuthCliContribution` relies
  // on in the manuscript workspace package.
  bind(NarrativeMemoryConfigResolver).toSelf().inSingletonScope();
  bind(NarrativeKnowledgeCliContribution).toSelf().inSingletonScope();
  bind(CliContribution).toService(NarrativeKnowledgeCliContribution);

  // One database per workspace root, bounded by an LRU (ОВ-4 Б). Built by hand
  // rather than by `toSelf()` so it receives the SINGLETON resolver above; a
  // parameterless construction would silently build a second one and the CLI
  // flags would then apply to a resolver nobody reads.
  bind(NarrativeIndexStoreRegistry)
    .toDynamicValue(ctx => new NarrativeIndexStoreRegistry({
      resolver: ctx.container.get(NarrativeMemoryConfigResolver)
    }))
    .inSingletonScope();

  // The service, with the watcher factory filled in (WP-4b). The factory is a
  // property rather than a constructor parameter because `@injectable()` +
  // `@inject()` field injection is how the rest of this class is built, and a
  // constructor would have to repeat every one of those bindings by hand.
  //
  // THE WATCHER GOES THROUGH THE DISPATCHER, NOT THROUGH `setClient`.
  // `FileSystemWatcherService` is an `RpcServer` with exactly one client, and
  // Theia's own filesystem backend module has already set it to the dispatcher.
  // Calling `setClient` here would REPLACE it and stop file events for every
  // other consumer in the application; `registerClient` is what the dispatcher
  // exists for.
  bind(NodeNarrativeKnowledgeService)
    .toDynamicValue(ctx => {
      const service = ctx.container.resolve(NodeNarrativeKnowledgeService);
      service.createWatcher = rootPath =>
        new TheiaNarrativeFileWatcher({
          watcherService: ctx.container.get(FileSystemWatcherService),
          dispatcher: ctx.container.get(FileSystemWatcherServiceDispatcher),
          rootPath
        });
      return service;
    })
    .inSingletonScope();
  bind(NarrativeKnowledgeService).toService(NodeNarrativeKnowledgeService);

  // SHUTDOWN, AND IT IS NOT HOUSEKEEPING (WP-4b). Before this work package the
  // only thing leaked at exit was the writer lock, which the 30-second
  // stale-lock takeover reclaims on its own. A maintainer leaks two things that
  // NOTHING reclaims: a live watcher registration in the dispatcher and a
  // fallback sweep timer that re-arms itself forever. `onStop` is the hook the
  // backend application already calls, and `dispose()` — which WP-4a wrote and
  // left with no caller — is what it calls.
  bind(BackendApplicationContribution).toDynamicValue(ctx => ({
    onStop: () => ctx.container.get(NodeNarrativeKnowledgeService).dispose()
  }));
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(NarrativeKnowledgeServicePath, () =>
      ctx.container.get(NarrativeKnowledgeService)
    )
  ).inSingletonScope();
});
