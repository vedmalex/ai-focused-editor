import { BackendApplicationContribution, CliContribution } from '@theia/core/lib/node';
import { WsRequestValidatorContribution } from '@theia/core/lib/node/ws-request-validators';
import { injectable, ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { LocalizationContribution } from '@theia/core/lib/node/i18n/localization-contribution';
import { TaskRunnerContribution } from '@theia/task/lib/node/task-runner';
import { BrowserAuthConfiguration } from './browser-auth-configuration';
import { BrowserAuthService } from './browser-auth-service';
import { BrowserAuthCliContribution } from './browser-auth-cli-contribution';
import { ManuscriptRuLocalizationContribution } from './i18n/manuscript-ru-localization-contribution';
import {
  AiModeRegistryBackendService,
  AiModeRegistryBackendServicePath,
  BookBuildService,
  BookBuildServicePath,
  GitStatusService,
  GitStatusServicePath,
  ManuscriptWorkspaceBackendService,
  ManuscriptWorkspaceBackendServicePath,
  NarrativeEntityBackendService,
  NarrativeEntityBackendServicePath,
  NarrativeGraphBackendService,
  NarrativeGraphBackendServicePath,
  ObsidianPluginBackendService,
  ObsidianPluginBackendServicePath,
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
import { NodeManuscriptWorkspaceService } from './node-manuscript-workspace-service';
import { NodeObsidianPluginService } from './node-obsidian-plugin-service';
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
  bind(NodeObsidianPluginService).toSelf().inSingletonScope();
  bind(ObsidianPluginBackendService).toService(NodeObsidianPluginService);
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
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler(ObsidianPluginBackendServicePath, () =>
      ctx.container.get(ObsidianPluginBackendService)
    )
  ).inSingletonScope();
  bind(BackendApplicationContribution).to(ManuscriptWorkspaceBackendContribution).inSingletonScope();
  // Optional shared-secret browser-auth gate (DISABLED BY DEFAULT; Electron
  // never gates; localhost is frictionless unless --auth). The single
  // BrowserAuthService instance serves BOTH the HTTP middleware (via
  // BackendApplicationContribution) and the WebSocket-upgrade validator (via
  // WsRequestValidatorContribution) so a session minted over HTTP is honoured
  // on the RPC socket.
  bind(BrowserAuthConfiguration).toSelf().inSingletonScope();
  bind(BrowserAuthService).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(BrowserAuthService);
  bind(WsRequestValidatorContribution).toService(BrowserAuthService);
  bind(BrowserAuthCliContribution).toSelf().inSingletonScope();
  bind(CliContribution).toService(BrowserAuthCliContribution);
  // Registers our ru dictionary (i18n/ru/*.json) with the core localization
  // registry. `languagePack: true` on the descriptor is what makes ru actually
  // apply on the frontend AND surface in 'Configure Display Language'.
  bind(ManuscriptRuLocalizationContribution).toSelf().inSingletonScope();
  bind(LocalizationContribution).toService(ManuscriptRuLocalizationContribution);
});
