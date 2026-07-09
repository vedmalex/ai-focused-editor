import {
  parseSemanticMarkdown,
  renderSemanticMarkdownPreview,
  SemanticTag
} from '@ai-focused-editor/semantic-markdown';
import { Disposable, DisposableCollection } from '@theia/core/lib/common';
import { Markdown } from '@theia/core/lib/browser/markdown-rendering/markdown';
import { MarkdownRenderer } from '@theia/core/lib/browser/markdown-rendering/markdown-renderer';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import {
  inject,
  injectable,
  postConstruct
} from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';

@injectable()
export class SemanticMarkdownPreviewWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.semantic-markdown.preview';
  static readonly LABEL = 'Semantic Preview';

  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(MarkdownRenderer)
  protected readonly markdownRenderer!: MarkdownRenderer;

  protected editorDisposables = new DisposableCollection();
  protected previewMarkdown = '';
  protected sourceLabel = 'No Markdown editor selected';
  protected semanticTags: SemanticTag[] = [];

  @postConstruct()
  protected init(): void {
    this.id = SemanticMarkdownPreviewWidget.ID;
    this.title.label = SemanticMarkdownPreviewWidget.LABEL;
    this.title.caption = 'Semantic Markdown Preview';
    this.title.iconClass = 'fa fa-eye';
    this.title.closable = true;
    this.addClass('afe-semantic-markdown-preview-widget');

    this.toDispose.push(this.editorManager.onCurrentEditorChanged(() => this.refresh()));
    this.toDispose.push(Disposable.create(() => this.editorDisposables.dispose()));
    this.refresh();
  }

  refresh(): void {
    this.editorDisposables.dispose();
    this.editorDisposables = new DisposableCollection();

    const editor = this.editorManager.currentEditor?.editor ?? this.editorManager.activeEditor?.editor;
    if (!editor || !this.isMarkdownEditor(editor)) {
      this.previewMarkdown = '';
      this.semanticTags = [];
      this.sourceLabel = 'Open a Markdown manuscript file to preview semantic tags.';
      this.update();
      return;
    }

    this.sourceLabel = editor.uri.path.base;
    this.updatePreview(editor);
    this.editorDisposables.push(editor.onDocumentContentChanged(() => this.updatePreview(editor)));
    this.editorDisposables.push(editor.onLanguageChanged(() => this.refresh()));
  }

  protected updatePreview(editor: TextEditor): void {
    const text = editor.document.getText();
    this.semanticTags = parseSemanticMarkdown(text).tags;
    this.previewMarkdown = renderSemanticMarkdownPreview(text);
    this.update();
  }

  protected isMarkdownEditor(editor: TextEditor): boolean {
    return editor.uri.path.ext.toLowerCase() === '.md' || editor.document.languageId === 'markdown';
  }

  protected render(): React.ReactNode {
    return React.createElement(
      'div',
      { className: 'afe-semantic-markdown-preview' },
      React.createElement('div', { className: 'afe-semantic-markdown-preview-source' }, this.sourceLabel),
      this.renderTagSummary(),
      this.previewMarkdown
        ? React.createElement(Markdown, {
            markdown: this.previewMarkdown,
            markdownRenderer: this.markdownRenderer,
            className: 'afe-semantic-markdown-preview-content'
          })
        : React.createElement('div', { className: 'afe-semantic-markdown-preview-empty' }, 'No preview content.')
    );
  }

  protected renderTagSummary(): React.ReactNode {
    if (this.semanticTags.length === 0) {
      return React.createElement(
        'div',
        { className: 'afe-semantic-markdown-tag-summary empty' },
        'No semantic tags detected.'
      );
    }

    return React.createElement(
      'div',
      { className: 'afe-semantic-markdown-tag-summary' },
      React.createElement('strong', undefined, `${this.semanticTags.length} semantic tag(s)`),
      React.createElement(
        'div',
        { className: 'afe-semantic-markdown-tag-list' },
        ...this.semanticTags.slice(0, 24).map(tag => React.createElement(
          'span',
          {
            key: `${tag.kind}:${tag.id}:${tag.range.start.line}:${tag.range.start.character}`,
            className: `afe-semantic-markdown-tag-chip ${this.normalizeKind(tag.kind)}`
          },
          `${tag.label} (${tag.kind}:${tag.id})`
        )),
        this.semanticTags.length > 24
          ? React.createElement('span', { className: 'afe-semantic-markdown-tag-chip more' }, `+${this.semanticTags.length - 24} more`)
          : undefined
      )
    );
  }

  protected normalizeKind(kind: string): string {
    return kind.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  }
}
