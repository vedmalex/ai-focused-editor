import URI from '@theia/core/lib/common/uri';
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService,
  SelectionService,
  UriSelection
} from '@theia/core/lib/common';
import {
  ApplicationShell,
  Navigatable,
  NavigatableWidgetOpenHandler,
  WidgetOpenerOptions
} from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EDITOR_CONTEXT_MENU } from '@theia/editor/lib/browser';
import {
  inject,
  injectable
} from '@theia/core/shared/inversify';
import {
  AI_FOCUSED_EDITOR_MENU_LABEL,
  AiFocusedEditorMenus
} from './ai-focused-editor-menu';
import { EntityEditorWidget, entityDescriptorForUri } from './entity-editor-widget';

/**
 * Priority returned for entity YAML files. The text editor's `EditorManager`
 * returns `100`, so a higher value makes the form editor the default opener
 * while the text editor stays reachable through "Open With...".
 */
const ENTITY_EDITOR_PRIORITY = 500;

function isEntityYaml(uri: URI): boolean {
  const path = uri.path.toString().toLowerCase();
  if (!path.endsWith('.yaml') && !path.endsWith('.yml')) {
    return false;
  }
  return entityDescriptorForUri(uri) !== undefined;
}

@injectable()
export class EntityEditorOpenHandler extends NavigatableWidgetOpenHandler<EntityEditorWidget> {
  readonly id = EntityEditorWidget.FACTORY_ID;
  readonly label = 'Entity Form Editor';

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isEntityYaml(uri) ? ENTITY_EDITOR_PRIORITY : 0;
  }
}

export namespace EntityEditorCommands {
  export const OPEN_WITH_FORM_EDITOR: Command = {
    id: 'ai-focused-editor.entity.openFormEditor',
    label: 'AI Focused Editor: Open With Form Editor'
  };

  export const OPEN_RAW_YAML: Command = {
    id: 'ai-focused-editor.entity.openRawYaml',
    label: 'AI Focused Editor: Open Entity YAML (Raw)'
  };
}

@injectable()
export class EntityEditorCommandContribution implements CommandContribution, MenuContribution {
  @inject(EntityEditorOpenHandler)
  protected readonly openHandler!: EntityEditorOpenHandler;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(EntityEditorCommands.OPEN_WITH_FORM_EDITOR, {
      isEnabled: (arg?: unknown) => this.canResolveEntity(arg),
      isVisible: (arg?: unknown) => this.canResolveEntity(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri || !isEntityYaml(uri)) {
          await this.messageService.warn('Open Form Editor is only available for entity YAML files (entities/**/*.yaml).');
          return;
        }
        await this.openHandler.open(uri);
      }
    });

    commands.registerCommand(EntityEditorCommands.OPEN_RAW_YAML, {
      isEnabled: (arg?: unknown) => this.canResolveEntity(arg),
      isVisible: (arg?: unknown) => this.canResolveEntity(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri) {
          await this.messageService.warn('Select an entity YAML file first.');
          return;
        }
        // EditorManager is the text-editor open handler, so this bypasses the
        // form editor's higher priority and always opens raw YAML.
        await this.editorManager.open(uri);
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, {
      commandId: EntityEditorCommands.OPEN_WITH_FORM_EDITOR.id
    });
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, {
      commandId: EntityEditorCommands.OPEN_RAW_YAML.id
    });
    menus.registerMenuAction([...EDITOR_CONTEXT_MENU, 'navigation'], {
      commandId: EntityEditorCommands.OPEN_WITH_FORM_EDITOR.id
    });
  }

  protected canResolveEntity(arg?: unknown): boolean {
    const uri = this.resolveUri(arg);
    return uri !== undefined && isEntityYaml(uri);
  }

  protected resolveUri(arg?: unknown): URI | undefined {
    if (arg instanceof URI) {
      return arg;
    }
    const fromSelection = UriSelection.getUri(this.selectionService.selection);
    if (fromSelection) {
      return fromSelection;
    }
    // Also handle the case where the form editor (or any navigatable widget) is
    // the active widget, e.g. when the command is run from the command palette.
    const activeWidget = this.shell.currentWidget ?? this.shell.activeWidget;
    if (Navigatable.is(activeWidget)) {
      const resourceUri = activeWidget.getResourceUri();
      if (resourceUri) {
        return resourceUri;
      }
    }
    return this.editorManager.currentEditor?.editor.uri
      ?? this.editorManager.activeEditor?.editor.uri;
  }
}
