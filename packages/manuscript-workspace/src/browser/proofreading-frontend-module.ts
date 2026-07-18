import '../../src/browser/style/index.css';
import URI from '@theia/core/lib/common/uri';
import {
  CommandContribution,
  MenuContribution
} from '@theia/core/lib/common';
import {
  NavigatableWidgetOptions,
  OpenHandler,
  WidgetFactory
} from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { ProofreadingWidget } from './proofreading-widget';
import { ProofreadingAiService } from './proofreading-ai-service';
import {
  ProofreadingCommandContribution,
  ProofreadingOpenHandler
} from './proofreading-open-handler';

/**
 * Standalone frontend module for the two/three-pane Proofreading editor.
 *
 * Registered as an additional `theiaExtensions` frontend entry (the
 * excalidraw / entity-editor pattern) so it stays isolated from
 * `manuscript-workspace-frontend-module.ts` while the two evolve in parallel.
 */
export default new ContainerModule(bind => {
  // AI orchestration for the four proofreading actions (reused by the widget).
  bind(ProofreadingAiService).toSelf().inSingletonScope();

  // Transient: the WidgetManager caches one widget per proofset URI.
  bind(ProofreadingWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ProofreadingWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(ProofreadingWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(ProofreadingOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(ProofreadingOpenHandler);

  bind(ProofreadingCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ProofreadingCommandContribution);
  bind(MenuContribution).toService(ProofreadingCommandContribution);
});
