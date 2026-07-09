import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { SemanticMarkdownPreviewWidget } from './semantic-markdown-preview-widget';

export namespace SemanticMarkdownPreviewCommands {
  export const OPEN: Command = {
    id: 'ai-focused-editor.semanticMarkdown.preview.open',
    label: 'AI Focused Editor: Open Semantic Markdown Preview'
  };

  export const REFRESH: Command = {
    id: 'ai-focused-editor.semanticMarkdown.preview.refresh',
    label: 'AI Focused Editor: Refresh Semantic Markdown Preview'
  };
}

@injectable()
export class SemanticMarkdownPreviewContribution extends AbstractViewContribution<SemanticMarkdownPreviewWidget> {
  constructor() {
    super({
      widgetId: SemanticMarkdownPreviewWidget.ID,
      widgetName: SemanticMarkdownPreviewWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
        rank: 220
      },
      toggleCommandId: SemanticMarkdownPreviewCommands.OPEN.id
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(SemanticMarkdownPreviewCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        widget.refresh();
      }
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const menuPath = ['ai-focused-editor'];
    menus.registerSubmenu(menuPath, 'AI Focused Editor');
    menus.registerMenuAction(menuPath, {
      commandId: SemanticMarkdownPreviewCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: SemanticMarkdownPreviewCommands.REFRESH.id
    });
  }
}
