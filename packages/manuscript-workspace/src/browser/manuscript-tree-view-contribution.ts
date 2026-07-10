import {
  Command,
  CommandRegistry,
  MenuModelRegistry,
  MessageService,
  QuickInputService,
  SelectionService
} from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import type { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import { ManuscriptTreeNode } from './manuscript-tree';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';

export namespace ManuscriptTreeCommands {
  export const OPEN: Command = {
    id: 'ai-focused-editor.manuscriptTree.open',
    category: 'AI Focused Editor',
    label: 'Open Manuscript View'
  };

  export const REFRESH: Command = {
    id: 'ai-focused-editor.manuscriptTree.refresh',
    category: 'AI Focused Editor',
    label: 'Refresh Manuscript View'
  };

  export const MOVE_UP: Command = {
    id: 'ai-focused-editor.manuscriptTree.moveUp',
    category: 'AI Focused Editor',
    label: 'Move Chapter Up'
  };

  export const MOVE_DOWN: Command = {
    id: 'ai-focused-editor.manuscriptTree.moveDown',
    category: 'AI Focused Editor',
    label: 'Move Chapter Down'
  };

  export const TOGGLE_BUILD_INCLUSION: Command = {
    id: 'ai-focused-editor.manuscriptTree.toggleBuildInclusion',
    category: 'AI Focused Editor',
    label: 'Include/Exclude in Book Build'
  };

  export const NEW_CHAPTER: Command = {
    id: 'ai-focused-editor.manuscriptTree.newChapter',
    category: 'AI Focused Editor',
    label: 'New Chapter...'
  };
}

@injectable()
export class ManuscriptTreeViewContribution extends AbstractViewContribution<ManuscriptTreeWidget>
  implements FrontendApplicationContribution {
  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

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

  /**
   * Writer-first default layout: on a fresh workspace layout the manuscript tree
   * is the primary navigation surface, not the developer file navigator.
   */
  async initializeLayout(_app: FrontendApplication): Promise<void> {
    await this.openView({ activate: false, reveal: true });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(ManuscriptTreeCommands.REFRESH, {
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true });
        await widget.refreshWorkspace();
      }
    });
    commands.registerCommand(ManuscriptTreeCommands.MOVE_UP, {
      execute: () => this.moveSelected(-1),
      isEnabled: () => this.getSelectedManuscriptNode() !== undefined,
      isVisible: () => this.getSelectedManuscriptNode() !== undefined
    });
    commands.registerCommand(ManuscriptTreeCommands.MOVE_DOWN, {
      execute: () => this.moveSelected(1),
      isEnabled: () => this.getSelectedManuscriptNode() !== undefined,
      isVisible: () => this.getSelectedManuscriptNode() !== undefined
    });
    commands.registerCommand(ManuscriptTreeCommands.TOGGLE_BUILD_INCLUSION, {
      execute: () => this.toggleBuildInclusion(),
      isEnabled: () => this.getSelectedManuscriptNode() !== undefined,
      isVisible: () => this.getSelectedManuscriptNode() !== undefined
    });
    commands.registerCommand(ManuscriptTreeCommands.NEW_CHAPTER, {
      execute: () => this.createChapter()
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    const menuPath = AiFocusedEditorMenus.MAIN;
    menus.registerMenuAction(menuPath, {
      commandId: ManuscriptTreeCommands.OPEN.id,
      order: '1'
    });
    menus.registerMenuAction(menuPath, {
      commandId: ManuscriptTreeCommands.NEW_CHAPTER.id,
      order: '1a'
    });
    for (const [order, command] of [
      ManuscriptTreeCommands.NEW_CHAPTER,
      ManuscriptTreeCommands.MOVE_UP,
      ManuscriptTreeCommands.MOVE_DOWN,
      ManuscriptTreeCommands.TOGGLE_BUILD_INCLUSION,
      ManuscriptTreeCommands.REFRESH
    ].entries()) {
      menus.registerMenuAction(ManuscriptTreeWidget.CONTEXT_MENU, {
        commandId: command.id,
        order: String(order)
      });
    }
  }

  protected getSelectedManuscriptNode(): ManuscriptTreeNode | undefined {
    const widget = this.tryGetWidget();
    const node = widget?.manuscriptModel.selectedNodes[0];
    return ManuscriptTreeNode.is(node) ? node : undefined;
  }

  protected async moveSelected(delta: -1 | 1): Promise<void> {
    const widget = await this.openView({ activate: false, reveal: true });
    const node = this.getSelectedManuscriptNode();
    if (!node) {
      return;
    }

    const parent = node.parent;
    const parentPath = ManuscriptTreeNode.isFolder(parent) ? parent.manuscript.path : undefined;
    const currentIndex = node.manuscript.order;
    const targetIndex = delta < 0 ? currentIndex - 1 : currentIndex + 2;
    if (targetIndex < 0) {
      return;
    }

    const result = await widget.manuscriptModel.moveEntry(node.manuscript.path, {
      parentPath,
      index: targetIndex
    });
    if (!result.ok) {
      this.messages.warn(`Move failed: ${result.message ?? 'unknown error'}`);
    }
  }

  protected async toggleBuildInclusion(): Promise<void> {
    const widget = await this.openView({ activate: false, reveal: true });
    const node = this.getSelectedManuscriptNode();
    if (!node) {
      return;
    }

    const result = await widget.manuscriptModel.setBuildInclusion(
      node.manuscript.path,
      !node.manuscript.buildIncluded
    );
    if (!result.ok) {
      this.messages.warn(`Could not update build inclusion: ${result.message ?? 'unknown error'}`);
    }
  }

  protected async createChapter(): Promise<void> {
    const widget = await this.openView({ activate: true, reveal: true });
    const title = await this.quickInput.input({
      prompt: 'Chapter title',
      placeHolder: 'e.g. Глава 1. Начало'
    });
    if (!title?.trim()) {
      return;
    }

    const selected = this.getSelectedManuscriptNode();
    const parentPath = ManuscriptTreeNode.isFolder(selected) ? selected.manuscript.path : undefined;
    const result = await widget.manuscriptModel.createChapter(parentPath, title.trim());
    if (!result.ok) {
      this.messages.warn(`Could not create chapter: ${result.message ?? 'unknown error'}`);
    }
  }
}
