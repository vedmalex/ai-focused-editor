import URI from '@theia/core/lib/common/uri';
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
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
import { EntityTypesEditorWidget } from './entity-types-editor-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

/**
 * Priority returned for `<root>/entities/types.yaml`. The text editor's
 * `EditorManager` returns `100`, so a higher value makes the entity-types form
 * editor the default opener while raw YAML stays reachable via "Open With...".
 */
const ENTITY_TYPES_EDITOR_PRIORITY = 500;

const ENTITY_TYPES_WORKSPACE_PATH = 'entities/types.yaml';

/** Seed written when the command opens a book that has no `entities/types.yaml` yet. */
const STARTER_ENTITY_TYPES_YAML = 'version: 1\ntypes: []\n';

/** Whether the URI is a book's `entities/types.yaml` (parent `entities`, base `types.yaml`). */
function isEntityTypesYaml(uri: URI): boolean {
  const segments = uri.path.toString().split('/').filter(segment => segment.length > 0);
  const base = segments[segments.length - 1]?.toLowerCase();
  const parent = segments[segments.length - 2]?.toLowerCase();
  return parent === 'entities' && (base === 'types.yaml' || base === 'types.yml');
}

@injectable()
export class EntityTypesEditorOpenHandler extends NavigatableWidgetOpenHandler<EntityTypesEditorWidget> {
  readonly id = EntityTypesEditorWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/entity-types/open-handler-label', 'Entity Types Form Editor');

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isEntityTypesYaml(uri) ? ENTITY_TYPES_EDITOR_PRIORITY : 0;
  }
}

export namespace EntityTypesEditorCommands {
  export const EDIT_ENTITY_TYPES: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.entities.editTypes',
      category: 'AI Focused Editor',
      label: 'Edit Entity Types...'
    },
    'ai-focused-editor/entity-types/edit-types',
    'ai-focused-editor/entity-types/category'
  );
}

@injectable()
export class EntityTypesEditorCommandContribution implements CommandContribution, MenuContribution {
  @inject(EntityTypesEditorOpenHandler)
  protected readonly openHandler!: EntityTypesEditorOpenHandler;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(EntityTypesEditorCommands.EDIT_ENTITY_TYPES, {
      execute: async () => {
        const uri = await this.resolveTypesUri();
        if (!uri) {
          await this.messageService.warn(nls.localize('ai-focused-editor/entity-types/open-workspace-edit', 'Open a manuscript workspace before editing entity types.'));
          return;
        }
        await this.ensureFile(uri);
        await this.openHandler.open(uri);
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    // Sits in the same "create" group as the New Entity actions, after them.
    const mainGroup = [...AiFocusedEditorMenus.MAIN, '1a_create'];
    menus.registerMenuAction(mainGroup, {
      commandId: EntityTypesEditorCommands.EDIT_ENTITY_TYPES.id,
      order: '9_types'
    });
  }

  protected async resolveTypesUri(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.resolve(ENTITY_TYPES_WORKSPACE_PATH);
  }

  /** Seed a starter `entities/types.yaml` so the form has a file to edit. */
  protected async ensureFile(uri: URI): Promise<void> {
    if (await this.fileService.exists(uri)) {
      return;
    }
    try {
      // createFolder is recursive (mkdirp), so it creates entities/.
      await this.fileService.createFolder(uri.parent);
    } catch {
      // The entities/ folder already exists — expected.
    }
    await this.fileService.create(uri, STARTER_ENTITY_TYPES_YAML, { overwrite: false });
  }
}

/**
 * Standalone frontend module for the entity-types form editor.
 *
 * Registered as an additional `theiaExtensions` frontend entry so it stays
 * isolated from `manuscript-workspace-frontend-module.ts` (mirrors
 * `ai-modes-editor-frontend-module.ts`).
 */
export default new ContainerModule(bind => {
  // Transient: the WidgetManager caches one widget per file URI.
  bind(EntityTypesEditorWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: EntityTypesEditorWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(EntityTypesEditorWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(EntityTypesEditorOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(EntityTypesEditorOpenHandler);

  bind(EntityTypesEditorCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(EntityTypesEditorCommandContribution);
  bind(MenuContribution).toService(EntityTypesEditorCommandContribution);
});
