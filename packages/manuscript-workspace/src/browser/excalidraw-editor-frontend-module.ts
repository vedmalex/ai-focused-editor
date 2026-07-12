import '../../src/browser/style/index.css';
import URI from '@theia/core/lib/common/uri';
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import {
  ApplicationShell,
  NavigatableWidgetOptions,
  OpenHandler,
  Widget,
  WidgetFactory
} from '@theia/core/lib/browser';
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import {
  ExcalidrawEditorWidget,
  ExcalidrawExportModule,
  ExcalidrawExportSource
} from './excalidraw-editor-widget';
import { ExcalidrawEditorOpenHandler } from './excalidraw-editor-open-handler';
import { ExcalidrawCanvasOpsContribution } from './excalidraw-canvas-ops-contribution';

type ExcalidrawExportFormat = 'png' | 'svg';

/**
 * Padding (px) added around the scene bounds when rasterizing/serializing an
 * export, so shapes near the edge are not clipped flush to the border.
 */
const EXCALIDRAW_EXPORT_PADDING = 16;

export namespace ExcalidrawExportCommands {
  // en labels are the source of truth; ru comes from i18n/ru/excalidraw.json
  // keyed by `ai-focused-editor/excalidraw/*`. The label carries its own prefix
  // (no `category`), so only a label key is passed to `toLocalizedCommand`.
  export const EXPORT_PNG: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.excalidraw.exportPng',
      label: 'Export Diagram as PNG'
    },
    'ai-focused-editor/excalidraw/export-png'
  );

  export const EXPORT_SVG: Command = Command.toLocalizedCommand(
    {
      id: 'ai-focused-editor.excalidraw.exportSvg',
      label: 'Export Diagram as SVG'
    },
    'ai-focused-editor/excalidraw/export-svg'
  );
}

/**
 * Commands + tab toolbar buttons to export the active `.excalidraw` diagram to a
 * PNG or SVG written next to the source file (`<name>.excalidraw.png` / `.svg`),
 * with an offer to insert a relative image reference into the active Markdown
 * chapter. Reuses the widget's already-resolved Excalidraw module (no second
 * dynamic import) and its live scene snapshot.
 */
@injectable()
export class ExcalidrawExportContribution implements CommandContribution, TabBarToolbarContribution {
  @inject(ApplicationShell)
  protected readonly shell!: ApplicationShell;

  @inject(FileService)
  protected readonly fileService!: FileService;

  @inject(MessageService)
  protected readonly messageService!: MessageService;

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(ExcalidrawExportCommands.EXPORT_PNG, {
      execute: (widget?: unknown) => this.exportDiagram('png', widget),
      isEnabled: (widget?: unknown) => !!this.resolveWidget(widget),
      isVisible: (widget?: unknown) => !!this.resolveWidget(widget)
    });
    registry.registerCommand(ExcalidrawExportCommands.EXPORT_SVG, {
      execute: (widget?: unknown) => this.exportDiagram('svg', widget),
      isEnabled: (widget?: unknown) => !!this.resolveWidget(widget),
      isVisible: (widget?: unknown) => !!this.resolveWidget(widget)
    });
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: 'ai-focused-editor.excalidraw.exportPng.toolbar',
      command: ExcalidrawExportCommands.EXPORT_PNG.id,
      icon: 'codicon codicon-export',
      tooltip: nls.localize('ai-focused-editor/excalidraw/export-png', 'Export Diagram as PNG'),
      priority: 0,
      isVisible: (widget: Widget) => widget instanceof ExcalidrawEditorWidget
    });
    registry.registerItem({
      id: 'ai-focused-editor.excalidraw.exportSvg.toolbar',
      command: ExcalidrawExportCommands.EXPORT_SVG.id,
      icon: 'codicon codicon-export',
      tooltip: nls.localize('ai-focused-editor/excalidraw/export-svg', 'Export Diagram as SVG'),
      priority: 1,
      isVisible: (widget: Widget) => widget instanceof ExcalidrawEditorWidget
    });
  }

  /**
   * Prefer the widget passed by the tab toolbar; otherwise fall back to the
   * active/current shell widget so the command palette works too.
   */
  protected resolveWidget(candidate?: unknown): ExcalidrawEditorWidget | undefined {
    if (candidate instanceof ExcalidrawEditorWidget) {
      return candidate;
    }
    const active = this.shell.activeWidget ?? this.shell.currentWidget;
    return active instanceof ExcalidrawEditorWidget ? active : undefined;
  }

  protected async exportDiagram(format: ExcalidrawExportFormat, widgetArg?: unknown): Promise<void> {
    const widget = this.resolveWidget(widgetArg);
    if (!widget) {
      await this.messageService.warn(nls.localize(
        'ai-focused-editor/excalidraw/export-no-widget',
        'Open an Excalidraw diagram before exporting it.'
      ));
      return;
    }

    const module = widget.getExportModule();
    const source = widget.getExportSource();
    const sourceUri = widget.getResourceUri();
    if (!module || !source || !sourceUri) {
      await this.messageService.warn(nls.localize(
        'ai-focused-editor/excalidraw/export-not-ready',
        'The diagram is still loading; try again in a moment.'
      ));
      return;
    }

    const targetUri = new URI(`${sourceUri.toString()}.${format}`);
    try {
      if (format === 'png') {
        const buffer = await this.renderPng(module, source);
        await this.fileService.writeFile(targetUri, BinaryBuffer.wrap(buffer));
      } else {
        const svg = await this.renderSvg(module, source);
        await this.fileService.write(targetUri, svg);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.messageService.error(nls.localize(
        'ai-focused-editor/excalidraw/export-failed',
        'Could not export the diagram: {0}',
        detail
      ));
      return;
    }

    await this.reportAndOfferInsert(targetUri);
  }

  protected async renderPng(module: ExcalidrawExportModule, source: ExcalidrawExportSource): Promise<Uint8Array> {
    const blob = await module.exportToBlob({
      elements: source.elements,
      appState: { ...source.appState, exportBackground: source.appState.exportBackground !== false },
      files: source.files,
      exportPadding: EXCALIDRAW_EXPORT_PADDING,
      mimeType: 'image/png'
    });
    return new Uint8Array(await blob.arrayBuffer());
  }

  protected async renderSvg(module: ExcalidrawExportModule, source: ExcalidrawExportSource): Promise<string> {
    const svg = await module.exportToSvg({
      elements: source.elements,
      appState: { ...source.appState, exportBackground: source.appState.exportBackground !== false },
      files: source.files,
      exportPadding: EXCALIDRAW_EXPORT_PADDING
    });
    return new XMLSerializer().serializeToString(svg);
  }

  /**
   * Confirm where the export landed and, when a Markdown editor is active, offer
   * to insert a relative `![name](path)` image reference at its caret.
   */
  protected async reportAndOfferInsert(targetUri: URI): Promise<void> {
    const markdownEditor = this.getMarkdownEditor();
    const location = targetUri.path.base;
    if (!markdownEditor) {
      await this.messageService.info(nls.localize(
        'ai-focused-editor/excalidraw/export-written',
        'Diagram exported to {0}',
        location
      ));
      return;
    }

    const insertAction = nls.localize('ai-focused-editor/excalidraw/export-insert-action', 'Insert into chapter');
    const chosen = await this.messageService.info(
      nls.localize('ai-focused-editor/excalidraw/export-written', 'Diagram exported to {0}', location),
      insertAction
    );
    if (chosen === insertAction) {
      await this.insertImageReference(markdownEditor, targetUri);
    }
  }

  protected async insertImageReference(editor: TextEditor, targetUri: URI): Promise<void> {
    // Path of the image relative to the Markdown file's directory; fall back to
    // the bare filename if the two live under different roots.
    const relative = editor.uri.parent.relative(targetUri)?.toString() ?? targetUri.path.base;
    const alt = targetUri.path.name; // strips the trailing `.png`/`.svg`
    const caret = editor.cursor;
    const inserted = await editor.replaceText({
      source: 'ai-focused-editor.excalidraw.insertImage',
      replaceOperations: [{
        range: { start: caret, end: caret },
        text: `![${alt}](${relative})`
      }]
    });
    if (inserted) {
      await this.messageService.info(nls.localize(
        'ai-focused-editor/excalidraw/export-inserted',
        'Inserted image reference into {0}',
        editor.uri.path.base
      ));
    } else {
      await this.messageService.warn(nls.localize(
        'ai-focused-editor/excalidraw/export-insert-failed',
        'Could not insert the image reference into the chapter.'
      ));
    }
  }

  protected getMarkdownEditor(): TextEditor | undefined {
    const editor = this.editorManager.currentEditor?.editor ?? this.editorManager.activeEditor?.editor;
    if (!editor) {
      return undefined;
    }
    const isMarkdown = editor.uri.path.ext.toLowerCase() === '.md' || editor.document.languageId === 'markdown';
    return isMarkdown ? editor : undefined;
  }
}

/**
 * Standalone frontend module for the `.excalidraw` diagram editor. Registered as
 * an additional `theiaExtensions` frontend entry (the office-preview pattern) so
 * the heavy, bundler-sensitive Excalidraw dependency stays isolated from the
 * main frontend module.
 */
export default new ContainerModule(bind => {
  // Transient: the WidgetManager caches one widget per file URI, so each diagram
  // gets its own instance.
  bind(ExcalidrawEditorWidget).toSelf().inTransientScope();
  bind(WidgetFactory).toDynamicValue(ctx => ({
    id: ExcalidrawEditorWidget.FACTORY_ID,
    createWidget: (options: NavigatableWidgetOptions) => {
      const widget = ctx.container.get(ExcalidrawEditorWidget);
      widget.configure(new URI(options.uri));
      return widget;
    }
  })).inSingletonScope();

  bind(ExcalidrawEditorOpenHandler).toSelf().inSingletonScope();
  bind(OpenHandler).toService(ExcalidrawEditorOpenHandler);

  bind(ExcalidrawExportContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ExcalidrawExportContribution);
  bind(TabBarToolbarContribution).toService(ExcalidrawExportContribution);

  bind(ExcalidrawCanvasOpsContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ExcalidrawCanvasOpsContribution);
  bind(MenuContribution).toService(ExcalidrawCanvasOpsContribution);
  bind(TabBarToolbarContribution).toService(ExcalidrawCanvasOpsContribution);
});
