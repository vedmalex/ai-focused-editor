import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import type { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EntityCardsWidget } from './entity-cards-widget';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';

export namespace EntityCardsCommands {
  export const OPEN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.entities.openCards',
      label: 'AI Focused Editor: Open Knowledge Cards'
    },
    'ai-focused-editor/entities/open-cards'
  );

  export const REFRESH: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.entities.refreshCards',
      label: 'AI Focused Editor: Refresh Knowledge Cards'
    },
    'ai-focused-editor/entities/refresh-cards'
  );
}

@injectable()
export class EntityCardsViewContribution extends AbstractViewContribution<EntityCardsWidget>
  implements FrontendApplicationContribution {
  constructor() {
    super({
      widgetId: EntityCardsWidget.ID,
      widgetName: EntityCardsWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        rank: 220
      },
      toggleCommandId: EntityCardsCommands.OPEN.id
    });
  }

  /**
   * UR-039: on a fresh shell layout (no saved layout to restore — Theia only
   * calls this when `restoreLayout()` found nothing, see
   * `FrontendApplication.createDefaultLayout()`), attach the widget to the
   * right panel so its icon is visible from the first launch, same as
   * `ManuscriptTreeViewContribution`/`@theia/outline-view` do for their
   * panels. `activate: false, reveal: false` on purpose: the panel must be
   * PRESENT, not opened — opening it unconditionally here would also
   * overwrite a user's deliberately-closed saved layout, except this path
   * never runs when a saved layout exists in the first place.
   */
  async initializeLayout(_app: FrontendApplication): Promise<void> {
    await this.openView({ activate: false, reveal: false });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(EntityCardsCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refresh();
      }
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const menuPath = AiFocusedEditorMenus.KNOWLEDGE;
    menus.registerMenuAction(menuPath, {
      commandId: EntityCardsCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: EntityCardsCommands.REFRESH.id
    });
  }
}
