import { injectable, ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { ConnectionHandler } from '@theia/core/lib/common/messaging/handler';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { LocalizationContribution } from '@theia/core/lib/node/i18n/localization-contribution';
import {
  LocalAiConnectionService,
  LocalAiConnectionServicePath,
  LocalAiStreamClient
} from '../common';
import { NodeLocalAiConnectionService } from './node-local-ai-connection-service';
import { AiConnectRuLocalizationContribution } from './i18n/ai-connect-ru-localization-contribution';

@injectable()
export class AiConnectBackendContribution implements BackendApplicationContribution {
  onStart(): void {}
}

/**
 * Backend module of the reusable ai-connect Theia extension: binds the local
 * (in-process) ai-connect transport service and its JSON-RPC connection
 * handler, plus the package's own ru localization bundle.
 */
export default new ContainerModule(bind => {
  bind(NodeLocalAiConnectionService).toSelf().inSingletonScope();
  bind(LocalAiConnectionService).toService(NodeLocalAiConnectionService);
  bind(ConnectionHandler).toDynamicValue(ctx =>
    new RpcConnectionHandler<LocalAiStreamClient>(LocalAiConnectionServicePath, client => {
      const service = ctx.container.get<NodeLocalAiConnectionService>(NodeLocalAiConnectionService);
      service.addClient(client);
      return service;
    })
  ).inSingletonScope();
  bind(BackendApplicationContribution).to(AiConnectBackendContribution).inSingletonScope();
  bind(AiConnectRuLocalizationContribution).toSelf().inSingletonScope();
  bind(LocalizationContribution).toService(AiConnectRuLocalizationContribution);
});
