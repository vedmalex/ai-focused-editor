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
import { nls } from '@theia/core/lib/common/nls';
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
import { EntityEditorWidget, effectiveTypeForUri } from './entity-editor-widget';
import { EntityTypeRegistryService } from './entity-type-registry-service';

/**
 * Priority returned for entity YAML files. The text editor's `EditorManager`
 * returns `100`, so a higher value makes the form editor the default opener
 * while the text editor stays reachable through "Open With...".
 */
const ENTITY_EDITOR_PRIORITY = 500;

/**
 * A YAML file is an entity file when its `entities/<dir>` segment resolves to an
 * EFFECTIVE entity type — a built-in OR an author-declared one. The registry seed
 * always carries the four built-ins, so base files match immediately; author
 * directories match once their `entities/types.yaml` has been parsed.
 */
function isEntityYaml(uri: URI, registry: EntityTypeRegistryService): boolean {
  const path = uri.path.toString().toLowerCase();
  if (!path.endsWith('.yaml') && !path.endsWith('.yml')) {
    return false;
  }
  return effectiveTypeForUri(uri, registry.getEffectiveTypes()) !== undefined;
}

@injectable()
export class EntityEditorOpenHandler extends NavigatableWidgetOpenHandler<EntityEditorWidget> {
  readonly id = EntityEditorWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/entities/open-handler-label', 'Entity Form Editor');

  @inject(EntityTypeRegistryService)
  protected readonly typeRegistry!: EntityTypeRegistryService;

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isEntityYaml(uri, this.typeRegistry) ? ENTITY_EDITOR_PRIORITY : 0;
  }
}

export namespace EntityEditorCommands {
  export const OPEN_WITH_FORM_EDITOR: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.entity.openFormEditor',
      label: 'AI Focused Editor: Open With Form Editor'
    },
    'ai-focused-editor/entities/open-form-editor'
  );

  export const OPEN_RAW_YAML: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.entity.openRawYaml',
      label: 'AI Focused Editor: Open Entity YAML (Raw)'
    },
    'ai-focused-editor/entities/open-raw-yaml'
  );
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

  @inject(EntityTypeRegistryService)
  protected readonly typeRegistry!: EntityTypeRegistryService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(EntityEditorCommands.OPEN_WITH_FORM_EDITOR, {
      isEnabled: (arg?: unknown) => this.canResolveEntity(arg),
      isVisible: (arg?: unknown) => this.canResolveEntity(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri || !isEntityYaml(uri, this.typeRegistry)) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/entities/only-entity-yaml',
            'Open Form Editor is only available for entity YAML files (entities/**/*.yaml).'
          ));
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
          await this.messageService.warn(nls.localize('ai-focused-editor/entities/select-entity-first', 'Select an entity YAML file first.'));
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
    return uri !== undefined && isEntityYaml(uri, this.typeRegistry);
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
