import { ContainerModule } from '@theia/core/shared/inversify';
import { WidgetFactory } from '@theia/core/lib/browser';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { AiDebugViewContribution } from './ai-debug-view-contribution';
import { AiDebugWidget } from './ai-debug-widget';

/**
 * Standalone frontend module for the AI Debug view (request/context/provider
 * inspection). Registered as its own `theiaExtensions` frontend entry. The
 * manuscript-specific context section is populated by an optional
 * `AiDebugContextProvider` the host application binds.
 */
export default new ContainerModule(bind => {
  bindViewContribution(bind, AiDebugViewContribution);
  bind(AiDebugWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: AiDebugWidget.ID,
    createWidget: () => ctx.container.get(AiDebugWidget)
  })).inSingletonScope();
});
