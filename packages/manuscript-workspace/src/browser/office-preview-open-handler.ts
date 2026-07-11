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
import { isOfficePreviewFile } from '../common';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';
import { OfficePreviewWidget } from './office-preview-widget';

/**
 * Priority returned for office documents. The text editor's `EditorManager`
 * returns `100`, so `500` makes the preview the default opener while the text
 * editor stays reachable through "Open With...". Legacy .doc/.ppt are claimed
 * too, so they open the friendly "unsupported" card instead of binary garbage
 * in Monaco.
 */
const OFFICE_PREVIEW_PRIORITY = 500;

function isOfficeDocument(uri: URI): boolean {
  return isOfficePreviewFile(uri.path.toString());
}

@injectable()
export class OfficePreviewOpenHandler extends NavigatableWidgetOpenHandler<OfficePreviewWidget> {
  readonly id = OfficePreviewWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/office/open-handler-label', 'Office Document Preview');

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isOfficeDocument(uri) ? OFFICE_PREVIEW_PRIORITY : 0;
  }
}

export namespace OfficePreviewCommands {
  export const OPEN_PREVIEW: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.office.openPreview',
      label: 'AI Focused Editor: Preview Office Document'
    },
    'ai-focused-editor/office/open-preview'
  );

  export const OPEN_AS_TEXT: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.office.openAsText',
      label: 'AI Focused Editor: Open Office Document As Text'
    },
    'ai-focused-editor/office/open-as-text-command'
  );
}

@injectable()
export class OfficePreviewCommandContribution implements CommandContribution, MenuContribution {
  @inject(OfficePreviewOpenHandler)
  protected readonly openHandler!: OfficePreviewOpenHandler;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OfficePreviewCommands.OPEN_PREVIEW, {
      isEnabled: (arg?: unknown) => this.canResolveOffice(arg),
      isVisible: (arg?: unknown) => this.canResolveOffice(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri || !isOfficeDocument(uri)) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/office/only-office',
            'Preview is only available for office documents (.docx, .xlsx, .xls, .ods, .pptx, .doc, .ppt).'
          ));
          return;
        }
        await this.openHandler.open(uri);
      }
    });

    commands.registerCommand(OfficePreviewCommands.OPEN_AS_TEXT, {
      isEnabled: (arg?: unknown) => this.canResolveOffice(arg),
      isVisible: (arg?: unknown) => this.canResolveOffice(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri) {
          await this.messageService.warn(nls.localize('ai-focused-editor/office/select-first', 'Select an office document first.'));
          return;
        }
        // EditorManager is the text-editor open handler, so this bypasses the
        // preview's higher priority and always opens the raw file.
        await this.editorManager.open(uri);
      }
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, {
      commandId: OfficePreviewCommands.OPEN_PREVIEW.id
    });
    menus.registerMenuAction(AiFocusedEditorMenus.KNOWLEDGE, {
      commandId: OfficePreviewCommands.OPEN_AS_TEXT.id
    });
    menus.registerMenuAction([...EDITOR_CONTEXT_MENU, 'navigation'], {
      commandId: OfficePreviewCommands.OPEN_PREVIEW.id
    });
  }

  protected canResolveOffice(arg?: unknown): boolean {
    const uri = this.resolveUri(arg);
    return uri !== undefined && isOfficeDocument(uri);
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
