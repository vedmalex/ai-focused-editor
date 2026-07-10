import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ModelConfigWidget } from './model-config-widget';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';

export namespace ModelConfigCommands {
  export const OPEN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.modelConfig.open',
      label: 'AI Focused Editor: Open AI Model Config'
    },
    'ai-focused-editor/ai-config/open-model-config'
  );

  export const REFRESH: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.modelConfig.refresh',
      label: 'AI Focused Editor: Refresh AI Model Config'
    },
    'ai-focused-editor/ai-config/refresh-model-config'
  );
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
    const menuPath = AiFocusedEditorMenus.MAIN;
    menus.registerMenuAction(menuPath, {
      commandId: ModelConfigCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: ModelConfigCommands.REFRESH.id
    });
  }
}
