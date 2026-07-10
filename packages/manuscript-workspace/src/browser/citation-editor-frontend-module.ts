import URI from '@theia/core/lib/common/uri';
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import {
  NavigatableWidgetOpenHandler,
  NavigatableWidgetOptions,
  OpenHandler,
  WidgetFactory,
  WidgetOpenerOptions
} from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  ContainerModule,
  inject,
  injectable
} from '@theia/core/shared/inversify';
import { CitationEditorWidget } from './citation-editor-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

/**
 * Priority returned for `sources/citations.yaml`. The text editor's
 * `EditorManager` returns `100`, so a higher value makes the citation form
 * editor the default opener while raw YAML stays reachable via "Open With...".
 */
const CITATION_EDITOR_PRIORITY = 500;

const STARTER_CITATIONS_YAML = 'version: 1\ncitations: []\n';

function isCitationsYaml(uri: URI): boolean {
  const segments = uri.path.toString().split('/').filter(segment => segment.length > 0);
  const base = segments[segments.length - 1]?.toLowerCase();
  const parent = segments[segments.length - 2]?.toLowerCase();
  return parent === 'sources' && (base === 'citations.yaml' || base === 'citations.yml');
}

@injectable()
export class CitationEditorOpenHandler extends NavigatableWidgetOpenHandler<CitationEditorWidget> {
  readonly id = CitationEditorWidget.FACTORY_ID;
  readonly label = 'Citations Form Editor';

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isCitationsYaml(uri) ? CITATION_EDITOR_PRIORITY : 0;
  }
}

export namespace CitationEditorCommands {
  export const EDIT_CITATIONS: Command = {
    id: 'ai-focused-editor.sources.editCitations',
    category: 'AI Focused Editor',
    label: 'Edit Citations...'
  };
}

@injectable()
export class CitationEditorCommandContribution implements CommandContribution, MenuContribution {
  @inject(CitationEditorOpenHandler)
  protected readonly openHandler!: CitationEditorOpenHandler;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(CitationEditorCommands.EDIT_CITATIONS, {
      execute: async () => {
        const uri = await this.resolveCitationsUri();
        if (!uri) {
          await this.messageService.warn('Open a manuscript workspace before editing citations.');
          return;
        }
        await this.ensureFile(uri);
        await this.openHandler.open(uri);
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.SOURCES, {
      commandId: CitationEditorCommands.EDIT_CITATIONS.id
    });
  }

  protected async resolveCitationsUri(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.resolve('sources/citations.yaml');
  }

  /** Seed an empty `sources/citations.yaml` so the form always has a file to edit. */
  protected async ensureFile(uri: URI): Promise<void> {
    if (await this.fileService.exists(uri)) {
      return;
    }
    try {
      await this.fileService.createFolder(uri.parent);
    } catch {
      // The sources/ folder already exists — expected.
    }
    await this.fileService.create(uri, STARTER_CITATIONS_YAML, { overwrite: false });
  }
}

/**
 * Standalone frontend module for the citation form editor (FR-025).
 *
 * Registered as an additional `theiaExtensions` frontend entry so it stays
 * isolated from `manuscript-workspace-frontend-module.ts` while the two evolve
 * in parallel (mirrors `entity-editor-frontend-module.ts`).
 */
export default new ContainerModule(bind => {
  // Transient: the WidgetManager caches one widget per file URI.
  bind(CitationEditorWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: CitationEditorWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(CitationEditorWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(CitationEditorOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(CitationEditorOpenHandler);

  bind(CitationEditorCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(CitationEditorCommandContribution);
  bind(MenuContribution).toService(CitationEditorCommandContribution);
});
