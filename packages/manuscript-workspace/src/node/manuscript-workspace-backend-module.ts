import { BackendApplicationContribution } from '@theia/core/lib/node';
import { injectable, ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { LocalizationContribution } from '@theia/core/lib/node/i18n/localization-contribution';
import { TaskRunnerContribution } from '@theia/task/lib/node/task-runner';
import { ManuscriptRuLocalizationContribution } from './i18n/manuscript-ru-localization-contribution';
import {
  AiModeRegistryBackendService,
  AiModeRegistryBackendServicePath,
  BookBuildService,
  BookBuildServicePath,
  GitStatusService,
  GitStatusServicePath,
  LocalAiConnectionService,
  LocalAiConnectionServicePath,
  LocalAiStreamClient,
  ManuscriptWorkspaceBackendService,
  ManuscriptWorkspaceBackendServicePath,
  NarrativeEntityBackendService,
  NarrativeEntityBackendServicePath,
  NarrativeGraphBackendService,
  NarrativeGraphBackendServicePath,
  OfficePreviewService,
  OfficePreviewServicePath,
  SourceLibraryBackendService,
  SourceLibraryBackendServicePath,
  YamlSchemaValidator
} from '../common';
import { NodeBookBuildService } from './node-book-build-service';
import { NodeNarrativeGraphService } from './node-narrative-graph-service';
import { NodeGitStatusService } from './node-git-status-service';
import { NodeOfficePreviewService } from './node-office-preview-service';
import { NodeLocalAiConnectionService } from './node-local-ai-connection-service';
import { NodeManuscriptWorkspaceService } from './node-manuscript-workspace-service';
import {
  NodeAiModeRegistryService,
  NodeNarrativeEntityService,
  NodeSourceLibraryService
} from './node-domain-knowledge-service';
import {
  NodeBookBuildTaskRunner,
  NodeBookBuildTaskRunnerContribution
} from './node-book-build-task-runner';

@injectable()
export class ManuscriptWorkspaceBackendContribution implements BackendApplicationContribution {
  onStart(): void {}
}

export default new ContainerModule(bind => {
  bind(NodeLocalAiConnectionService).toSelf().inSingletonScope();
  bind(LocalAiConnectionService).toService(NodeLocalAiConnectionService);
  bind(NodeGitStatusService).toSelf().inSingletonScope();
  bind(GitStatusService).toService(NodeGitStatusService);
  bind(NodeBookBuildService).toSelf().inSingletonScope();
  bind(BookBuildService).toService(NodeBookBuildService);
  bind(NodeBookBuildTaskRunner).toSelf().inSingletonScope();
  bind(NodeBookBuildTaskRunnerContribution).toSelf().inSingletonScope();
  bind(TaskRunnerContribution).toService(NodeBookBuildTaskRunnerContribution);
  bind(YamlSchemaValidator).toSelf().inSingletonScope();
  bind(NodeManuscriptWorkspaceService).toSelf().inSingletonScope();
  bind(ManuscriptWorkspaceBackendService).toService(NodeManuscriptWorkspaceService);
  bind(NodeNarrativeEntityService).toSelf().inSingletonScope();
  bind(NarrativeEntityBackendService).toService(NodeNarrativeEntityService);
  bind(NodeSourceLibraryService).toSelf().inSingletonScope();
  bind(SourceLibraryBackendService).toService(NodeSourceLibraryService);
  bind(NodeAiModeRegistryService).toSelf().inSingletonScope();
  bind(AiModeRegistryBackendService).toService(NodeAiModeRegistryService);
  bind(NodeNarrativeGraphService).toSelf().inSingletonScope();
  bind(NarrativeGraphBackendService).toService(NodeNarrativeGraphService);
  bind(NodeOfficePreviewService).toSelf().inSingletonScope();
  bind(OfficePreviewService).toService(NodeOfficePreviewService);
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler<LocalAiStreamClient>(LocalAiConnectionServicePath, client => {
      const service = ctx.container.get<NodeLocalAiConnectionService>(NodeLocalAiConnectionService);
      service.addClient(client);
      return service;
    })
  ).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(BookBuildServicePath, () =>
      ctx.container.get(BookBuildService)
    )
  ).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(GitStatusServicePath, () =>
      ctx.container.get(GitStatusService)
    )
  ).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(ManuscriptWorkspaceBackendServicePath, () =>
      ctx.container.get(ManuscriptWorkspaceBackendService)
    )
  ).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(NarrativeEntityBackendServicePath, () =>
      ctx.container.get(NarrativeEntityBackendService)
    )
  ).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(SourceLibraryBackendServicePath, () =>
      ctx.container.get(SourceLibraryBackendService)
    )
  ).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(AiModeRegistryBackendServicePath, () =>
      ctx.container.get(AiModeRegistryBackendService)
    )
  ).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(NarrativeGraphBackendServicePath, () =>
      ctx.container.get(NarrativeGraphBackendService)
    )
  ).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(OfficePreviewServicePath, () =>
      ctx.container.get(OfficePreviewService)
    )
  ).inSingletonScope();
  bind(BackendApplicationContribution).to(ManuscriptWorkspaceBackendContribution).inSingletonScope();
  // Registers our ru dictionary (i18n/ru/*.json) with the core localization
  // registry. `languagePack: true` on the descriptor is what makes ru actually
  // apply on the frontend AND surface in 'Configure Display Language'.
  bind(ManuscriptRuLocalizationContribution).toSelf().inSingletonScope();
  bind(LocalizationContribution).toService(ManuscriptRuLocalizationContribution);
});
