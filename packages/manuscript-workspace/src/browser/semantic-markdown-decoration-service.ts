import { parseSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import { DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { injectable, inject } from '@theia/core/shared/inversify';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { EditorDecoration } from '@theia/editor/lib/browser/decorations/editor-decoration';
import type { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import type { TextEditor } from '@theia/editor/lib/browser/editor';

const STYLE_ID = 'ai-focused-editor-semantic-markdown-decorations';
const DECORATION_CLASS_PREFIX = 'afe-semantic-tag';

@injectable()
export class SemanticMarkdownDecorationService implements FrontendApplicationContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  protected readonly toDispose = new DisposableCollection();
  protected readonly editorDisposables = new Map<TextEditor, DisposableCollection>();
  protected readonly decorationIds = new Map<TextEditor, string[]>();

  onStart(): void {
    this.installStyles();
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
    disposables.push(editor.onDocumentContentChanged(() => this.updateDecorations(editor)));
    disposables.push(editor.onLanguageChanged(() => this.updateDecorations(editor)));
    disposables.push(widget.onDispose(() => {
      this.clearDecorations(editor);
      this.editorDisposables.get(editor)?.dispose();
      this.editorDisposables.delete(editor);
    }));

    this.updateDecorations(editor);
  }

  protected updateDecorations(editor: TextEditor): void {
    if (!this.isMarkdownEditor(editor)) {
      this.clearDecorations(editor);
      return;
    }

    const text = editor.document.getText();
    const semanticDocument = parseSemanticMarkdown(text);
    const newDecorations: EditorDecoration[] = semanticDocument.tags.map(tag => ({
      range: tag.range,
      options: {
        className: this.getDecorationClassName(tag.kind),
        hoverMessage: `${this.getTagLabel(tag.kind)}: ${tag.id} -> ${tag.label}`
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

  protected getTagLabel(kind: string): string {
    switch (kind) {
      case 'char':
        return 'Character';
      case 'term':
        return 'Term';
      case 'artifact':
        return 'Artifact';
      default:
        return 'Semantic tag';
    }
  }

  protected installStyles(): void {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.monaco-editor .${DECORATION_CLASS_PREFIX} {
  border-radius: 3px;
  border-bottom: 1px solid rgba(44, 101, 151, 0.65);
  background: rgba(44, 101, 151, 0.12);
}
.monaco-editor .${DECORATION_CLASS_PREFIX}-char {
  border-bottom-color: rgba(35, 109, 181, 0.8);
  background: rgba(35, 109, 181, 0.16);
}
.monaco-editor .${DECORATION_CLASS_PREFIX}-term {
  border-bottom-color: rgba(36, 128, 93, 0.8);
  background: rgba(36, 128, 93, 0.15);
}
.monaco-editor .${DECORATION_CLASS_PREFIX}-artifact {
  border-bottom-color: rgba(176, 105, 28, 0.8);
  background: rgba(176, 105, 28, 0.16);
}
`;
    document.head.appendChild(style);
  }
}
