import { parseSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import { DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { injectable, inject } from '@theia/core/shared/inversify';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { EditorDecoration } from '@theia/editor/lib/browser/decorations/editor-decoration';
import type { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import type { TextEditor } from '@theia/editor/lib/browser/editor';

const DECORATION_CLASS_PREFIX = 'afe-semantic-tag';
const DECORATION_UPDATE_DELAY_MS = 150;

/**
 * Applies the `.afe-semantic-tag` styling decorations to `[[kind:id|label]]`
 * tags in the markdown editor. Hover CONTENT is owned by the separate
 * {@link SemanticEntityHoverContribution} (a Monaco hover provider that renders
 * the full entity card), so this service sets ONLY the decoration `className` and
 * carries no `hoverMessage` — the two never duplicate rows.
 */
@injectable()
export class SemanticMarkdownDecorationService implements FrontendApplicationContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  protected readonly toDispose = new DisposableCollection();
  protected readonly editorDisposables = new Map<TextEditor, DisposableCollection>();
  protected readonly decorationIds = new Map<TextEditor, string[]>();
  protected readonly pendingUpdates = new Map<TextEditor, ReturnType<typeof setTimeout>>();

  onStart(): void {
    this.toDispose.push(this.editorManager.onCurrentEditorChanged(widget => this.trackEditor(widget)));
    this.trackEditor(this.editorManager.currentEditor ?? this.editorManager.activeEditor);
  }

  onStop(): void {
    this.toDispose.dispose();
    for (const editor of this.editorDisposables.keys()) {
      this.clearDecorations(editor);
    }
    this.editorDisposables.clear();
  }

  protected trackEditor(widget: EditorWidget | undefined): void {
    const editor = widget?.editor;
    if (!editor || this.editorDisposables.has(editor)) {
      return;
    }

    const disposables = new DisposableCollection();
    this.editorDisposables.set(editor, disposables);
    disposables.push(editor.onDocumentContentChanged(() => this.scheduleUpdate(editor)));
    disposables.push(editor.onLanguageChanged(() => this.scheduleUpdate(editor)));
    disposables.push(widget.onDispose(() => {
      this.cancelScheduledUpdate(editor);
      this.clearDecorations(editor);
      this.editorDisposables.get(editor)?.dispose();
      this.editorDisposables.delete(editor);
    }));

    this.updateDecorations(editor);
  }

  /**
   * Re-parsing the whole document on every keystroke stalls typing in large
   * chapters; coalesce bursts of edits into one parse per delay window.
   */
  protected scheduleUpdate(editor: TextEditor): void {
    this.cancelScheduledUpdate(editor);
    this.pendingUpdates.set(editor, setTimeout(() => {
      this.pendingUpdates.delete(editor);
      this.updateDecorations(editor);
    }, DECORATION_UPDATE_DELAY_MS));
  }

  protected cancelScheduledUpdate(editor: TextEditor): void {
    const pending = this.pendingUpdates.get(editor);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingUpdates.delete(editor);
    }
  }

  protected updateDecorations(editor: TextEditor): void {
    void this.doUpdateDecorations(editor);
  }

  protected async doUpdateDecorations(editor: TextEditor): Promise<void> {
    if (!this.isMarkdownEditor(editor)) {
      this.clearDecorations(editor);
      return;
    }

    const text = editor.document.getText();
    const semanticDocument = parseSemanticMarkdown(text);
    const newDecorations: EditorDecoration[] = semanticDocument.tags.map(tag => ({
      range: tag.range,
      options: {
        className: this.getDecorationClassName(tag.kind)
      }
    }));

    const oldDecorations = this.decorationIds.get(editor) ?? [];
    this.decorationIds.set(editor, editor.deltaDecorations({
      oldDecorations,
      newDecorations
    }));
  }

  protected clearDecorations(editor: TextEditor): void {
    const oldDecorations = this.decorationIds.get(editor) ?? [];
    if (oldDecorations.length > 0) {
      editor.deltaDecorations({
        oldDecorations,
        newDecorations: []
      });
      this.decorationIds.delete(editor);
    }
  }

  protected isMarkdownEditor(editor: TextEditor): boolean {
    return editor.uri.path.ext.toLowerCase() === '.md' || editor.document.languageId === 'markdown';
  }

  protected getDecorationClassName(kind: string): string {
    return `${DECORATION_CLASS_PREFIX} ${DECORATION_CLASS_PREFIX}-${this.normalizeKind(kind)}`;
  }

  protected normalizeKind(kind: string): string {
    return kind.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  }
}
