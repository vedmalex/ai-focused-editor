import { parseSemanticMarkdown, SemanticTag } from '@ai-focused-editor/semantic-markdown';
import { DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';

@injectable()
export class SemanticMarkdownDocumentSymbolProvider implements FrontendApplicationContribution {
  protected readonly toDispose = new DisposableCollection();

  onStart(): void {
    this.toDispose.push(monaco.languages.registerDocumentSymbolProvider(
      { language: 'markdown' },
      {
        displayName: 'AI Focused Editor Semantic Markdown',
        provideDocumentSymbols: model => this.provideDocumentSymbols(model)
      }
    ));
  }

  onStop(): void {
    this.toDispose.dispose();
  }

  protected provideDocumentSymbols(model: monaco.editor.ITextModel): monaco.languages.DocumentSymbol[] {
    return parseSemanticMarkdown(model.getValue()).tags.map(tag => this.toDocumentSymbol(tag));
  }

  protected toDocumentSymbol(tag: SemanticTag): monaco.languages.DocumentSymbol {
    return {
      name: tag.label,
      detail: `${tag.kind}:${tag.id}`,
      kind: this.getSymbolKind(tag.kind),
      tags: [],
      range: this.toMonacoRange(tag.range),
      selectionRange: this.toMonacoRange(tag.labelRange)
    };
  }

  protected getSymbolKind(kind: string): monaco.languages.SymbolKind {
    switch (kind) {
      case 'char':
        return monaco.languages.SymbolKind.Class;
      case 'term':
        return monaco.languages.SymbolKind.Key;
      case 'artifact':
        return monaco.languages.SymbolKind.Object;
      case 'location':
        return monaco.languages.SymbolKind.Namespace;
      default:
        return monaco.languages.SymbolKind.String;
    }
  }

  protected toMonacoRange(range: SemanticTag['range']): monaco.Range {
    return new monaco.Range(
      range.start.line + 1,
      range.start.character + 1,
      range.end.line + 1,
      range.end.character + 1
    );
  }
}
