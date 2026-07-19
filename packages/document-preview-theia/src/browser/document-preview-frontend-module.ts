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
  DocumentPreviewService,
  DocumentPreviewServicePath
} from '../common';
import { DocumentPreviewWidget } from './document-preview-widget';
import {
  DocumentPreviewCommandContribution,
  DocumentPreviewOpenHandler
} from './document-preview-open-handler';

/**
 * Frontend module for the office-document preview (docx/xlsx/xls/ods/pptx +
 * legacy .doc/.ppt), extracted from manuscript-workspace into the reusable
 * document-preview-theia extension. The backend proxy is bound here to keep the
 * feature self-contained.
 */
export default new ContainerModule(bind => {
  bind(DocumentPreviewService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, DocumentPreviewServicePath)
  ).inSingletonScope();

  // Transient: the WidgetManager caches one widget per file URI, so each document
  // must get its own instance.
  bind(DocumentPreviewWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: DocumentPreviewWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(DocumentPreviewWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(DocumentPreviewOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(DocumentPreviewOpenHandler);

  bind(DocumentPreviewCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(DocumentPreviewCommandContribution);
  bind(MenuContribution).toService(DocumentPreviewCommandContribution);
});
