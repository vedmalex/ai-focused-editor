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
import { isImagePath } from '../common';
import { ImageViewerWidget } from './image-viewer-widget';

/**
 * Priority returned for image files. The text editor's `EditorManager` returns
 * `100`, so `400` makes the image viewer the default opener while the raw bytes
 * stay reachable through the "Open as Text" command / "Open With...".
 *
 * It sits BELOW the `500` form-editor open handlers (excalidraw, office,
 * proofreading, entity editors …). Those `500` handlers each claim only their own
 * specific NON-image files (`.excalidraw`, `.docx`, `proofset.yaml`, …), which
 * never overlap with image extensions — so for an image URI only this handler
 * (`400`) and the text editor (`100`) compete, and the viewer wins.
 */
const IMAGE_VIEWER_PRIORITY = 400;

function isImageUri(uri: URI): boolean {
  return isImagePath(uri.path.toString());
}

@injectable()
export class ImageViewerOpenHandler extends NavigatableWidgetOpenHandler<ImageViewerWidget> {
  readonly id = ImageViewerWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/image-viewer/open-handler-label', 'Image Viewer');

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isImageUri(uri) ? IMAGE_VIEWER_PRIORITY : 0;
  }
}

export namespace ImageViewerCommands {
  export const OPEN_AS_TEXT: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.image.openAsText',
      label: 'AI Focused Editor: Open Image As Text'
    },
    'ai-focused-editor/image-viewer/open-as-text-command'
  );
}

/**
 * The "Open as Text" escape hatch for image files: opens the raw file in the text
 * editor for the rare case the user really wants the bytes-as-text (e.g. to inspect
 * an SVG's markup). Registered on the file-tree context menu.
 */
@injectable()
export class ImageViewerCommandContribution implements CommandContribution, MenuContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ImageViewerCommands.OPEN_AS_TEXT, {
      isEnabled: (arg?: unknown) => this.canResolveImage(arg),
      isVisible: (arg?: unknown) => this.canResolveImage(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri || !isImageUri(uri)) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/image-viewer/select-first',
            'Select an image file first.'
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
      commandId: ImageViewerCommands.OPEN_AS_TEXT.id
    });
  }

  protected canResolveImage(arg?: unknown): boolean {
    const uri = this.resolveUri(arg);
    return uri !== undefined && isImageUri(uri);
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
