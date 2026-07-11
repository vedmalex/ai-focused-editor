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
import { AiModeRegistry } from '../common';
import { AiModesEditorWidget } from './ai-modes-editor-widget';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

/**
 * Priority returned for `ai/prompts/custom-modes.yaml`. The text editor's
 * `EditorManager` returns `100`, so a higher value makes the AI modes form
 * editor the default opener while raw YAML stays reachable via "Open With...".
 */
const AI_MODES_EDITOR_PRIORITY = 500;

const AI_MODES_WORKSPACE_PATH = 'ai/prompts/custom-modes.yaml';

const STARTER_AI_MODES_YAML = 'version: 1\nmodes: []\n';

/** The user-global modes folder name under the home directory. */
const GLOBAL_MODES_DIR = '.ai-focused-editor';

function isCustomModesBase(base: string | undefined): boolean {
  return base === 'custom-modes.yaml' || base === 'custom-modes.yml';
}

function isAiModesYaml(uri: URI): boolean {
  const segments = uri.path.toString().split('/').filter(segment => segment.length > 0);
  const base = segments[segments.length - 1]?.toLowerCase();
  const parent = segments[segments.length - 2]?.toLowerCase();
  const grandparent = segments[segments.length - 3]?.toLowerCase();
  // Book modes: <root>/ai/prompts/custom-modes.yaml
  if (grandparent === 'ai' && parent === 'prompts' && isCustomModesBase(base)) {
    return true;
  }
  // User-global modes: <home>/.ai-focused-editor/custom-modes.yaml
  return parent === GLOBAL_MODES_DIR && isCustomModesBase(base);
}

@injectable()
export class AiModesEditorOpenHandler extends NavigatableWidgetOpenHandler<AiModesEditorWidget> {
  readonly id = AiModesEditorWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/ai-modes/open-handler-label', 'AI Modes Form Editor');

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isAiModesYaml(uri) ? AI_MODES_EDITOR_PRIORITY : 0;
  }
}

export namespace AiModesEditorCommands {
  export const EDIT_AI_MODES: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.aiModes.editModes',
      category: 'AI Focused Editor',
      label: 'Edit AI Modes...'
    },
    'ai-focused-editor/ai-modes/edit-modes',
    'ai-focused-editor/ai-modes/category'
  );

  export const EDIT_GLOBAL_AI_MODES: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.aiModes.editGlobalModes',
      category: 'AI Focused Editor',
      label: 'Edit Global AI Modes...'
    },
    'ai-focused-editor/ai-modes/edit-global-modes',
    'ai-focused-editor/ai-modes/category'
  );
}

@injectable()
export class AiModesEditorCommandContribution implements CommandContribution, MenuContribution {
  @inject(AiModesEditorOpenHandler)
  protected readonly openHandler!: AiModesEditorOpenHandler;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(AiModeRegistry)
  protected readonly aiModes!: AiModeRegistry;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(AiModesEditorCommands.EDIT_AI_MODES, {
      execute: async () => {
        const uri = await this.resolveModesUri();
        if (!uri) {
          await this.messageService.warn(nls.localize('ai-focused-editor/ai-modes/open-workspace-edit', 'Open a manuscript workspace before editing AI modes.'));
          return;
        }
        await this.ensureFile(uri);
        await this.openHandler.open(uri);
      }
    });
    commands.registerCommand(AiModesEditorCommands.EDIT_GLOBAL_AI_MODES, {
      execute: async () => {
        const uri = await this.resolveGlobalModesUri();
        if (!uri) {
          await this.messageService.warn(nls.localize('ai-focused-editor/ai-modes/global-unavailable', 'Could not resolve the global AI modes file location.'));
          return;
        }
        await this.ensureFile(uri);
        await this.openHandler.open(uri);
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.AI_MODES, {
      commandId: AiModesEditorCommands.EDIT_AI_MODES.id,
      order: '0_edit'
    });
    menus.registerMenuAction(AiFocusedEditorMenus.AI_MODES, {
      commandId: AiModesEditorCommands.EDIT_GLOBAL_AI_MODES.id,
      order: '0_edit_global'
    });
  }

  /** Resolve the user-global modes file URI reported by the backend registry. */
  protected async resolveGlobalModesUri(): Promise<URI | undefined> {
    try {
      const snapshot = await this.aiModes.getSnapshot();
      return snapshot.globalUri ? new URI(snapshot.globalUri) : undefined;
    } catch {
      return undefined;
    }
  }

  protected async resolveModesUri(): Promise<URI | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.resolve(AI_MODES_WORKSPACE_PATH);
  }

  /** Seed a starter `ai/prompts/custom-modes.yaml` so the form has a file to edit. */
  protected async ensureFile(uri: URI): Promise<void> {
    if (await this.fileService.exists(uri)) {
      return;
    }
    try {
      // createFolder is recursive (mkdirp), so it creates ai/ and ai/prompts/.
      await this.fileService.createFolder(uri.parent);
    } catch {
      // The ai/prompts/ folder already exists — expected.
    }
    await this.fileService.create(uri, STARTER_AI_MODES_YAML, { overwrite: false });
  }
}

/**
 * Standalone frontend module for the AI modes form editor.
 *
 * Registered as an additional `theiaExtensions` frontend entry so it stays
 * isolated from `manuscript-workspace-frontend-module.ts` while the two evolve
 * in parallel (mirrors `citation-editor-frontend-module.ts`).
 */
export default new ContainerModule(bind => {
  // Transient: the WidgetManager caches one widget per file URI.
  bind(AiModesEditorWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: AiModesEditorWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(AiModesEditorWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(AiModesEditorOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(AiModesEditorOpenHandler);

  bind(AiModesEditorCommandContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AiModesEditorCommandContribution);
  bind(MenuContribution).toService(AiModesEditorCommandContribution);
});
