import '../../src/browser/style/index.css';
import {
  ContainerModule
} from '@theia/core/shared/inversify';
import { CommandContribution, PreferenceContribution } from '@theia/core/lib/common';
import {
  FrontendApplicationContribution,
  WidgetFactory
} from '@theia/core/lib/browser';
import { KeybindingContribution } from '@theia/core/lib/browser/keybinding';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { LanguageModelProvider } from '@theia/ai-core';
import {
  AiConnectionService,
  LocalAiConnectionService,
  LocalAiConnectionServicePath
} from '../common';
import { AiConnectPreferenceContribution } from './ai-connect-preferences';
import { AiConnectTheiaLanguageModel } from './ai-connect-theia-language-model';
import { bindAiConnectAliasModel } from './ai-connect-alias-language-model';
import { AiConnectModelSyncContribution } from './ai-connect-model-sync-contribution';
import { AiConnectDefaultModelsContribution } from './ai-connect-default-models-contribution';
import { BrowserAiConnectionService } from './browser-ai-connection-service';
import { LocalAiStreamClientImpl } from './local-ai-stream-client';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { AiVerificationService } from './ai-verification-service';
import { AiCapabilityService } from './ai-capability-service';
import { AiProfileStatusBarContribution } from './ai-profile-status-bar-contribution';
import { AiHistoryService } from './ai-history-service';
import { AiRequestLogService } from './ai-request-log-service';
import { ModelConfigViewContribution } from './model-config-view-contribution';
import { ModelConfigWidget } from './model-config-widget';
import { AiUsageViewContribution } from './ai-usage-view-contribution';
import { AiUsageWidget } from './ai-usage-widget';
import { AiConnectStreamController } from './ai-connect-stream-controller';
import { AiConnectPauseContribution } from './ai-connect-pause-contribution';

/**
 * Main frontend module of the reusable ai-connect Theia extension: binds the
 * connection transport (local + browser), the LanguageModel registration, the
 * endpoint/alias preference service + verification/history/request-log
 * services, the status bar, the Model Config view, and the aiConnect.*
 * preference schema. Registers commands + views but NO application-menu
 * placement — the host application places the exported commands into its menu.
 */
export default new ContainerModule(bind => {
  bind(LocalAiStreamClientImpl).toSelf().inSingletonScope();
  bind(LocalAiConnectionService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(
      ctx.container,
      LocalAiConnectionServicePath,
      ctx.container.get(LocalAiStreamClientImpl)
    )
  ).inSingletonScope();
  bind(AiConnectionService).to(BrowserAiConnectionService).inSingletonScope();
  bind(AiConnectTheiaLanguageModel).toSelf().inSingletonScope();
  bind(LanguageModelProvider).toDynamicValue(ctx => async () => [
    ctx.container.get(AiConnectTheiaLanguageModel)
  ]).inSingletonScope();
  // One LanguageModel per alias, kept in sync with the alias list.
  bindAiConnectAliasModel(bind);
  bind(AiConnectModelSyncContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(AiConnectModelSyncContribution);
  bind(AiConnectDefaultModelsContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(AiConnectDefaultModelsContribution);
  bind(AiProfilePreferenceService).toSelf().inSingletonScope();
  bind(AiVerificationService).toSelf().inSingletonScope();
  bind(AiCapabilityService).toSelf().inSingletonScope();
  bind(AiHistoryService).toSelf().inSingletonScope();
  bind(AiRequestLogService).toSelf().inSingletonScope();
  bind(AiProfileStatusBarContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(AiProfileStatusBarContribution);
  // Streaming pause: the controller tracks active streams; the contribution
  // exposes the "Pause AI Response" command + keybinding (no menu placement).
  bind(AiConnectStreamController).toSelf().inSingletonScope();
  bind(AiConnectPauseContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AiConnectPauseContribution);
  bind(KeybindingContribution).toService(AiConnectPauseContribution);
  bind(PreferenceContribution).toConstantValue(AiConnectPreferenceContribution);
  bindViewContribution(bind, ModelConfigViewContribution);
  bind(ModelConfigWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ModelConfigWidget.ID,
    createWidget: () => ctx.container.get(ModelConfigWidget)
  })).inSingletonScope();
  // Read-only AI Token Usage report (aggregates the request log). Command
  // `ai-connect.openUsage`; no menu placement — the host application places it.
  bindViewContribution(bind, AiUsageViewContribution);
  bind(AiUsageWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: AiUsageWidget.ID,
    createWidget: () => ctx.container.get(AiUsageWidget)
  })).inSingletonScope();
});
