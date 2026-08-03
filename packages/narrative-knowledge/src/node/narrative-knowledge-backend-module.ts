import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import {
  NarrativeKnowledgeService,
  NarrativeKnowledgeServicePath
} from '../common';
import { NodeNarrativeKnowledgeService } from './node-narrative-knowledge-service';

/**
 * Backend module: binds the node service and exposes it over RPC on
 * {@link NarrativeKnowledgeServicePath}. The frontend module binds the
 * matching proxy on the same path — the two together are the round-trip WP-0
 * has to prove in the browser and the electron target alike.
 */
export default new ContainerModule(bind => {
  bind(NodeNarrativeKnowledgeService).toSelf().inSingletonScope();
  bind(NarrativeKnowledgeService).toService(NodeNarrativeKnowledgeService);
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(NarrativeKnowledgeServicePath, () =>
      ctx.container.get(NarrativeKnowledgeService)
    )
  ).inSingletonScope();
});
