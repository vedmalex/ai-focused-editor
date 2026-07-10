import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { EntityCardsWidget } from './entity-cards-widget';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';

export namespace EntityCardsCommands {
  export const OPEN: Command = {
    id: 'ai-focused-editor.entities.openCards',
    label: 'AI Focused Editor: Open Knowledge Cards'
  };

  export const REFRESH: Command = {
    id: 'ai-focused-editor.entities.refreshCards',
    label: 'AI Focused Editor: Refresh Knowledge Cards'
  };
}

@injectable()
export class EntityCardsViewContribution extends AbstractViewContribution<EntityCardsWidget> {
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
