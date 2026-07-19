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
import { MAIN_MENU_BAR, MenuPath } from '@theia/core/lib/common/menu';
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
import { isDocumentPreviewFile } from '../common';
import { DocumentPreviewWidget } from './document-preview-widget';

/**
 * Priority returned for office documents. The text editor's `EditorManager`
 * returns `100`, so `500` makes the preview the default opener while the text
 * editor stays reachable through "Open With...". Legacy .doc/.ppt are claimed
 * too, so they open the friendly "unsupported" card instead of binary garbage
 * in Monaco.
 */
const DOCUMENT_PREVIEW_PRIORITY = 500;

/**
 * Mirrors manuscript-workspace's `AiFocusedEditorMenus.KNOWLEDGE` menu path.
 * Duplicated by value (not imported) so this package stays free of a dependency
 * on manuscript-workspace; the literal segments must stay in sync with
 * `ai-focused-editor-menu.ts` for the actions to land in the same product menu.
 */
const AI_FOCUSED_EDITOR_KNOWLEDGE_MENU: MenuPath = [...MAIN_MENU_BAR, '8_ai_focused_editor', '4_knowledge'];

function isPreviewableDocument(uri: URI): boolean {
  return isDocumentPreviewFile(uri.path.toString());
}

@injectable()
export class DocumentPreviewOpenHandler extends NavigatableWidgetOpenHandler<DocumentPreviewWidget> {
  readonly id = DocumentPreviewWidget.FACTORY_ID;
  readonly label = nls.localize('ai-focused-editor/office/open-handler-label', 'Office Document Preview');

  canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
    return isPreviewableDocument(uri) ? DOCUMENT_PREVIEW_PRIORITY : 0;
  }
}

export namespace DocumentPreviewCommands {
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
export class DocumentPreviewCommandContribution implements CommandContribution, MenuContribution {
  @inject(DocumentPreviewOpenHandler)
  protected readonly openHandler!: DocumentPreviewOpenHandler;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(SelectionService)
  protected readonly selectionService!: SelectionService;

  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(DocumentPreviewCommands.OPEN_PREVIEW, {
      isEnabled: (arg?: unknown) => this.canResolveDocument(arg),
      isVisible: (arg?: unknown) => this.canResolveDocument(arg),
      execute: async (arg?: unknown) => {
        const uri = this.resolveUri(arg);
        if (!uri || !isPreviewableDocument(uri)) {
          await this.messageService.warn(nls.localize(
            'ai-focused-editor/office/only-office',
            'Preview is only available for office documents (.docx, .xlsx, .xls, .ods, .pptx, .doc, .ppt).'
          ));
          return;
        }
        await this.openHandler.open(uri);
      }
    });

    commands.registerCommand(DocumentPreviewCommands.OPEN_AS_TEXT, {
      isEnabled: (arg?: unknown) => this.canResolveDocument(arg),
      isVisible: (arg?: unknown) => this.canResolveDocument(arg),
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
    menus.registerMenuAction(AI_FOCUSED_EDITOR_KNOWLEDGE_MENU, {
      commandId: DocumentPreviewCommands.OPEN_PREVIEW.id
    });
    menus.registerMenuAction(AI_FOCUSED_EDITOR_KNOWLEDGE_MENU, {
      commandId: DocumentPreviewCommands.OPEN_AS_TEXT.id
    });
    menus.registerMenuAction([...EDITOR_CONTEXT_MENU, 'navigation'], {
      commandId: DocumentPreviewCommands.OPEN_PREVIEW.id
    });
  }

  protected canResolveDocument(arg?: unknown): boolean {
    const uri = this.resolveUri(arg);
    return uri !== undefined && isPreviewableDocument(uri);
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

/** @deprecated Use {@link DocumentPreviewOpenHandler}. */
export const OfficePreviewOpenHandler = DocumentPreviewOpenHandler;
/** @deprecated Use {@link DocumentPreviewOpenHandler}. */
export type OfficePreviewOpenHandler = DocumentPreviewOpenHandler;
/** @deprecated Use {@link DocumentPreviewCommands}. */
export const OfficePreviewCommands = DocumentPreviewCommands;
/** @deprecated Use {@link DocumentPreviewCommandContribution}. */
export const OfficePreviewCommandContribution = DocumentPreviewCommandContribution;
/** @deprecated Use {@link DocumentPreviewCommandContribution}. */
export type OfficePreviewCommandContribution = DocumentPreviewCommandContribution;
