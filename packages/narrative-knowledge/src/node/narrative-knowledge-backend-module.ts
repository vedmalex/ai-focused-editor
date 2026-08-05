import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { BackendApplicationContribution, CliContribution } from '@theia/core/lib/node';
import { LocalizationContribution } from '@theia/core/lib/node/i18n/localization-contribution';
import { FileSystemWatcherService } from '@theia/filesystem/lib/common/filesystem-watcher-protocol';
import { FileSystemWatcherServiceDispatcher } from '@theia/filesystem/lib/node/filesystem-watcher-dispatcher';
import {
  NarrativeKnowledgeService,
  NarrativeKnowledgeServicePath,
  type NarrativeKnowledgeServiceClient
} from '../common';
import { NodeNarrativeKnowledgeService } from './node-narrative-knowledge-service';
import { NarrativeMemoryConfigResolver } from './narrative-memory-config-resolver';
import { NarrativeKnowledgeCliContribution } from './narrative-knowledge-cli-contribution';
import { NarrativeIndexStoreRegistry } from './narrative-index-store-registry';
import { TheiaNarrativeFileWatcher } from './theia-narrative-file-watcher';
import { NarrativeMemoryRuLocalizationContribution } from './i18n/narrative-memory-ru-localization-contribution';

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
  // BUILT BY HAND, NOT `toSelf()` — and this is a repair, found by WP-5 when it
  // first started the real backend (`scripts/browser-smoke.mjs`) rather than a
  // test double.
  //
  // `NarrativeMemoryConfigResolver`'s constructor takes ONE OPTIONAL options
  // object. Under `emitDecoratorMetadata` TypeScript records that parameter's
  // design type as `Object`, and `toSelf()` makes inversify try to RESOLVE it:
  //
  //   Error: No matching bindings found for serviceIdentifier: Object
  //   Trying to resolve bindings for "NarrativeMemoryConfigResolver"
  //
  // Optionality lives in the language, not in the metadata, so a default value
  // does not save it. The throw came at backend startup, from the first thing
  // that injects the resolver (`NarrativeKnowledgeCliContribution`), and it
  // took THIS WHOLE MODULE DOWN with it — no RPC handler, no localization, no
  // index. Nothing in `verify` saw it: every test either constructs the class
  // directly or hands the service a resolver by field assignment, and the
  // container is only assembled when an application boots.
  //
  // `toDynamicValue` is the same shape the registry below is bound with, for a
  // neighbouring reason, and it needs no new decorator on a class that is
  // deliberately constructible without a container.
  bind(NarrativeMemoryConfigResolver)
    .toDynamicValue(() => new NarrativeMemoryConfigResolver())
    .inSingletonScope();
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
  // `toSelf()` + `onActivation`, NOT `toDynamicValue(ctx => ctx.container.resolve(...))`
  // — a repair, found by WP-5 when it first started the real backend.
  //
  // `Container.resolve(C)` INSTANTIATES `C` THROUGH `C`'s OWN BINDING when one
  // exists in that container. Naming the identifier being bound inside its own
  // `toDynamicValue` factory is therefore a self-reference, and inversify says
  // so in words that point at the wrong thing:
  //
  //   Error: You are attempting to construct Symbol(NarrativeKnowledgeService)
  //     in a synchronous way but it has asynchronous dependencies.
  //   Error: It looks like there is a circular dependency in one of the
  //     'toDynamicValue' bindings ... 'class NodeNarrativeKnowledgeService'
  //
  // There is no async dependency and no cycle between two classes; the message
  // is inversify's generic report for a factory that threw. The consequence was
  // total and silent: `ConnectionHandler`'s factory does the same synchronous
  // `get`, so the RPC target came back broken and every frontend call died with
  // `TypeError: this.target[method] is not a function` — no index, no status
  // bar, no round trip. `bun run verify` stayed EXIT 0 throughout, because it
  // never starts an application (that is `verify:full`).
  //
  // `onActivation` attaches the factory to the ONE instance the container
  // builds, whoever asks for it first — including the `onStop` binding below,
  // which is otherwise a way to get a watcher-less service by asking in an
  // unlucky order.
  //
  // The factory is a property rather than a constructor parameter because
  // `@injectable()` + `@inject()` field injection is how the rest of this class
  // is built, and a constructor would have to repeat every one of those
  // bindings by hand.
  bind(NodeNarrativeKnowledgeService)
    .toSelf()
    .inSingletonScope()
    .onActivation((ctx, service) => {
      service.createWatcher = rootPath =>
        new TheiaNarrativeFileWatcher({
          watcherService: ctx.container.get(FileSystemWatcherService),
          dispatcher: ctx.container.get(FileSystemWatcherServiceDispatcher),
          rootPath
        });
      return service;
    });
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
  // UR-043. The TARGET returned here is still the ONE singleton service every
  // connection has always shared — that part is unchanged. What is new is the
  // per-connection CLIENT parameter `RpcConnectionHandler` already hands this
  // factory on every incoming connection: subscribing to the service's
  // `onIndexChanged` Event HERE, once per connection, and pushing to THAT
  // connection's own `client` is what turns one shared backend signal into a
  // push every open window receives — `setClient` could not do this (see
  // `NodeNarrativeKnowledgeService.onIndexChanged`'s own doc: it REPLACES the
  // one client it remembers, which is wrong the moment UR-041 allows more
  // than one window against the same backend). `client.onDidCloseConnection`
  // disposing the subscription is the other half of UR-043's own boundary —
  // a live subscription outlasting its connection is exactly the shape of
  // leak ISS-359 already found once in this package
  // (`TheiaNarrativeFileWatcher.dispose()` with no caller).
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler<NarrativeKnowledgeServiceClient>(NarrativeKnowledgeServicePath, client => {
      const service = ctx.container.get<NodeNarrativeKnowledgeService>(NodeNarrativeKnowledgeService);
      const subscription = service.onIndexChanged(event => client.onIndexChanged(event));
      client.onDidCloseConnection(() => subscription.dispose());
      return service;
    })
  ).inSingletonScope();

  // The package's own Russian bundle (WP-5). WP-1 wrote the file and the tooth
  // that walks it; this is the line that makes it a translation rather than a
  // JSON file nobody reads. Registered on the BACKEND because that is where
  // Theia collects localizations before shipping them to the frontend.
  bind(NarrativeMemoryRuLocalizationContribution).toSelf().inSingletonScope();
  bind(LocalizationContribution).toService(NarrativeMemoryRuLocalizationContribution);
});
