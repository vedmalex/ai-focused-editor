import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { SemanticHistoryWidget } from './semantic-history-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

export namespace SemanticHistoryCommands {
  export const OPEN: Command = {
    id: 'ai-focused-editor.semantic-history.open',
    label: 'AI Focused Editor: Open Semantic History'
  };

  export const REFRESH: Command = {
    id: 'ai-focused-editor.semantic-history.refresh',
    label: 'AI Focused Editor: Refresh Semantic History'
  };
}

@injectable()
export class SemanticHistoryViewContribution extends AbstractViewContribution<SemanticHistoryWidget> {
  constructor() {
    super({
      widgetId: SemanticHistoryWidget.ID,
      widgetName: SemanticHistoryWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        // After the Narrative Map (rank 230) in the same knowledge cluster.
        rank: 240
      },
      toggleCommandId: SemanticHistoryCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(SemanticHistoryCommands.REFRESH, {
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
      commandId: SemanticHistoryCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: SemanticHistoryCommands.REFRESH.id
    });
  }
}
