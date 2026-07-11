import '../../src/browser/style/index.css';
import URI from '@theia/core/lib/common/uri';
import {
  NavigatableWidgetOptions,
  OpenHandler,
  WidgetFactory
} from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { ExcalidrawEditorWidget } from './excalidraw-editor-widget';
import { ExcalidrawEditorOpenHandler } from './excalidraw-editor-open-handler';

/**
 * Standalone frontend module for the `.excalidraw` diagram editor. Registered as
 * an additional `theiaExtensions` frontend entry (the office-preview pattern) so
 * the heavy, bundler-sensitive Excalidraw dependency stays isolated from the
 * main frontend module.
 */
export default new ContainerModule(bind => {
  // Transient: the WidgetManager caches one widget per file URI, so each diagram
  // gets its own instance.
  bind(ExcalidrawEditorWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ExcalidrawEditorWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(ExcalidrawEditorWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(ExcalidrawEditorOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(ExcalidrawEditorOpenHandler);
});
