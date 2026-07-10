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
import { EntityEditorWidget } from './entity-editor-widget';
import {
  EntityEditorCommandContribution,
  EntityEditorOpenHandler
} from './entity-editor-open-handler';

/**
 * Standalone frontend module for the form-based entity editor (FR-025).
 *
 * Registered as an additional `theiaExtensions` frontend entry so it stays
 * isolated from `manuscript-workspace-frontend-module.ts` while the two evolve
 * in parallel.
 */
export default new ContainerModule(bind => {
  // Transient: the WidgetManager caches one widget per file URI, so each entity
  // file must get its own instance.
  bind(EntityEditorWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: EntityEditorWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(EntityEditorWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(EntityEditorOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(EntityEditorOpenHandler);

  bind(EntityEditorCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(EntityEditorCommandContribution);
  bind(MenuContribution).toService(EntityEditorCommandContribution);
});
