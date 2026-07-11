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
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { ContainerModule } from '@theia/core/shared/inversify';
import {
  OfficePreviewService,
  OfficePreviewServicePath
} from '../common';
import { OfficePreviewWidget } from './office-preview-widget';
import {
  OfficePreviewCommandContribution,
  OfficePreviewOpenHandler
} from './office-preview-open-handler';

/**
 * Standalone frontend module for the office-document preview (docx/xlsx/xls/ods/
 * pptx + legacy .doc/.ppt). Registered as an additional `theiaExtensions`
 * frontend entry so it stays isolated from the main frontend module while the
 * two evolve in parallel. The office backend proxy is bound here to keep the
 * feature self-contained.
 */
export default new ContainerModule(bind => {
  bind(OfficePreviewService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, OfficePreviewServicePath)
  ).inSingletonScope();

  // Transient: the WidgetManager caches one widget per file URI, so each document
  // must get its own instance.
  bind(OfficePreviewWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: OfficePreviewWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(OfficePreviewWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(OfficePreviewOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(OfficePreviewOpenHandler);

  bind(OfficePreviewCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(OfficePreviewCommandContribution);
  bind(MenuContribution).toService(OfficePreviewCommandContribution);
});
