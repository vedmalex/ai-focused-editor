import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { AiDebugWidget } from './ai-debug-widget';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';

export namespace AiDebugCommands {
  export const OPEN: Command = {
    id: 'ai-focused-editor.aiDebug.open',
    label: 'AI Focused Editor: Open AI Debug View'
  };

  export const REFRESH: Command = {
    id: 'ai-focused-editor.aiDebug.refresh',
    label: 'AI Focused Editor: Refresh AI Debug View'
  };

  export const COPY_SNAPSHOT: Command = {
    id: 'ai-focused-editor.aiDebug.copySnapshot',
    label: 'AI Focused Editor: Copy AI Debug Snapshot'
  };
}

@injectable()
export class AiDebugViewContribution extends AbstractViewContribution<AiDebugWidget> {
  constructor() {
    super({
      widgetId: AiDebugWidget.ID,
      widgetName: AiDebugWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        rank: 240
      },
      toggleCommandId: AiDebugCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(AiDebugCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refresh();
      }
    });
    commands.registerCommand(AiDebugCommands.COPY_SNAPSHOT, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.copySnapshot();
      }
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const menuPath = AiFocusedEditorMenus.AI_DEBUG;
    menus.registerMenuAction(menuPath, {
      commandId: AiDebugCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiDebugCommands.REFRESH.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiDebugCommands.COPY_SNAPSHOT.id
    });
  }
}
