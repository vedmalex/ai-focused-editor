import { BackendApplicationContribution } from '@theia/core/lib/node';
import { injectable, ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import {
  BookBuildService,
  BookBuildServicePath,
  GitHistoryService,
  GitHistoryServicePath,
  LocalAiConnectionService,
  LocalAiConnectionServicePath
} from '../common';
import { NodeBookBuildService } from './node-book-build-service';
import { NodeGitHistoryService } from './node-git-history-service';
import { NodeLocalAiConnectionService } from './node-local-ai-connection-service';

@injectable()
export class ManuscriptWorkspaceBackendContribution implements BackendApplicationContribution {
  onStart(): void {
    // Backend service registration will live here once workspace scanning moves off the frontend.
  }
}

export default new ContainerModule(bind => {
  bind(NodeLocalAiConnectionService).toSelf().inSingletonScope();
  bind(LocalAiConnectionService).toService(NodeLocalAiConnectionService);
  bind(NodeGitHistoryService).toSelf().inSingletonScope();
  bind(GitHistoryService).toService(NodeGitHistoryService);
  bind(NodeBookBuildService).toSelf().inSingletonScope();
  bind(BookBuildService).toService(NodeBookBuildService);
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(LocalAiConnectionServicePath, () =>
      ctx.container.get(LocalAiConnectionService)
    )
  ).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(GitHistoryServicePath, () =>
      ctx.container.get(GitHistoryService)
    )
  ).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(BookBuildServicePath, () =>
      ctx.container.get(BookBuildService)
    )
  ).inSingletonScope();
  bind(BackendApplicationContribution).to(ManuscriptWorkspaceBackendContribution).inSingletonScope();
});
