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
import { MetadataEditorWidget } from './metadata-editor-widget';
import { ManifestEditorWidget } from './manifest-editor-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

/**
 * Priority returned for the workspace-root book-config files. The text editor's
 * `EditorManager` returns `100`, so a higher value makes the form editors the
 * default opener while raw YAML stays reachable via "Open With...".
 */
const BOOK_CONFIG_EDITOR_PRIORITY = 500;

/** Own group under the Manuscript menu so both actions sit together at the top. */
const CONFIG_MENU: MenuPath = [...AiFocusedEditorMenus.MAIN, '1_book-config'];

const STARTER_METADATA_YAML = 'title: Untitled\nlanguage: en\n';
const STARTER_MANIFEST_YAML = 'version: 1\ncontent: []\n';

function baseName(uri: URI): string {
  return uri.path.base.toLowerCase();
}

@injectable()
export class MetadataEditorOpenHandler extends NavigatableWidgetOpenHandler<MetadataEditorWidget> {
  readonly id = MetadataEditorWidget.FACTORY_ID;
  readonly label = 'Book Metadata Form Editor';

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
  readonly label = 'Manifest Form Editor';

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
  export const EDIT_METADATA: Command = {
    id: 'ai-focused-editor.config.editMetadata',
    category: 'AI Focused Editor',
    label: 'Edit Book Metadata...'
  };

  export const EDIT_MANIFEST: Command = {
    id: 'ai-focused-editor.config.editManifest',
    category: 'AI Focused Editor',
    label: 'Edit Manifest...'
  };
}

@injectable()
export class BookConfigEditorCommandContribution implements CommandContribution, MenuContribution {
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
          await this.messageService.warn('Open a manuscript workspace before editing book metadata.');
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
          await this.messageService.warn('Open a manuscript workspace before editing the manifest.');
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
});
