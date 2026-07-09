import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';

export namespace ManuscriptTreeCommands {
  export const OPEN: Command = {
    id: 'ai-focused-editor.manuscriptTree.open',
    label: 'AI Focused Editor: Open Manuscript View'
  };

  export const REFRESH: Command = {
    id: 'ai-focused-editor.manuscriptTree.refresh',
    label: 'AI Focused Editor: Refresh Manuscript View'
  };
}

@injectable()
export class ManuscriptTreeViewContribution extends AbstractViewContribution<ManuscriptTreeWidget> {
  constructor() {
    super({
      widgetId: ManuscriptTreeWidget.ID,
      widgetName: ManuscriptTreeWidget.LABEL,
      defaultWidgetOptions: {
        area: 'left',
        rank: 200
      },
      toggleCommandId: ManuscriptTreeCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(ManuscriptTreeCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refreshWorkspace();
      }
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const menuPath = ['ai-focused-editor'];
    menus.registerSubmenu(menuPath, 'AI Focused Editor');
    menus.registerMenuAction(menuPath, {
      commandId: ManuscriptTreeCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: ManuscriptTreeCommands.REFRESH.id
    });
    menus.registerMenuAction(ManuscriptTreeWidget.CONTEXT_MENU, {
      commandId: ManuscriptTreeCommands.REFRESH.id
    });
  }
}
