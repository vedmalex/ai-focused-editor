import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { DiffUris } from '@theia/core/lib/browser/diff-uris';
import {
  FrontendApplicationContribution,
  open,
  OpenerService
} from '@theia/core/lib/browser';
import {
  StatusBar,
  StatusBarAlignment
} from '@theia/core/lib/browser/status-bar/status-bar';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  GitHistoryService,
  GitStatusFile,
  GitStatusSnapshot,
  ManuscriptWorkspaceService
} from '../common';
import { createGitHistoryResourceUri } from './git-history-resource';

const GIT_STATUS_BAR_ID = 'ai-focused-editor.git';

export namespace AiFocusedEditorGitCommands {
  export const SHOW_GIT_STATUS: Command = {
    id: 'ai-focused-editor.git.showStatus',
    label: 'AI Focused Editor: Show Git Status'
  };

  export const COPY_GIT_STATUS: Command = {
    id: 'ai-focused-editor.git.copyStatus',
    label: 'AI Focused Editor: Copy Git Status Summary'
  };

  export const OPEN_CURRENT_FILE_DIFF: Command = {
    id: 'ai-focused-editor.git.openCurrentFileDiff',
    label: 'AI Focused Editor: Open Current File Diff'
  };
}

@injectable()
export class GitHistoryContribution implements CommandContribution, MenuContribution, FrontendApplicationContribution {
  @inject(GitHistoryService)
  protected readonly gitHistory!: GitHistoryService;

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(ClipboardService)
  protected readonly clipboard!: ClipboardService;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(StatusBar)
  protected readonly statusBar!: StatusBar;

  onStart(): void {
    this.refreshStatusBar();
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(AiFocusedEditorGitCommands.SHOW_GIT_STATUS, {
      execute: () => this.showGitStatus()
    });
    registry.registerCommand(AiFocusedEditorGitCommands.COPY_GIT_STATUS, {
      execute: () => this.copyGitStatus()
    });
    registry.registerCommand(AiFocusedEditorGitCommands.OPEN_CURRENT_FILE_DIFF, {
      execute: () => this.openCurrentFileDiff()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    const menuPath = ['ai-focused-editor', 'git'];
    menus.registerSubmenu(menuPath, 'Git');
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorGitCommands.SHOW_GIT_STATUS.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorGitCommands.COPY_GIT_STATUS.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorGitCommands.OPEN_CURRENT_FILE_DIFF.id
    });
  }

  protected async showGitStatus(): Promise<void> {
    const status = await this.loadStatus();
    await this.setStatusBar(status);
    if (!status.available) {
      await this.messages.warn(status.message ?? 'No Git repository found.');
      return;
    }
    await this.messages.info(this.formatStatus(status, false));
  }

  protected async copyGitStatus(): Promise<void> {
    const status = await this.loadStatus();
    await this.setStatusBar(status);
    await this.clipboard.writeText(this.formatStatus(status, true));
    await this.messages.info('Git status summary copied to clipboard.');
  }

  protected async openCurrentFileDiff(): Promise<void> {
    const editor = this.editorManager.currentEditor?.editor ?? this.editorManager.activeEditor?.editor;
    if (!editor) {
      await this.messages.warn('Open a tracked manuscript file before opening a Git diff.');
      return;
    }

    const fileUri = editor.uri;
    if (fileUri.scheme !== 'file') {
      await this.messages.warn('Git diff is available only for file-backed editors.');
      return;
    }

    const headContent = await this.gitHistory.getFileContent({
      uri: fileUri.toString(),
      ref: 'HEAD'
    });
    if (!headContent.exists) {
      await this.messages.warn('The active file is not available in HEAD; there is no baseline diff to open.');
      return;
    }

    const headUri = createGitHistoryResourceUri(fileUri.toString(), 'HEAD');
    const diffUri = DiffUris.encode(headUri, fileUri, `${fileUri.displayName}: HEAD vs Working Tree`);
    await open(this.openerService, diffUri);
  }

  protected async refreshStatusBar(): Promise<void> {
    try {
      await this.setStatusBar(await this.loadStatus());
    } catch {
      await this.statusBar.setElement(GIT_STATUS_BAR_ID, {
        text: '$(git-branch) Git unavailable',
        tooltip: 'Git status could not be loaded.',
        alignment: StatusBarAlignment.LEFT,
        priority: 25
      });
    }
  }

  protected async loadStatus(): Promise<GitStatusSnapshot> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    return this.gitHistory.getStatus(snapshot.rootUri);
  }

  protected async setStatusBar(status: GitStatusSnapshot): Promise<void> {
    if (!status.available) {
      await this.statusBar.setElement(GIT_STATUS_BAR_ID, {
        text: '$(git-branch) No Git',
        tooltip: status.message ?? 'No Git repository found for the current workspace.',
        alignment: StatusBarAlignment.LEFT,
        priority: 25,
        command: AiFocusedEditorGitCommands.SHOW_GIT_STATUS.id
      });
      return;
    }

    const dirtyText = status.clean ? 'clean' : `${status.files.length} changed`;
    await this.statusBar.setElement(GIT_STATUS_BAR_ID, {
      text: `$(git-branch) ${status.branch ?? 'HEAD'} ${dirtyText}`,
      tooltip: this.formatStatus(status, true),
      alignment: StatusBarAlignment.LEFT,
      priority: 25,
      command: AiFocusedEditorGitCommands.SHOW_GIT_STATUS.id
    });
  }

  protected formatStatus(status: GitStatusSnapshot, multiline: boolean): string {
    if (!status.available) {
      return status.message ?? 'No Git repository found.';
    }

    const header = `Git ${status.branch ?? 'HEAD'}: ${status.clean ? 'clean' : `${status.files.length} changed file(s)`}`;
    if (!multiline || status.files.length === 0) {
      return header;
    }

    const files = status.files
      .slice(0, 30)
      .map(file => `- ${this.formatFileStatus(file)} ${file.path}`);
    const remaining = status.files.length > files.length ? [`- ... ${status.files.length - files.length} more`] : [];
    return [header, ...files, ...remaining].join('\n');
  }

  protected formatFileStatus(file: GitStatusFile): string {
    return `${file.indexStatus}${file.workingTreeStatus}`.trim() || 'M';
  }
}
