import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { CliContribution } from '@theia/core/lib/node';
import {
  NarrativeKnowledgeService,
  NarrativeKnowledgeServicePath
} from '../common';
import { NodeNarrativeKnowledgeService } from './node-narrative-knowledge-service';
import { NarrativeMemoryConfigResolver } from './narrative-memory-config-resolver';
import { NarrativeKnowledgeCliContribution } from './narrative-knowledge-cli-contribution';
import { NarrativeIndexStoreRegistry } from './narrative-index-store-registry';

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

  bind(NodeNarrativeKnowledgeService).toSelf().inSingletonScope();
  bind(NarrativeKnowledgeService).toService(NodeNarrativeKnowledgeService);
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(NarrativeKnowledgeServicePath, () =>
      ctx.container.get(NarrativeKnowledgeService)
    )
  ).inSingletonScope();
});
