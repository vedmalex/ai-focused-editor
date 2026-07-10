import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MenuPath,
  MessageService,
  ProgressService,
  QuickInputService,
  QuickPickItem
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import {
  open,
  OpenerService
} from '@theia/core/lib/browser';
import type { Widget } from '@theia/core/lib/browser';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { parse } from 'yaml';
import {
  BookBuildDefaultEpubOutputPath,
  BookBuildDefaultHtmlOutputPath,
  BookBuildDefaultMarkdownOutputPath,
  BookBuildDefaultPdfOutputPath,
  BookBuildFormat,
  BookBuildRequest,
  BookBuildResult,
  BookBuildService,
  ManuscriptWorkspaceService
} from '../common';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import { AFE_MANUSCRIPT_SECTION_CONTEXT_KEY } from './manuscript-tree';

export namespace BookBuildWizardCommands {
  // en labels stay inline as the source of truth; ru comes from
  // i18n/ru/build.json keyed by `ai-focused-editor/build/*`.
  export const WIZARD: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.bookBuild.wizard',
      category: 'AI Focused Editor',
      label: 'Build Book...'
    },
    'ai-focused-editor/build/wizard',
    'ai-focused-editor/build/category'
  );
}

/** Human-readable label per build format (also the `Open <label>` action text). */
const FORMAT_LABEL: Record<BookBuildFormat, string> = {
  epub: 'EPUB',
  pdf: 'PDF',
  html: 'HTML',
  markdown: 'Markdown'
};

/** Default output path per format, reused as the format pick description. */
const FORMAT_OUTPUT_PATH: Record<BookBuildFormat, string> = {
  epub: BookBuildDefaultEpubOutputPath,
  pdf: BookBuildDefaultPdfOutputPath,
  html: BookBuildDefaultHtmlOutputPath,
  markdown: BookBuildDefaultMarkdownOutputPath
};

/**
 * Canonical presentation order for the formats (EPUB first, matching the
 * preselect). The chosen build order follows this order filtered by selection.
 */
const FORMAT_ORDER: readonly BookBuildFormat[] = ['epub', 'pdf', 'html', 'markdown'];

/** Book-properties group in the manuscript tree context menu (shared with book-config). */
const TREE_BOOK_MENU: MenuPath = [...ManuscriptTreeWidget.CONTEXT_MENU, '2_book'];

/** Manuscript-scoped: show only for the Manuscript section (or an empty selection). */
const TREE_BOOK_MENU_WHEN =
  `${AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} == 'none' || ${AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} == 'manuscript'`;

interface FormatPickItem extends QuickPickItem {
  format: BookBuildFormat;
}

type ConfirmAction = 'start' | 'back' | 'summary';

interface ConfirmPickItem extends QuickPickItem {
  action: ConfirmAction;
}

interface BuiltOutput {
  format: BookBuildFormat;
  outputUri: string;
  outputPath: string;
}

interface BookMeta {
  title?: string;
  author?: string;
}

/**
 * Multi-step "Build Book..." wizard so a manuscript can be built/published
 * without leaving the manuscript view. Step 1 multi-selects the output formats;
 * step 2 confirms against the book metadata; then the {@link BookBuildService}
 * RPC methods run sequentially with per-format progress, mirroring the direct
 * build path already used by `book-build-contribution.ts`.
 *
 * Lives in its own standalone frontend module (its own `theiaExtensions` entry)
 * so it never touches the main manuscript-workspace frontend module, and reuses
 * the container-scoped services bound there (BookBuildService, FileService, …).
 */
@injectable()
export class BookBuildWizardContribution
  implements CommandContribution, MenuContribution, TabBarToolbarContribution {
  @inject(BookBuildService)
  protected readonly bookBuild!: BookBuildService;

  @inject(ManuscriptWorkspaceService)
  protected readonly manuscriptWorkspace!: ManuscriptWorkspaceService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(ProgressService)
  protected readonly progressService!: ProgressService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(ClipboardService)
  protected readonly clipboard!: ClipboardService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(BookBuildWizardCommands.WIZARD, {
      execute: () => this.runWizard(),
      isEnabled: () => this.workspaceService.opened
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    // First in the existing Build submenu.
    menus.registerMenuAction(AiFocusedEditorMenus.BUILD, {
      commandId: BookBuildWizardCommands.WIZARD.id,
      order: '0'
    });
    // Manuscript tree context menu, after the metadata/manifest book-config items.
    menus.registerMenuAction(TREE_BOOK_MENU, {
      commandId: BookBuildWizardCommands.WIZARD.id,
      when: TREE_BOOK_MENU_WHEN,
      order: '3'
    });
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: 'ai-focused-editor.bookBuild.toolbar.wizard',
      command: BookBuildWizardCommands.WIZARD.id,
      icon: 'codicon codicon-rocket',
      tooltip: nls.localize('ai-focused-editor/build/wizard-toolbar-tooltip', 'Build / Publish Book...'),
      priority: 0,
      isVisible: (widget: Widget) => widget instanceof ManuscriptTreeWidget
    });
  }

  protected async runWizard(): Promise<void> {
    const snapshot = await this.manuscriptWorkspace.getSnapshot();
    const rootUri = snapshot.rootUri;
    if (!rootUri) {
      await this.messages.warn(nls.localize(
        'ai-focused-editor/build/open-workspace-before-wizard',
        'Open a manuscript workspace before building the book.'
      ));
      return;
    }

    let selection: BookBuildFormat[] = ['epub'];
    // Two-step wizard: pick formats (step 1) → confirm (step 2). "Back" from the
    // confirm step returns here with the current selection preserved; Esc cancels.
    while (true) {
      const picked = await this.pickFormats(selection);
      if (picked === undefined) {
        return;
      }
      if (picked.length === 0) {
        await this.messages.info(nls.localize(
          'ai-focused-editor/build/select-at-least-one',
          'Select at least one format to build.'
        ));
        continue;
      }
      selection = picked;

      const meta = await this.readBookMeta(rootUri);
      let action = await this.confirm(picked, meta);
      while (action === 'summary') {
        action = await this.confirm(picked, meta);
      }
      if (action === undefined) {
        return;
      }
      if (action === 'back') {
        continue;
      }
      await this.runBuild(picked, rootUri);
      return;
    }
  }

  /**
   * Step 1: multi-select the output formats. Uses the raw QuickPick controller
   * because `showQuickPick` only ever resolves a single item even with
   * `canSelectMany`. Resolves the chosen formats in canonical order, or
   * `undefined` when cancelled (Esc).
   */
  protected pickFormats(current: readonly BookBuildFormat[]): Promise<BookBuildFormat[] | undefined> {
    const currentSet = new Set(current);
    const items: FormatPickItem[] = FORMAT_ORDER.map(format => ({
      label: FORMAT_LABEL[format],
      description: FORMAT_OUTPUT_PATH[format],
      format
    }));

    return new Promise<BookBuildFormat[] | undefined>(resolve => {
      const quickPick = this.quickInput.createQuickPick<FormatPickItem>();
      quickPick.title = nls.localize('ai-focused-editor/build/wizard-step1-title', 'Build Book — 1/2: formats');
      quickPick.step = 1;
      quickPick.totalSteps = 2;
      quickPick.canSelectMany = true;
      quickPick.placeholder = nls.localize('ai-focused-editor/build/wizard-step1-placeholder', 'Select the output formats to build');
      quickPick.items = items;
      quickPick.selectedItems = items.filter(item => currentSet.has(item.format));

      let accepted = false;
      quickPick.onDidAccept(() => {
        accepted = true;
        const selectedSet = new Set(quickPick.selectedItems);
        const chosen = items.filter(item => selectedSet.has(item)).map(item => item.format);
        quickPick.hide();
        resolve(chosen);
      });
      quickPick.onDidHide(() => {
        quickPick.dispose();
        if (!accepted) {
          resolve(undefined);
        }
      });
      quickPick.show();
    });
  }

  /**
   * Step 2: confirm the build. Returns the selected action, `'summary'` when an
   * informational summary row is picked (caller re-shows), or `undefined` on Esc.
   */
  protected async confirm(formats: readonly BookBuildFormat[], meta: BookMeta): Promise<ConfirmAction | undefined> {
    const items: ConfirmPickItem[] = [
      ...formats.map<ConfirmPickItem>(format => ({
        label: `$(check) ${FORMAT_LABEL[format]}`,
        description: FORMAT_OUTPUT_PATH[format],
        action: 'summary'
      })),
      { label: nls.localize('ai-focused-editor/build/start-build', '$(rocket) Start build'), action: 'start' },
      { label: nls.localize('ai-focused-editor/build/back', '$(arrow-left) Back'), action: 'back' }
    ];

    const picked = await this.quickInput.showQuickPick(items, {
      title: nls.localize('ai-focused-editor/build/wizard-step2-title', 'Build Book — 2/2: confirm'),
      step: 2,
      totalSteps: 2,
      placeholder: this.describeBook(meta)
    });
    return picked?.action;
  }

  protected async runBuild(formats: readonly BookBuildFormat[], rootUri: string): Promise<void> {
    const request: BookBuildRequest = { rootUri };
    const built: BuiltOutput[] = [];

    for (const format of formats) {
      try {
        const result = await this.progressService.withProgress(
          nls.localize('ai-focused-editor/build/building-progress', 'Building {0}...', FORMAT_LABEL[format]),
          'notification',
          () => this.invokeBuild(format, request)
        );
        const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
        if (errors.length > 0) {
          const detail = errors.map(diagnostic => diagnostic.message).join('; ')
            || nls.localize('ai-focused-editor/build/build-reported-errors', 'build reported errors');
          await this.messages.error(nls.localize(
            'ai-focused-editor/build/format-build-failed',
            '{0} build failed: {1}',
            FORMAT_LABEL[format],
            detail
          ));
          continue;
        }
        built.push({ format, outputUri: result.outputUri, outputPath: result.outputPath });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.messages.error(nls.localize(
          'ai-focused-editor/build/format-build-failed',
          '{0} build failed: {1}',
          FORMAT_LABEL[format],
          detail
        ));
      }
    }

    if (built.length === 0) {
      return;
    }

    const copyPathsAction = nls.localize('ai-focused-editor/build/copy-paths-action', 'Copy Paths');
    const openActions = built.map(output =>
      nls.localize('ai-focused-editor/build/open-format-action', 'Open {0}', FORMAT_LABEL[output.format]));
    const chosen = await this.messages.info(
      nls.localize('ai-focused-editor/build/book-built-count', 'Book built: {0} format(s)', built.length),
      ...openActions,
      copyPathsAction
    );
    if (!chosen) {
      return;
    }
    if (chosen === copyPathsAction) {
      await this.clipboard.writeText(built.map(output => output.outputPath).join('\n'));
      await this.messages.info(nls.localize(
        'ai-focused-editor/build/paths-copied',
        'Book build output paths copied to clipboard.'
      ));
      return;
    }
    const target = built.find(output =>
      nls.localize('ai-focused-editor/build/open-format-action', 'Open {0}', FORMAT_LABEL[output.format]) === chosen);
    if (target) {
      await open(this.openerService, new URI(target.outputUri));
    }
  }

  protected invokeBuild(format: BookBuildFormat, request: BookBuildRequest): Promise<BookBuildResult> {
    switch (format) {
      case 'html':
        return this.bookBuild.buildHtml(request);
      case 'epub':
        return this.bookBuild.buildEpub(request);
      case 'pdf':
        return this.bookBuild.buildPdf(request);
      default:
        return this.bookBuild.buildMarkdown(request);
    }
  }

  /** Tolerant read of the book title/author from metadata.yaml; empty when missing. */
  protected async readBookMeta(rootUri: string): Promise<BookMeta> {
    try {
      const metadataUri = new URI(rootUri).resolve('metadata.yaml');
      if (!(await this.fileService.exists(metadataUri))) {
        return {};
      }
      const content = await this.fileService.read(metadataUri);
      const parsed = parse(content.value) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return {};
      }
      const record = parsed as Record<string, unknown>;
      return {
        title: typeof record.title === 'string' ? record.title : undefined,
        author: typeof record.author === 'string' ? record.author : undefined
      };
    } catch {
      return {};
    }
  }

  protected describeBook(meta: BookMeta): string {
    if (meta.title && meta.author) {
      return nls.localize(
        'ai-focused-editor/build/describe-title-author',
        '{0} — {1} · choose "Start build" to begin',
        meta.title,
        meta.author
      );
    }
    if (meta.title) {
      return nls.localize(
        'ai-focused-editor/build/describe-title',
        '{0} · choose "Start build" to begin',
        meta.title
      );
    }
    return nls.localize(
      'ai-focused-editor/build/describe-default',
      'Review the formats, then choose "Start build" to begin'
    );
  }
}
