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
import { PROOFREADING_EDITOR_CONTEXT_KEY, ProofreadingWidget } from './proofreading-widget';

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

  /**
   * The six scoped AI actions of the embedded proofreading editor, surfaced as
   * Theia commands. Theia's `MonacoContextMenuService` renders every Monaco
   * context menu from Theia's `EDITOR_CONTEXT_MENU` menu path (ignoring
   * `editor.addAction` items), so these are what actually appears on
   * right-click; a `when: PROOFREADING_EDITOR_CONTEXT_KEY` clause keeps them
   * out of regular file editors. Ids/labels mirror the widget's
   * `registerScopedAiActions`.
   */
  export const SCOPED_AI: Command[] = [
    Command.toLocalizedCommand(
      { id: 'ai-focused-editor.proofreading.proofreadSelection', label: 'AI: proofread selection' },
      'ai-focused-editor/proofreading/scope-proofread-selection'
    ),
    Command.toLocalizedCommand(
      { id: 'ai-focused-editor.proofreading.proofreadParagraph', label: 'AI: proofread paragraph' },
      'ai-focused-editor/proofreading/scope-proofread-paragraph'
    ),
    Command.toLocalizedCommand(
      { id: 'ai-focused-editor.proofreading.proofreadSentence', label: 'AI: proofread sentence' },
      'ai-focused-editor/proofreading/scope-proofread-sentence'
    ),
    Command.toLocalizedCommand(
      { id: 'ai-focused-editor.proofreading.proofreadWord', label: 'AI: proofread word' },
      'ai-focused-editor/proofreading/scope-proofread-word'
    ),
    Command.toLocalizedCommand(
      { id: 'ai-focused-editor.proofreading.customSelectionCommand', label: 'AI: custom command for selection' },
      'ai-focused-editor/proofreading/scope-custom-command'
    ),
    Command.toLocalizedCommand(
      { id: 'ai-focused-editor.proofreading.undoLastAiApplication', label: 'AI: undo last AI application on this page' },
      'ai-focused-editor/proofreading/scope-undo-last'
    )
  ];
}

/** Own group right below the modification group, so the AI items cluster together. */
const PROOFREADING_AI_MENU_GROUP = [...EDITOR_CONTEXT_MENU, '2_afe_proofreading_ai'];

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

    // Scoped AI actions of the embedded proofreading editor. Handlers ignore the
    // context-menu anchor argument and dispatch to the widget whose editor holds
    // focus (right-click focuses the editor before the menu opens).
    for (const command of ProofreadingCommands.SCOPED_AI) {
      commands.registerCommand(command, {
        isEnabled: () => this.proofreadingTarget() !== undefined,
        isVisible: () => this.proofreadingTarget() !== undefined,
        execute: () => this.proofreadingTarget()?.runScopedAiAction(command.id)
      });
    }
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, {
      commandId: ProofreadingCommands.OPEN_RAW_YAML.id
    });
    menus.registerMenuAction([...EDITOR_CONTEXT_MENU, 'navigation'], {
      commandId: ProofreadingCommands.OPEN_RAW_YAML.id
    });
    // The right-click menu of the embedded proofreading editor: Theia renders
    // EDITOR_CONTEXT_MENU for every Monaco editor, and the `when` clause (matched
    // against the DOM-scoped context of the right-click target) limits these
    // items to the proofreading widget's own editor.
    ProofreadingCommands.SCOPED_AI.forEach((command, index) => {
      menus.registerMenuAction(PROOFREADING_AI_MENU_GROUP, {
        commandId: command.id,
        order: String(index),
        when: PROOFREADING_EDITOR_CONTEXT_KEY
      });
    });
  }

  /** The proofreading widget the scoped AI menu commands should act on. */
  protected proofreadingTarget(): ProofreadingWidget | undefined {
    const current = this.shell.currentWidget ?? this.shell.activeWidget;
    if (current instanceof ProofreadingWidget) {
      return current;
    }
    return ProofreadingWidget.getActiveEditorWidget();
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
