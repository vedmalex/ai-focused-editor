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
import { ImageViewerWidget } from './image-viewer-widget';
import {
  ImageViewerCommandContribution,
  ImageViewerOpenHandler
} from './image-viewer-open-handler';

/**
 * Standalone frontend module for the image viewer (any renderable image opens as
 * an image; tiff/heic show a "convert" panel). Registered as an additional,
 * isolated `theiaExtensions` frontend entry — the excalidraw/office-preview
 * pattern — so it stays self-contained.
 */
export default new ContainerModule(bind => {
  // Transient: the WidgetManager caches one widget per file URI, so each image
  // gets its own instance.
  bind(ImageViewerWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ImageViewerWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(ImageViewerWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(ImageViewerOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(ImageViewerOpenHandler);

  bind(ImageViewerCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ImageViewerCommandContribution);
  bind(MenuContribution).toService(ImageViewerCommandContribution);
});
