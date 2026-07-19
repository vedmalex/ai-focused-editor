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
  FrontendApplication,
  FrontendApplicationContribution,
  KeybindingContribution,
  KeybindingRegistry,
  Navigatable,
  NavigatableWidgetOpenHandler,
  WidgetOpenerOptions
} from '@theia/core/lib/browser';
import { ContextKey, ContextKeyService } from '@theia/core/lib/browser/context-key-service';
import { nls } from '@theia/core/lib/common/nls';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EDITOR_CONTEXT_MENU } from '@theia/editor/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { isTranscriptsetPath } from '../common';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { TRANSCRIPT_EDITOR_CONTEXT_KEY, TranscriptCheckWidget } from './transcript-check-widget';

/**
 * Priority returned for a `transcription/**\/transcriptset.yaml` sidecar. The
 * text editor's `EditorManager` returns `100`, so `500` makes the Transcript
 * Check editor the default opener while the raw YAML stays reachable through
 * the "Open Raw YAML" command / "Open With..." (proofreading pattern).
 */
const TRANSCRIPT_PRIORITY = 500;

function isTranscriptsetFile(uri: URI): boolean {
  return isTranscriptsetPath(uri.path.toString());
}

@injectable()
export class TranscriptCheckOpenHandler extends NavigatableWidgetOpenHandler<TranscriptCheckWidget> {
  readonly id = TranscriptCheckWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/transcript/open-handler-label', 'Transcript Check Editor');

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isTranscriptsetFile(uri) ? TRANSCRIPT_PRIORITY : 0;
  }
}

export namespace TranscriptCheckCommands {
  export const OPEN_RAW_YAML: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.transcript.openRaw',
      label: 'AI Focused Editor: Open Transcript Set YAML (Raw)'
    },
    'ai-focused-editor/transcript/open-raw-yaml'
  );

  export const GENERATE_RAW_MD: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.transcript.generateRawMd',
      label: 'AI Focused Editor: Regenerate Transcript raw.md'
    },
    'ai-focused-editor/transcript/generate-raw-md'
  );

  // Keyboard commands of the transcript editor. All are gated on the
  // TRANSCRIPT_EDITOR_CONTEXT_KEY `when` clause (set while a Transcript Check
  // widget is the shell's current widget) — see registerKeybindings.
  export const PLAY_PAUSE = { id: 'ai-focused-editor.transcript.playPause' };
  export const RATE_UP = { id: 'ai-focused-editor.transcript.rateUp' };
  export const RATE_DOWN = { id: 'ai-focused-editor.transcript.rateDown' };
  export const PREV_SEGMENT = { id: 'ai-focused-editor.transcript.prevSegment' };
  export const NEXT_SEGMENT = { id: 'ai-focused-editor.transcript.nextSegment' };
  export const PREV_EMPTY = { id: 'ai-focused-editor.transcript.prevEmptySegment' };
  export const NEXT_EMPTY = { id: 'ai-focused-editor.transcript.nextEmptySegment' };
  export const PREV_FILE = { id: 'ai-focused-editor.transcript.prevFile' };
  export const NEXT_FILE = { id: 'ai-focused-editor.transcript.nextFile' };
  export const FIND = { id: 'ai-focused-editor.transcript.find' };
  export const EDIT_ACTIVE = { id: 'ai-focused-editor.transcript.editActiveSegment' };
  export const ESCAPE = { id: 'ai-focused-editor.transcript.escape' };
}

/** True when the keyboard focus sits in a text-input-like element (source guard). */
function isTextInputFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return false;
  }
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable;
}

/**
 * Commands + menus + keybindings of the Transcript Check editor, and the
 * `afeTranscriptEditor` context-key lifecycle (true while a Transcript Check
 * widget is the shell's current widget).
 *
 * KEYBOARD MAP (code-as-truth port of App.jsx `handleGlobalKey`):
 *  - Space            play/pause          (not while typing / not while editing)
 *  - Up / Down        faster / slower     (same guard)
 *  - Left / Right     prev / next segment (Shift = prev/next EMPTY segment)
 *  - Cmd/Ctrl+Up/Down prev / next file    (works while editing too)
 *  - Cmd/Ctrl+Left/Right prev / next segment (Shift = empty; works while editing)
 *  - Cmd/Ctrl+F       focus the transcript search box
 *  - Cmd/Ctrl+S       Theia core.save → the widget's Saveable.save()
 *  - Enter            edit the active segment (not while typing)
 *  - Escape           leave editing / merge mode / clear search
 * In-textarea Enter (save) / Shift+Enter (newline) / Escape are handled
 * locally by the widget's textarea handler.
 */
@injectable()
export class TranscriptCheckCommandContribution implements CommandContribution, MenuContribution, KeybindingContribution, FrontendApplicationContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(ContextKeyService)
  protected readonly contextKeyService!: ContextKeyService;

  protected transcriptEditorKey: ContextKey<boolean> | undefined;

  onStart(_app: FrontendApplication): void {
    this.transcriptEditorKey = this.contextKeyService.createKey<boolean>(TRANSCRIPT_EDITOR_CONTEXT_KEY, false);
    const sync = (): void => {
      this.transcriptEditorKey?.set(this.shell.currentWidget instanceof TranscriptCheckWidget);
    };
    this.shell.onDidChangeCurrentWidget(sync);
    this.shell.onDidChangeActiveWidget(sync);
    sync();
  }

  /** The transcript widget the keyboard commands should act on. */
  protected target(): TranscriptCheckWidget | undefined {
    const current = this.shell.currentWidget ?? this.shell.activeWidget;
    return current instanceof TranscriptCheckWidget ? current : undefined;
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(TranscriptCheckCommands.OPEN_RAW_YAML, {
      isEnabled: (arg?: unknown) => this.canResolveTranscriptset(arg),
      isVisible: (arg?: unknown) => this.canResolveTranscriptset(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/transcript/select-first',
            'Select a transcriptset.yaml file first.'
          ));
          return;
        }
        // EditorManager is the text-editor open handler, so this bypasses the
        // transcript editor's higher priority and always opens raw YAML.
        await this.editorManager.open(uri);
      }
    });

    commands.registerCommand(TranscriptCheckCommands.GENERATE_RAW_MD, {
      isEnabled: () => this.target() !== undefined,
      isVisible: () => this.target() !== undefined,
      execute: () => this.target()?.generateRawMdFile()
    });

    // Plain keys — blocked while typing in inputs AND while a segment is being
    // edited (source: plain keys are ignored during editing).
    const plainKeyEnabled = (): boolean => {
      const widget = this.target();
      return !!widget && !isTextInputFocused() && widget.canHandlePlainKeys();
    };
    commands.registerCommand(TranscriptCheckCommands.PLAY_PAUSE, {
      isEnabled: plainKeyEnabled,
      execute: () => this.target()?.togglePlayPause()
    });
    commands.registerCommand(TranscriptCheckCommands.RATE_UP, {
      isEnabled: plainKeyEnabled,
      execute: () => this.target()?.stepRate(1)
    });
    commands.registerCommand(TranscriptCheckCommands.RATE_DOWN, {
      isEnabled: plainKeyEnabled,
      execute: () => this.target()?.stepRate(-1)
    });
    commands.registerCommand(TranscriptCheckCommands.EDIT_ACTIVE, {
      isEnabled: plainKeyEnabled,
      execute: () => this.target()?.editActiveSegment()
    });

    // Segment/file navigation — the ctrlcmd variants stay usable while editing
    // (source: cmd-modified keys pass the editing guard); the plain variants
    // are separate keybindings on the same commands with the plain guard
    // applied inside execute via canHandlePlainKeys when unmodified. To keep
    // enablement exact per binding, navigation commands check only the widget;
    // the PLAIN keybindings additionally go through the *Plain wrappers below.
    commands.registerCommand(TranscriptCheckCommands.PREV_SEGMENT, {
      isEnabled: () => this.target() !== undefined && !isTextInputFocused(),
      execute: () => this.target()?.navigateSegment(-1)
    });
    commands.registerCommand(TranscriptCheckCommands.NEXT_SEGMENT, {
      isEnabled: () => this.target() !== undefined && !isTextInputFocused(),
      execute: () => this.target()?.navigateSegment(1)
    });
    commands.registerCommand(TranscriptCheckCommands.PREV_EMPTY, {
      isEnabled: () => this.target() !== undefined && !isTextInputFocused(),
      execute: () => this.target()?.navigateEmptySegment(-1)
    });
    commands.registerCommand(TranscriptCheckCommands.NEXT_EMPTY, {
      isEnabled: () => this.target() !== undefined && !isTextInputFocused(),
      execute: () => this.target()?.navigateEmptySegment(1)
    });
    commands.registerCommand(TranscriptCheckCommands.PREV_FILE, {
      isEnabled: () => this.target() !== undefined,
      execute: () => this.target()?.navigateFile(-1)
    });
    commands.registerCommand(TranscriptCheckCommands.NEXT_FILE, {
      isEnabled: () => this.target() !== undefined,
      execute: () => this.target()?.navigateFile(1)
    });
    commands.registerCommand(TranscriptCheckCommands.FIND, {
      isEnabled: () => this.target() !== undefined,
      execute: () => this.target()?.focusSearch()
    });
    commands.registerCommand(TranscriptCheckCommands.ESCAPE, {
      isEnabled: () => this.target() !== undefined && !isTextInputFocused(),
      execute: () => this.target()?.handleEscape()
    });
  }

  registerKeybindings(keybindings: KeybindingRegistry): void {
    const when = TRANSCRIPT_EDITOR_CONTEXT_KEY;
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.PLAY_PAUSE.id, keybinding: 'space', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.RATE_UP.id, keybinding: 'up', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.RATE_DOWN.id, keybinding: 'down', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.PREV_SEGMENT.id, keybinding: 'left', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.NEXT_SEGMENT.id, keybinding: 'right', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.PREV_EMPTY.id, keybinding: 'shift+left', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.NEXT_EMPTY.id, keybinding: 'shift+right', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.PREV_SEGMENT.id, keybinding: 'ctrlcmd+left', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.NEXT_SEGMENT.id, keybinding: 'ctrlcmd+right', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.PREV_EMPTY.id, keybinding: 'ctrlcmd+shift+left', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.NEXT_EMPTY.id, keybinding: 'ctrlcmd+shift+right', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.PREV_FILE.id, keybinding: 'ctrlcmd+up', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.NEXT_FILE.id, keybinding: 'ctrlcmd+down', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.FIND.id, keybinding: 'ctrlcmd+f', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.EDIT_ACTIVE.id, keybinding: 'enter', when });
    keybindings.registerKeybinding({ command: TranscriptCheckCommands.ESCAPE.id, keybinding: 'esc', when });
    // Cmd/Ctrl+S is NOT registered here: Theia's core.save already routes to
    // the active Saveable widget, i.e. TranscriptCheckWidget.save().
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, {
      commandId: TranscriptCheckCommands.OPEN_RAW_YAML.id
    });
    menus.registerMenuAction([...EDITOR_CONTEXT_MENU, 'navigation'], {
      commandId: TranscriptCheckCommands.OPEN_RAW_YAML.id
    });
  }

  protected canResolveTranscriptset(arg?: unknown): boolean {
    const uri = this.resolveUri(arg);
    return uri !== undefined && isTranscriptsetFile(uri);
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
