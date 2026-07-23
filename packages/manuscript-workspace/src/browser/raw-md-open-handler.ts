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
import { NAVIGATOR_CONTEXT_MENU } from '@theia/navigator/lib/browser/navigator-contribution';
import { inject, injectable } from '@theia/core/shared/inversify';
import { isRawMdPath } from '../common';
import { RawMdWidget } from './raw-md-widget';

/**
 * Priority returned for a `transcription/**\/raw.md` file. Sits BELOW the
 * `500` form-editor open handlers (`TranscriptCheckOpenHandler` claims
 * `transcriptset.yaml`, never `raw.md`) and ABOVE the `400` media viewer
 * (`raw.md` is never a media path either) — the only real competitor is the
 * text editor's `EditorManager` at `100`. The exact number between 400 and
 * 500 is cosmetic (PLAN §8b ISS-162): the predicates are mutually exclusive,
 * so any value `> 100` makes the structural viewer the default opener while
 * "Open as Text" (below) stays reachable.
 */
const RAW_MD_VIEWER_PRIORITY = 450;

function isRawMdUri(uri: URI): boolean {
  return isRawMdPath(uri.path.toString());
}

@injectable()
export class RawMdOpenHandler extends NavigatableWidgetOpenHandler<RawMdWidget> {
  readonly id = RawMdWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/transcript/raw-md-open-handler-label', 'Transcript Full Text (raw.md)');

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isRawMdUri(uri) ? RAW_MD_VIEWER_PRIORITY : 0;
  }
}

export namespace RawMdCommands {
  export const OPEN_AS_TEXT: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.transcript.openRawMdAsText',
      label: 'AI Focused Editor: Open raw.md As Text'
    },
    'ai-focused-editor/transcript/open-raw-md-as-text-command'
  );
}

/**
 * The "Open as Text" escape hatch for `raw.md` (UR-008 O1): opens the raw
 * Markdown file in the text editor for the rare case the user wants to edit
 * bytes directly, symmetric with `MediaViewerCommands.OPEN_AS_TEXT` /
 * `TranscriptCheckCommands.OPEN_RAW_YAML`. Registered on the file-tree
 * context menu.
 */
@injectable()
export class RawMdCommandContribution implements CommandContribution, MenuContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(RawMdCommands.OPEN_AS_TEXT, {
      isEnabled: (arg?: unknown) => this.canResolveRawMd(arg),
      isVisible: (arg?: unknown) => this.canResolveRawMd(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri || !isRawMdUri(uri)) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/transcript/select-raw-md-first',
            'Select a raw.md file first.'
          ));
          return;
        }
        // EditorManager is the text-editor open handler, so opening through it
        // bypasses the viewer's higher priority and always shows raw Markdown.
        await this.editorManager.open(uri);
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction([...NAVIGATOR_CONTEXT_MENU, 'navigation'], {
      commandId: RawMdCommands.OPEN_AS_TEXT.id
    });
  }

  protected canResolveRawMd(arg?: unknown): boolean {
    const uri = this.resolveUri(arg);
    return uri !== undefined && isRawMdUri(uri);
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
