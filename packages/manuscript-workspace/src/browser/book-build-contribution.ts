import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import URI from '@theia/core/lib/common/uri';
import {
  open,
  OpenerService
} from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { OutputChannelManager, OutputChannelSeverity } from '@theia/output/lib/browser/output-channel';
import {
  TaskContribution,
  TaskProvider,
  TaskProviderRegistry
} from '@theia/task/lib/browser/task-contribution';
import { TaskService } from '@theia/task/lib/browser/task-service';
import {
  PanelKind,
  RevealKind,
  TaskConfiguration,
  TaskExitedEvent,
  TaskInfo,
  TaskWatcher
} from '@theia/task/lib/common';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  BookBuildDefaultEpubOutputPath,
  BookBuildDefaultHtmlOutputPath,
  BookBuildDefaultMarkdownOutputPath,
  BookBuildDefaultPdfOutputPath,
  BookBuildEpubTaskLabel,
  BookBuildFormat,
  BookBuildHtmlTaskLabel,
  BookBuildMarkdownTaskLabel,
  BookBuildPdfTaskLabel,
  BookBuildTaskConfiguration,
  BookBuildTaskSource,
  BookBuildTaskType,
  ManuscriptWorkspaceService
} from '../common';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';

const OPEN_BUILD_ACTION = nls.localize('ai-focused-editor/build/open-build-action', 'Open Build');
const COPY_PATH_ACTION = nls.localize('ai-focused-editor/build/copy-path-action', 'Copy Path');
const OUTPUT_CHANNEL_NAME = 'AI Focused Editor';

interface LastBuildOutput {
  outputUri: string;
  outputPath: string;
  format: BookBuildFormat;
}

export namespace AiFocusedEditorBookBuildCommands {
  // en labels stay inline as the source of truth; ru comes from
  // i18n/ru/build.json keyed by `ai-focused-editor/build/*`.
  const CATEGORY_KEY = 'ai-focused-editor/build/category';

  export const BUILD_MARKDOWN: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.bookBuild.buildMarkdown',
      label: 'AI Focused Editor: Build Manuscript Markdown'
    },
    'ai-focused-editor/build/build-markdown'
  );

  export const BUILD_HTML: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.bookBuild.buildHtml',
      label: 'AI Focused Editor: Build Manuscript HTML'
    },
    'ai-focused-editor/build/build-html'
  );

  export const BUILD_EPUB: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.bookBuild.epub',
      category: 'AI Focused Editor',
      label: 'Build Manuscript EPUB'
    },
    'ai-focused-editor/build/build-epub',
    CATEGORY_KEY
  );

  export const BUILD_PDF: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.bookBuild.pdf',
      category: 'AI Focused Editor',
      label: 'Build Manuscript PDF'
    },
    'ai-focused-editor/build/build-pdf',
    CATEGORY_KEY
  );

  export const OPEN_LAST_BUILD: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.bookBuild.openLastBuild',
      label: 'AI Focused Editor: Open Last Manuscript Build'
    },
    'ai-focused-editor/build/open-last-build'
  );

  export const COPY_LAST_BUILD_PATH: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.bookBuild.copyLastBuildPath',
      label: 'AI Focused Editor: Copy Last Build Path'
    },
    'ai-focused-editor/build/copy-last-build-path'
  );
}

@injectable()
export class BookBuildContribution implements CommandContribution, MenuContribution, TaskContribution, TaskProvider {
  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(TaskService)
  protected readonly taskService!: TaskService;

  @inject(TaskWatcher)
  protected readonly taskWatcher!: TaskWatcher;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(ClipboardService)
  protected readonly clipboard!: ClipboardService;

  @inject(OutputChannelManager)
  protected readonly outputChannels!: OutputChannelManager;

  protected lastBuild: LastBuildOutput | undefined;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(AiFocusedEditorBookBuildCommands.BUILD_MARKDOWN, {
      execute: () => this.build('markdown')
    });
    registry.registerCommand(AiFocusedEditorBookBuildCommands.BUILD_HTML, {
      execute: () => this.build('html')
    });
    registry.registerCommand(AiFocusedEditorBookBuildCommands.BUILD_EPUB, {
      execute: () => this.build('epub')
    });
    registry.registerCommand(AiFocusedEditorBookBuildCommands.BUILD_PDF, {
      execute: () => this.build('pdf')
    });
    registry.registerCommand(AiFocusedEditorBookBuildCommands.OPEN_LAST_BUILD, {
      execute: () => this.openLastBuild()
    });
    registry.registerCommand(AiFocusedEditorBookBuildCommands.COPY_LAST_BUILD_PATH, {
      execute: () => this.copyLastBuildPath()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    const menuPath = AiFocusedEditorMenus.BUILD;
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorBookBuildCommands.BUILD_MARKDOWN.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorBookBuildCommands.BUILD_HTML.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorBookBuildCommands.BUILD_EPUB.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorBookBuildCommands.BUILD_PDF.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorBookBuildCommands.OPEN_LAST_BUILD.id
    });
    menus.registerMenuAction(menuPath, {
      commandId: AiFocusedEditorBookBuildCommands.COPY_LAST_BUILD_PATH.id
    });
  }

  registerProviders(providers: TaskProviderRegistry): void {
    providers.register(BookBuildTaskType, this);
  }

  async provideTasks(): Promise<TaskConfiguration[]> {
    await this.workspaceService.ready;
    return this.workspaceService.tryGetRoots().flatMap(root => [
      this.createBuildTask(root.resource.toString(), 'markdown'),
      this.createBuildTask(root.resource.toString(), 'html'),
      this.createBuildTask(root.resource.toString(), 'epub'),
      this.createBuildTask(root.resource.toString(), 'pdf')
    ]);
  }

  protected async build(format: BookBuildFormat): Promise<void> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    if (!snapshot.rootUri) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/build/open-workspace-before-build',
        'Open a manuscript workspace before building {0}.',
        format.toUpperCase()
      ));
      return;
    }

    const task = this.createBuildTask(snapshot.rootUri, format);
    const output = this.toLastBuildOutput(snapshot.rootUri, format);
    this.lastBuild = output;
    const channel = this.outputChannels.getChannel(OUTPUT_CHANNEL_NAME);
    channel.clear();
    channel.appendLine(`[book-build] Starting task: ${task.label}`);
    channel.appendLine(`[book-build] Workspace: ${snapshot.rootUri}`);
    channel.appendLine(`[book-build] Output: ${output.outputPath}`);
    channel.show({ preserveFocus: true });

    try {
      const taskInfo = await this.taskService.runTask(task, {
        customization: {
          type: task.type,
          problemMatcher: []
        }
      });
      if (!taskInfo) {
        channel.appendLine('[book-build] Task did not start.', OutputChannelSeverity.Warning);
        await this.messages.warn(nls.localize('ai-focused-editor/build/task-did-not-start', 'Book build task did not start.'));
        return;
      }

      channel.appendLine(`[book-build] Task started: ${taskInfo.taskId}`);
      this.watchBuildTaskExit(taskInfo, output, channel);
      await this.messages.info(nls.localize(
        'ai-focused-editor/build/task-started',
        '{0} book build task started. Follow progress in the task terminal or AI Focused Editor output channel.',
        format.toUpperCase()
      ));
    } catch (error) {
      channel.appendLine(`[book-build] Failed to start task: ${error instanceof Error ? error.message : String(error)}`, OutputChannelSeverity.Error);
      await this.messages.error(nls.localize(
        'ai-focused-editor/build/build-failed-error',
        'Book build failed: {0}',
        error instanceof Error ? error.message : String(error)
      ));
    }
  }

  protected async openLastBuild(): Promise<void> {
    if (!this.lastBuild) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/build/run-before-open-last',
        'Run Build Manuscript Markdown before opening the last build.'
      ));
      return;
    }
    await this.openBuild(this.lastBuild);
  }

  protected async copyLastBuildPath(): Promise<void> {
    if (!this.lastBuild) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/build/run-before-copy-path',
        'Run Build Manuscript Markdown before copying the output path.'
      ));
      return;
    }
    await this.copyBuildPath(this.lastBuild);
  }

  protected async openBuild(result: LastBuildOutput): Promise<void> {
    await open(this.openerService, new URI(result.outputUri));
  }

  protected async copyBuildPath(result: LastBuildOutput): Promise<void> {
    await this.clipboard.writeText(result.outputPath);
    await this.messages.info(nls.localize(
      'ai-focused-editor/build/path-copied',
      'Book build output path copied to clipboard.'
    ));
  }

  protected createBuildTask(rootUri: string, format: BookBuildFormat): BookBuildTaskConfiguration {
    return {
      type: BookBuildTaskType,
      label: this.taskLabelFor(format),
      _source: BookBuildTaskSource,
      _scope: rootUri,
      rootUri,
      format,
      group: {
        kind: 'build',
        isDefault: format === 'markdown'
      },
      problemMatcher: [],
      presentation: {
        reveal: RevealKind.Always,
        panel: PanelKind.Dedicated,
        focus: false,
        clear: true
      },
      detail: nls.localize(
        'ai-focused-editor/build/task-detail',
        'Build the colocated manuscript workspace into {0}.',
        this.defaultOutputPathFor(format)
      )
    };
  }

  protected toLastBuildOutput(rootUri: string, format: BookBuildFormat): LastBuildOutput {
    const outputUri = new URI(rootUri).resolve(this.defaultOutputPathFor(format));
    return {
      outputUri: outputUri.toString(),
      outputPath: outputUri.path.fsPath(),
      format
    };
  }

  protected taskLabelFor(format: BookBuildFormat): string {
    switch (format) {
      case 'html':
        return BookBuildHtmlTaskLabel;
      case 'epub':
        return BookBuildEpubTaskLabel;
      case 'pdf':
        return BookBuildPdfTaskLabel;
      default:
        return BookBuildMarkdownTaskLabel;
    }
  }

  protected defaultOutputPathFor(format: BookBuildFormat): string {
    switch (format) {
      case 'html':
        return BookBuildDefaultHtmlOutputPath;
      case 'epub':
        return BookBuildDefaultEpubOutputPath;
      case 'pdf':
        return BookBuildDefaultPdfOutputPath;
      default:
        return BookBuildDefaultMarkdownOutputPath;
    }
  }

  protected watchBuildTaskExit(taskInfo: TaskInfo, output: LastBuildOutput, channel: ReturnType<OutputChannelManager['getChannel']>): void {
    const disposable = this.taskWatcher.onTaskExit((event: TaskExitedEvent) => {
      if (event.taskId !== taskInfo.taskId) {
        return;
      }
      disposable.dispose();
      void this.handleBuildTaskExit(event, output, channel);
    });
  }

  protected async handleBuildTaskExit(
    event: TaskExitedEvent,
    output: LastBuildOutput,
    channel: ReturnType<OutputChannelManager['getChannel']>
  ): Promise<void> {
    if (event.code === 0) {
      channel.appendLine(`[book-build] Completed successfully. Output: ${output.outputPath}`);
      const action = await this.messages.info(
        nls.localize('ai-focused-editor/build/build-completed', 'Book build completed. Output: {0}', output.outputPath),
        OPEN_BUILD_ACTION,
        COPY_PATH_ACTION
      );
      if (action === OPEN_BUILD_ACTION) {
        await this.openBuild(output);
      } else if (action === COPY_PATH_ACTION) {
        await this.copyBuildPath(output);
      }
      return;
    }

    const reason = event.signal
      ? nls.localize('ai-focused-editor/build/reason-signal', 'signal {0}', event.signal)
      : nls.localize(
          'ai-focused-editor/build/reason-exit-code',
          'exit code {0}',
          event.code ?? nls.localize('ai-focused-editor/build/unknown-exit-code', 'unknown')
        );
    channel.appendLine(`[book-build] Failed with ${reason}.`, OutputChannelSeverity.Error);
    await this.messages.error(nls.localize(
      'ai-focused-editor/build/build-failed-with-reason',
      'Book build failed with {0}. See the task terminal for details.',
      reason
    ));
  }
}
