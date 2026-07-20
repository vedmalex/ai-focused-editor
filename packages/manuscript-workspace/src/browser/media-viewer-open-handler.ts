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
import { isMediaPath } from '../common';
import { MediaViewerWidget } from './media-viewer-widget';

/**
 * Priority returned for audio/video files. The text editor's `EditorManager`
 * returns `100`, so `400` (the image viewer's number) makes the media viewer
 * the default opener — media never opens as garbage bytes in the text editor —
 * while the raw file stays reachable through "Open as Text" / "Open With...".
 *
 * It sits BELOW the `500` form-editor open handlers (excalidraw, office,
 * proofreading, transcript-check, entity editors …). Those `500` handlers each
 * claim only their own specific NON-media files (`.excalidraw`, `.docx`,
 * `transcriptset.yaml`, …), which never overlap with media extensions — so for
 * a media URI only this handler (`400`) and the text editor (`100`) compete,
 * and the viewer wins. The transcript-check widget loads its media internally
 * (never through the OpenerService), so its playback is unaffected.
 */
const MEDIA_VIEWER_PRIORITY = 400;

function isMediaUri(uri: URI): boolean {
  return isMediaPath(uri.path.toString());
}

@injectable()
export class MediaViewerOpenHandler extends NavigatableWidgetOpenHandler<MediaViewerWidget> {
  readonly id = MediaViewerWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/media-viewer/open-handler-label', 'Media Player');

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isMediaUri(uri) ? MEDIA_VIEWER_PRIORITY : 0;
  }
}

export namespace MediaViewerCommands {
  export const OPEN_AS_TEXT: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.media.openAsText',
      label: 'AI Focused Editor: Open Media File As Text'
    },
    'ai-focused-editor/media-viewer/open-as-text-command'
  );
}

/**
 * The "Open as Text" escape hatch for media files: opens the raw file in the
 * text editor for the rare case the user really wants the bytes-as-text.
 * Registered on the file-tree context menu (image-viewer pattern).
 */
@injectable()
export class MediaViewerCommandContribution implements CommandContribution, MenuContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(MediaViewerCommands.OPEN_AS_TEXT, {
      isEnabled: (arg?: unknown) => this.canResolveMedia(arg),
      isVisible: (arg?: unknown) => this.canResolveMedia(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri || !isMediaUri(uri)) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/media-viewer/select-first',
            'Select an audio or video file first.'
          ));
          return;
        }
        // EditorManager is the text-editor open handler, so opening through it
        // bypasses the viewer's higher priority and always shows the raw bytes.
        await this.editorManager.open(uri);
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction([...NAVIGATOR_CONTEXT_MENU, 'navigation'], {
      commandId: MediaViewerCommands.OPEN_AS_TEXT.id
    });
  }

  protected canResolveMedia(arg?: unknown): boolean {
    const uri = this.resolveUri(arg);
    return uri !== undefined && isMediaUri(uri);
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
