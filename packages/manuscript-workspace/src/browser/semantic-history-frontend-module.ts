import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { SemanticHistoryViewContribution } from './semantic-history-view-contribution';
import { SemanticHistoryWidget } from './semantic-history-widget';

/**
 * Standalone frontend module for FR-017's custom part (spec §5.6/§6): the
 * read-only Semantic History view showing how semantic entities changed over
 * time. Interactive git SCM stays out of scope while @theia/git is
 * version-stalled.
 *
 * Registered as an additional `theiaExtensions` frontend entry so it stays
 * isolated from `manuscript-workspace-frontend-module.ts`. The
 * `GitStatusService` proxy it consumes is already bound there at container
 * scope; shared widget styles live in `style/index.css`, which the main
 * frontend module already imports for the whole application.
 */
export default new ContainerModule(bind => {
  bind(SemanticHistoryWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: SemanticHistoryWidget.ID,
    createWidget: () => ctx.container.get(SemanticHistoryWidget)
  })).inSingletonScope();
  bindViewContribution(bind, SemanticHistoryViewContribution);
  bind(FrontendApplicationContribution).toService(SemanticHistoryViewContribution);
});
