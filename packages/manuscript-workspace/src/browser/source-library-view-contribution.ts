import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { SourceLibraryWidget } from './source-library-widget';

export namespace SourceLibraryCommands {
  export const OPEN: Command = {
    id: 'ai-focused-editor.sources.open',
    label: 'AI Focused Editor: Open Sources'
  };

  export const REFRESH: Command = {
    id: 'ai-focused-editor.sources.refresh',
    label: 'AI Focused Editor: Refresh Sources'
  };
}

@injectable()
export class SourceLibraryViewContribution extends AbstractViewContribution<SourceLibraryWidget> {
  constructor() {
    super({
      widgetId: SourceLibraryWidget.ID,
      widgetName: SourceLibraryWidget.LABEL,
      defaultWidgetOptions: {
        area: 'left',
        rank: 215
      },
      toggleCommandId: SourceLibraryCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(SourceLibraryCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refresh();
      }
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const menuPath = ['ai-focused-editor', 'sources'];
    menus.registerSubmenu(menuPath, 'Sources');
    menus.registerMenuAction(menuPath, {
      commandId: SourceLibraryCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: SourceLibraryCommands.REFRESH.id
    });
  }
}
