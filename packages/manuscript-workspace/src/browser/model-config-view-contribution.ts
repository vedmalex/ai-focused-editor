import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ModelConfigWidget } from './model-config-widget';

export namespace ModelConfigCommands {
  export const OPEN: Command = {
    id: 'ai-focused-editor.modelConfig.open',
    label: 'AI Focused Editor: Open AI Model Config'
  };

  export const REFRESH: Command = {
    id: 'ai-focused-editor.modelConfig.refresh',
    label: 'AI Focused Editor: Refresh AI Model Config'
  };
}

@injectable()
export class ModelConfigViewContribution extends AbstractViewContribution<ModelConfigWidget> {
  constructor() {
    super({
      widgetId: ModelConfigWidget.ID,
      widgetName: ModelConfigWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        rank: 230
      },
      toggleCommandId: ModelConfigCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(ModelConfigCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refresh();
      }
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const menuPath = ['ai-focused-editor'];
    menus.registerSubmenu(menuPath, 'AI Focused Editor');
    menus.registerMenuAction(menuPath, {
      commandId: ModelConfigCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: ModelConfigCommands.REFRESH.id
    });
  }
}
