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
import { MediaViewerWidget } from './media-viewer-widget';
import {
  MediaViewerCommandContribution,
  MediaViewerOpenHandler
} from './media-viewer-open-handler';

/**
 * Standalone frontend module for the media viewer (any browser-playable
 * audio/video opens as an HTML5 player; mkv/avi show a "cannot preview" panel).
 * Registered as an additional, isolated `theiaExtensions` frontend entry — the
 * image-viewer/excalidraw pattern — so it stays self-contained.
 */
export default new ContainerModule(bind => {
  // Transient: the WidgetManager caches one widget per file URI, so each media
  // file gets its own instance.
  bind(MediaViewerWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: MediaViewerWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(MediaViewerWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(MediaViewerOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(MediaViewerOpenHandler);

  bind(MediaViewerCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(MediaViewerCommandContribution);
  bind(MenuContribution).toService(MediaViewerCommandContribution);
});
