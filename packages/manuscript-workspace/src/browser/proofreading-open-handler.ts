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
import { inject, injectable } from '@theia/core/shared/inversify';
import { isProofsetPath } from '../common';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { ProofreadingWidget } from './proofreading-widget';

/**
 * Priority returned for a `proofreading/**\/proofset.yaml` sidecar. The text
 * editor's `EditorManager` returns `100`, so `500` makes the two-pane
 * Proofreading editor the default opener while the raw YAML stays reachable
 * through the "Open Raw YAML" command / "Open With..." (excalidraw pattern).
 */
const PROOFREADING_PRIORITY = 500;

function isProofsetFile(uri: URI): boolean {
  return isProofsetPath(uri.path.toString());
}

@injectable()
export class ProofreadingOpenHandler extends NavigatableWidgetOpenHandler<ProofreadingWidget> {
  readonly id = ProofreadingWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/proofreading/open-handler-label', 'Proofreading Editor');

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isProofsetFile(uri) ? PROOFREADING_PRIORITY : 0;
  }
}

export namespace ProofreadingCommands {
  export const OPEN_RAW_YAML: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.proofreading.openRaw',
      label: 'AI Focused Editor: Open Proofreading YAML (Raw)'
    },
    'ai-focused-editor/proofreading/open-raw-yaml'
  );
}

@injectable()
export class ProofreadingCommandContribution implements CommandContribution, MenuContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ProofreadingCommands.OPEN_RAW_YAML, {
      isEnabled: (arg?: unknown) => this.canResolveProofset(arg),
      isVisible: (arg?: unknown) => this.canResolveProofset(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/proofreading/select-first',
            'Select a proofset.yaml file first.'
          ));
          return;
        }
        // EditorManager is the text-editor open handler, so this bypasses the
        // proofreading editor's higher priority and always opens raw YAML.
        await this.editorManager.open(uri);
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, {
      commandId: ProofreadingCommands.OPEN_RAW_YAML.id
    });
    menus.registerMenuAction([...EDITOR_CONTEXT_MENU, 'navigation'], {
      commandId: ProofreadingCommands.OPEN_RAW_YAML.id
    });
  }

  protected canResolveProofset(arg?: unknown): boolean {
    const uri = this.resolveUri(arg);
    return uri !== undefined && isProofsetFile(uri);
  }

  protected resolveUri(arg?: unknown): URI | undefined {
    if (arg instanceof URI) {
      return arg;
    }
    const fromSelection = UriSelection.getUri(this.selectionService.selection);
    if (fromSelection) {
      return fromSelection;
    }
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
