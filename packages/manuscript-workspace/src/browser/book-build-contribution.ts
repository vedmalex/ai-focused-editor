import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import URI from '@theia/core/lib/common/uri';
import {
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  BookBuildResult,
  BookBuildService,
  ManuscriptWorkspaceService,
  WorkspaceDiagnostic
} from '../common';

const OPEN_BUILD_ACTION = 'Open Build';
const COPY_PATH_ACTION = 'Copy Path';

export namespace AiFocusedEditorBookBuildCommands {
  export const BUILD_MARKDOWN: Command = {
    id: 'ai-focused-editor.bookBuild.buildMarkdown',
    label: 'AI Focused Editor: Build Manuscript Markdown'
  };

  export const OPEN_LAST_BUILD: Command = {
    id: 'ai-focused-editor.bookBuild.openLastBuild',
    label: 'AI Focused Editor: Open Last Manuscript Build'
  };

  export const COPY_LAST_BUILD_PATH: Command = {
    id: 'ai-focused-editor.bookBuild.copyLastBuildPath',
    label: 'AI Focused Editor: Copy Last Build Path'
  };
}

@injectable()
export class BookBuildContribution implements CommandContribution, MenuContribution {
  @inject(BookBuildService)
  protected readonly bookBuild!: BookBuildService;

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(ClipboardService)
  protected readonly clipboard!: ClipboardService;

  protected lastBuild: BookBuildResult | undefined;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(AiFocusedEditorBookBuildCommands.BUILD_MARKDOWN, {
      execute: () => this.buildMarkdown()
    });
    registry.registerCommand(AiFocusedEditorBookBuildCommands.OPEN_LAST_BUILD, {
      execute: () => this.openLastBuild()
    });
    registry.registerCommand(AiFocusedEditorBookBuildCommands.COPY_LAST_BUILD_PATH, {
      execute: () => this.copyLastBuildPath()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    const menuPath = ['ai-focused-editor', 'build'];
    menus.registerSubmenu(menuPath, 'Build');
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorBookBuildCommands.BUILD_MARKDOWN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorBookBuildCommands.OPEN_LAST_BUILD.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorBookBuildCommands.COPY_LAST_BUILD_PATH.id
    });
  }

  protected async buildMarkdown(): Promise<void> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    if (!snapshot.rootUri) {
      await this.messages.warn('Open a manuscript workspace before building Markdown.');
      return;
    }

    const progress = await this.messages.showProgress({
      text: 'AI Focused Editor: building manuscript Markdown...'
    });
    try {
      const result = await this.bookBuild.buildMarkdown({
        rootUri: snapshot.rootUri
      });
      this.lastBuild = result;

      const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
      const warnings = result.diagnostics.filter(diagnostic => diagnostic.severity === 'warning');
      if (errors.length > 0) {
        await this.messages.error(this.formatBuildResult(result, errors, warnings));
        return;
      }

      const action = await this.messages.info(
        this.formatBuildResult(result, errors, warnings),
        OPEN_BUILD_ACTION,
        COPY_PATH_ACTION
      );
      if (action === OPEN_BUILD_ACTION) {
        await this.openBuild(result);
      } else if (action === COPY_PATH_ACTION) {
        await this.copyBuildPath(result);
      }
    } catch (error) {
      await this.messages.error(`Book build failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      progress.cancel();
    }
  }

  protected async openLastBuild(): Promise<void> {
    if (!this.lastBuild) {
      await this.messages.warn('Run Build Manuscript Markdown before opening the last build.');
      return;
    }
    await this.openBuild(this.lastBuild);
  }

  protected async copyLastBuildPath(): Promise<void> {
    if (!this.lastBuild) {
      await this.messages.warn('Run Build Manuscript Markdown before copying the output path.');
      return;
    }
    await this.copyBuildPath(this.lastBuild);
  }

  protected async openBuild(result: BookBuildResult): Promise<void> {
    await open(this.openerService, new URI(result.outputUri));
  }

  protected async copyBuildPath(result: BookBuildResult): Promise<void> {
    await this.clipboard.writeText(result.outputPath);
    await this.messages.info('Book build output path copied to clipboard.');
  }

  protected formatBuildResult(
    result: BookBuildResult,
    errors: WorkspaceDiagnostic[],
    warnings: WorkspaceDiagnostic[]
  ): string {
    const status = errors.length > 0 ? 'failed' : 'completed';
    const warningText = warnings.length > 0 ? `, ${warnings.length} warning(s)` : '';
    return `Book build ${status}: ${result.chapters.length} chapter(s), ${result.contentLength} characters${warningText}. Output: ${result.outputPath}`;
  }
}
