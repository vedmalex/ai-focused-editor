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
import { ExcerptsEditorWidget } from './excerpts-editor-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

/**
 * Priority returned for `sources/excerpts.jsonl`. The text editor's
 * `EditorManager` returns `100`, so a higher value makes the excerpts form
 * editor the default opener while the raw JSONL stays reachable via
 * "Open With...".
 */
const EXCERPTS_EDITOR_PRIORITY = 500;

const EXCERPTS_WORKSPACE_PATH = 'sources/excerpts.jsonl';

/** JSONL has no header, so an empty file is simply empty. */
const STARTER_EXCERPTS_JSONL = '';

function isExcerptsJsonl(uri: URI): boolean {
  const segments = uri.path.toString().split('/').filter(segment => segment.length > 0);
  const base = segments[segments.length - 1]?.toLowerCase();
  const parent = segments[segments.length - 2]?.toLowerCase();
  return parent === 'sources' && base === 'excerpts.jsonl';
}

@injectable()
export class ExcerptsEditorOpenHandler extends NavigatableWidgetOpenHandler<ExcerptsEditorWidget> {
  readonly id = ExcerptsEditorWidget.FACTORY_ID;
  readonly label = 'Excerpts Form Editor';

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isExcerptsJsonl(uri) ? EXCERPTS_EDITOR_PRIORITY : 0;
  }
}

export namespace ExcerptsEditorCommands {
  export const EDIT_EXCERPTS: Command = {
    id: 'ai-focused-editor.excerpts.editExcerpts',
    category: 'AI Focused Editor',
    label: 'Edit Excerpts...'
  };
}

@injectable()
export class ExcerptsEditorCommandContribution implements CommandContribution, MenuContribution {
  @inject(ExcerptsEditorOpenHandler)
  protected readonly openHandler!: ExcerptsEditorOpenHandler;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ExcerptsEditorCommands.EDIT_EXCERPTS, {
      execute: async () => {
        const uri = await this.resolveExcerptsUri();
        if (!uri) {
          await this.messageService.warn('Open a manuscript workspace before editing excerpts.');
          return;
        }
        await this.ensureFile(uri);
        await this.openHandler.open(uri);
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.SOURCES, {
      commandId: ExcerptsEditorCommands.EDIT_EXCERPTS.id
    });
  }

  protected async resolveExcerptsUri(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.resolve(EXCERPTS_WORKSPACE_PATH);
  }

  /** Seed an empty `sources/excerpts.jsonl` so the form always has a file to edit. */
  protected async ensureFile(uri: URI): Promise<void> {
    if (await this.fileService.exists(uri)) {
      return;
    }
    try {
      await this.fileService.createFolder(uri.parent);
    } catch {
      // The sources/ folder already exists — expected.
    }
    await this.fileService.create(uri, STARTER_EXCERPTS_JSONL, { overwrite: false });
  }
}

/**
 * Standalone frontend module for the excerpts form editor (spec §5.4).
 *
 * Registered as an additional `theiaExtensions` frontend entry so it stays
 * isolated from `manuscript-workspace-frontend-module.ts` while the two evolve
 * in parallel (mirrors `citation-editor-frontend-module.ts`).
 */
export default new ContainerModule(bind => {
  // Transient: the WidgetManager caches one widget per file URI.
  bind(ExcerptsEditorWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ExcerptsEditorWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(ExcerptsEditorWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(ExcerptsEditorOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(ExcerptsEditorOpenHandler);

  bind(ExcerptsEditorCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ExcerptsEditorCommandContribution);
  bind(MenuContribution).toService(ExcerptsEditorCommandContribution);
});
