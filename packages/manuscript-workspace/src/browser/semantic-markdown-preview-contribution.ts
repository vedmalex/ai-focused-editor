import {
  Command,
  CommandRegistry,
  MenuModelRegistry
} from '@theia/core/lib/common';
import {
  PreferenceScope,
  PreferenceService
} from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { SemanticMarkdownPreviewWidget } from './semantic-markdown-preview-widget';
import { AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS } from './ai-focused-editor-preferences';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';

export namespace SemanticMarkdownPreviewCommands {
  export const OPEN: Command = {
    id: 'ai-focused-editor.semanticMarkdown.preview.open',
    label: 'AI Focused Editor: Open Semantic Markdown Preview'
  };

  export const REFRESH: Command = {
    id: 'ai-focused-editor.semanticMarkdown.preview.refresh',
    label: 'AI Focused Editor: Refresh Semantic Markdown Preview'
  };

  export const TOGGLE_TAG_CHIPS: Command = {
    id: 'ai-focused-editor.semanticMarkdown.preview.toggleTagChips',
    label: 'AI Focused Editor: Toggle Semantic Tag Chips in Preview'
  };
}

@injectable()
export class SemanticMarkdownPreviewContribution extends AbstractViewContribution<SemanticMarkdownPreviewWidget> {
  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

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
    commands.registerCommand(SemanticMarkdownPreviewCommands.TOGGLE_TAG_CHIPS, {
      execute: async () => {
        const current = this.preferenceService.get<boolean>(AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS, true);
        await this.preferenceService.set(
          AI_FOCUSED_EDITOR_PREVIEW_SHOW_TAG_CHIPS,
          !current,
          PreferenceScope.User
        );
      }
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const menuPath = AiFocusedEditorMenus.MAIN;
    menus.registerMenuAction(menuPath, {
      commandId: SemanticMarkdownPreviewCommands.OPEN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: SemanticMarkdownPreviewCommands.REFRESH.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: SemanticMarkdownPreviewCommands.TOGGLE_TAG_CHIPS.id
    });
  }
}
