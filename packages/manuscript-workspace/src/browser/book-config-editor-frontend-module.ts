import URI from '@theia/core/lib/common/uri';
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MenuPath,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import {
  NavigatableWidgetOpenHandler,
  NavigatableWidgetOptions,
  OpenHandler,
  Widget,
  WidgetFactory,
  WidgetOpenerOptions
} from '@theia/core/lib/browser';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  ContainerModule,
  inject,
  injectable
} from '@theia/core/shared/inversify';
import { MetadataEditorWidget } from './metadata-editor-widget';
import { ManifestEditorWidget } from './manifest-editor-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { ManuscriptTreeWidget } from './manuscript-tree-widget';
import { AFE_MANUSCRIPT_SECTION_CONTEXT_KEY } from './manuscript-tree';

/**
 * Priority returned for the workspace-root book-config files. The text editor's
 * `EditorManager` returns `100`, so a higher value makes the form editors the
 * default opener while raw YAML stays reachable via "Open With...".
 */
const BOOK_CONFIG_EDITOR_PRIORITY = 500;

/** Own group under the Manuscript menu so both actions sit together at the top. */
const CONFIG_MENU: MenuPath = [...AiFocusedEditorMenus.MAIN, '1_book-config'];

/**
 * Book-properties group in the manuscript tree's own context menu, so the
 * metadata/manifest forms are reachable straight from the view. Sits after the
 * '1_create' per-section create group.
 */
const TREE_BOOK_MENU: MenuPath = [...ManuscriptTreeWidget.CONTEXT_MENU, '2_book'];

/**
 * Show the book-properties actions only when the tree selection is the
 * Manuscript section (or nothing) — book-config is manuscript-scoped, so it
 * stays out of author-materials section context menus.
 */
const TREE_BOOK_MENU_WHEN =
  `${AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} == 'none' || ${AFE_MANUSCRIPT_SECTION_CONTEXT_KEY} == 'manuscript'`;

const STARTER_METADATA_YAML = 'title: Untitled\nlanguage: en\n';
const STARTER_MANIFEST_YAML = 'version: 1\ncontent: []\n';

function baseName(uri: URI): string {
  return uri.path.base.toLowerCase();
}

@injectable()
export class MetadataEditorOpenHandler extends NavigatableWidgetOpenHandler<MetadataEditorWidget> {
  readonly id = MetadataEditorWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/book-config/metadata-open-handler-label', 'Book Metadata Form Editor');

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isWorkspaceRootFile(this.workspaceService, uri, ['metadata.yaml', 'metadata.yml'])
      ? BOOK_CONFIG_EDITOR_PRIORITY
      : 0;
  }
}

@injectable()
export class ManifestEditorOpenHandler extends NavigatableWidgetOpenHandler<ManifestEditorWidget> {
  readonly id = ManifestEditorWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/book-config/manifest-open-handler-label', 'Manifest Form Editor');

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isWorkspaceRootFile(this.workspaceService, uri, ['manifest.yaml', 'manifest.yml'])
      ? BOOK_CONFIG_EDITOR_PRIORITY
      : 0;
  }
}

/** True when `uri` is one of `names` sitting directly at a workspace root. */
function isWorkspaceRootFile(workspaceService: WorkspaceService, uri: URI, names: string[]): boolean {
  if (!names.includes(baseName(uri))) {
    return false;
  }
  const parent = uri.parent;
  return workspaceService.tryGetRoots().some(root => root.resource.isEqual(parent));
}

export namespace BookConfigEditorCommands {
  const CATEGORY_KEY = 'ai-focused-editor/book-config/category';

  export const EDIT_METADATA: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.config.editMetadata',
      category: 'AI Focused Editor',
      label: 'Edit Book Metadata...'
    },
    'ai-focused-editor/book-config/edit-metadata',
    CATEGORY_KEY
  );

  export const EDIT_MANIFEST: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.config.editManifest',
      category: 'AI Focused Editor',
      label: 'Edit Manifest...'
    },
    'ai-focused-editor/book-config/edit-manifest',
    CATEGORY_KEY
  );
}

@injectable()
export class BookConfigEditorCommandContribution
  implements CommandContribution, MenuContribution, TabBarToolbarContribution {
  @inject(MetadataEditorOpenHandler)
  protected readonly metadataHandler!: MetadataEditorOpenHandler;

  @inject(ManifestEditorOpenHandler)
  protected readonly manifestHandler!: ManifestEditorOpenHandler;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(BookConfigEditorCommands.EDIT_METADATA, {
      execute: async () => {
        const uri = await this.resolveRootFile('metadata.yaml');
        if (!uri) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/book-config/open-workspace-for-metadata',
            'Open a manuscript workspace before editing book metadata.'
          ));
          return;
        }
        await this.ensureFile(uri, STARTER_METADATA_YAML);
        await this.metadataHandler.open(uri);
      }
    });

    commands.registerCommand(BookConfigEditorCommands.EDIT_MANIFEST, {
      execute: async () => {
        const uri = await this.resolveRootFile('manifest.yaml');
        if (!uri) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/book-config/open-workspace-for-manifest',
            'Open a manuscript workspace before editing the manifest.'
          ));
          return;
        }
        await this.ensureFile(uri, STARTER_MANIFEST_YAML);
        await this.manifestHandler.open(uri);
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(CONFIG_MENU, {
      commandId: BookConfigEditorCommands.EDIT_METADATA.id,
      order: '1'
    });
    menus.registerMenuAction(CONFIG_MENU, {
      commandId: BookConfigEditorCommands.EDIT_MANIFEST.id,
      order: '2'
    });

    // Reach the same forms straight from the manuscript tree's context menu.
    menus.registerMenuAction(TREE_BOOK_MENU, {
      commandId: BookConfigEditorCommands.EDIT_METADATA.id,
      order: '1',
      when: TREE_BOOK_MENU_WHEN
    });
    menus.registerMenuAction(TREE_BOOK_MENU, {
      commandId: BookConfigEditorCommands.EDIT_MANIFEST.id,
      order: '2',
      when: TREE_BOOK_MENU_WHEN
    });
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: 'ai-focused-editor.bookConfig.toolbar.properties',
      command: BookConfigEditorCommands.EDIT_METADATA.id,
      icon: 'codicon codicon-book',
      tooltip: nls.localize('ai-focused-editor/book-config/properties-tooltip', 'Book Properties (metadata.yaml)'),
      priority: 1,
      isVisible: (widget: Widget) => widget instanceof ManuscriptTreeWidget
    });
  }

  protected async resolveRootFile(name: string): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.resolve(name);
  }

  /** Seed a starter file so the form always has something to edit. */
  protected async ensureFile(uri: URI, starter: string): Promise<void> {
    if (await this.fileService.exists(uri)) {
      return;
    }
    await this.fileService.create(uri, starter, { overwrite: false });
  }
}

/**
 * Standalone frontend module for the book-config form editors (Wave-8):
 * metadata.yaml and manifest.yaml at the workspace root.
 *
 * Registered as an additional `theiaExtensions` frontend entry so it stays
 * isolated from `manuscript-workspace-frontend-module.ts` while the two evolve
 * in parallel (mirrors `citation-editor-frontend-module.ts`).
 */
export default new ContainerModule(bind => {
  // Transient: the WidgetManager caches one widget per file URI.
  bind(MetadataEditorWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: MetadataEditorWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(MetadataEditorWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(ManifestEditorWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ManifestEditorWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(ManifestEditorWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(MetadataEditorOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(MetadataEditorOpenHandler);
  bind(ManifestEditorOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(ManifestEditorOpenHandler);

  bind(BookConfigEditorCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(BookConfigEditorCommandContribution);
  bind(MenuContribution).toService(BookConfigEditorCommandContribution);
  bind(TabBarToolbarContribution).toService(BookConfigEditorCommandContribution);
});
