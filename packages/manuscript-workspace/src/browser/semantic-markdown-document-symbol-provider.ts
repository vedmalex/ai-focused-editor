import { parseSemanticMarkdown, SemanticTag } from '@ai-focused-editor/semantic-markdown';
import { DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';

interface HeadingEntry {
  level: number;
  text: string;
  line: number;
  symbol: monaco.languages.DocumentSymbol;
}

/**
 * Outline for manuscript Markdown: the chapter's HEADING hierarchy, with the
 * semantic entities appearing in each section nested beneath their heading
 * (one node per unique kind:id, anchored at its first occurrence).
 */
@injectable()
export class SemanticMarkdownDocumentSymbolProvider implements FrontendApplicationContribution {
  protected readonly toDispose = new DisposableCollection();

  onStart(): void {
    this.toDispose.push(monaco.languages.registerDocumentSymbolProvider(
      { language: 'markdown' },
      {
        displayName: 'AI Focused Editor Manuscript Outline',
        provideDocumentSymbols: model => this.provideDocumentSymbols(model)
      }
    ));
  }

  onStop(): void {
    this.toDispose.dispose();
  }

  protected provideDocumentSymbols(model: monaco.editor.ITextModel): monaco.languages.DocumentSymbol[] {
    const text = model.getValue();
    const headings = this.collectHeadings(model, text);
    const tags = parseSemanticMarkdown(text).tags;

    const roots: monaco.languages.DocumentSymbol[] = [];
    const stack: HeadingEntry[] = [];
    for (const heading of headings) {
      while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
        stack.pop();
      }
      if (stack.length === 0) {
        roots.push(heading.symbol);
      } else {
        stack[stack.length - 1].symbol.children!.push(heading.symbol);
      }
      stack.push(heading);
    }

    this.attachTags(headings, tags, roots);
    return roots;
  }

  protected collectHeadings(model: monaco.editor.ITextModel, text: string): HeadingEntry[] {
    const headings: HeadingEntry[] = [];
    let inFence = false;
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) {
        continue;
      }
      const match = line.match(/^(#{1,6})\s+(.*)$/);
      if (!match) {
        continue;
      }
      const lineNumber = index + 1;
      const range = new monaco.Range(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber));
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        line: lineNumber,
        symbol: {
          name: match[2].trim() || '(untitled)',
          detail: `H${match[1].length}`,
          kind: monaco.languages.SymbolKind.String,
          tags: [],
          range,
          selectionRange: range,
          children: []
        }
      });
    }
    return headings;
  }

  /** Nest each section's unique entities under the closest preceding heading. */
  protected attachTags(
    headings: HeadingEntry[],
    tags: SemanticTag[],
    roots: monaco.languages.DocumentSymbol[]
  ): void {
    const seenPerOwner = new Map<monaco.languages.DocumentSymbol | undefined, Set<string>>();

    for (const tag of tags) {
      const tagLine = tag.range.start.line + 1;
      let owner: monaco.languages.DocumentSymbol | undefined;
      for (const heading of headings) {
        if (heading.line <= tagLine) {
          owner = heading.symbol;
        } else {
          break;
        }
      }

      const key = `${tag.kind}:${tag.id}`;
      let seen = seenPerOwner.get(owner);
      if (!seen) {
        seen = new Set();
        seenPerOwner.set(owner, seen);
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const symbol = this.toTagSymbol(tag);
      if (owner) {
        owner.children!.push(symbol);
      } else {
        roots.push(symbol);
      }
    }
  }

  protected toTagSymbol(tag: SemanticTag): monaco.languages.DocumentSymbol {
    return {
      name: tag.label,
      detail: `${tag.kind}:${tag.id}`,
      kind: this.getSymbolKind(tag.kind),
      tags: [],
      range: this.toMonacoRange(tag.range),
      selectionRange: this.toMonacoRange(tag.labelRange),
      children: []
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
