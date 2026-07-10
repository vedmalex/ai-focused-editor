import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import {
  NarrativeGraphBackendService,
  NarrativeGraphBackendServicePath,
  NarrativeGraphService
} from '../common';
import { BrowserNarrativeGraphService } from './browser-narrative-graph-service';
import { NarrativeMapViewContribution } from './narrative-map-view-contribution';
import { NarrativeMapWidget } from './narrative-map-widget';

/**
 * Standalone frontend module for FR-007 (spec §5.2): the artifact ownership /
 * timeline model and the Narrative Map relationship+timeline view.
 *
 * Registered as an additional `theiaExtensions` frontend entry so it stays
 * isolated from `manuscript-workspace-frontend-module.ts` while the two evolve
 * in parallel. Shared widget styles live in `style/index.css`, which the main
 * frontend module already imports for the whole application.
 */
export default new ContainerModule(bind => {
  bind(NarrativeGraphBackendService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, NarrativeGraphBackendServicePath)
  ).inSingletonScope();
  bind(NarrativeGraphService).to(BrowserNarrativeGraphService).inSingletonScope();
  bind(NarrativeMapWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: NarrativeMapWidget.ID,
    createWidget: () => ctx.container.get(NarrativeMapWidget)
  })).inSingletonScope();
  bindViewContribution(bind, NarrativeMapViewContribution);
  bind(FrontendApplicationContribution).toService(NarrativeMapViewContribution);
});
