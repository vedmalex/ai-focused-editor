import { parseFootnotes } from '@ai-focused-editor/semantic-markdown';
import type { FootnoteReference } from '@ai-focused-editor/semantic-markdown';
import { DisposableCollection } from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { SemanticMarkdownActionCommands } from './semantic-markdown-actions-contribution';

/**
 * Monaco link provider that wires markdown footnotes together inside a chapter:
 * every `[^id]` reference links to its `[^id]:` definition, and each definition
 * marker links back to the first reference. Activation flows through a `command:`
 * link that runs {@link SemanticMarkdownActionCommands.REVEAL_FOOTNOTE}, which
 * opens the same document at the target via the EditorManager.
 */
@injectable()
export class FootnoteLinkContribution implements FrontendApplicationContribution {
  protected readonly toDispose = new DisposableCollection();

  onStart(): void {
    this.toDispose.push(monaco.languages.registerLinkProvider(
      { language: 'markdown' },
      { provideLinks: model => this.provideLinks(model) }
    ));
  }

  onStop(): void {
    this.toDispose.dispose();
  }

  protected provideLinks(model: monaco.editor.ITextModel): monaco.languages.ILinksList {
    const { references, definitions, numbers } = parseFootnotes(model.getValue());
    if (references.length === 0 && definitions.length === 0) {
      return { links: [] };
    }

    const uri = model.uri.toString();
    const definitionById = new Map(definitions.map(definition => [definition.id, definition]));
    const firstReferenceById = new Map<string, FootnoteReference>();
    for (const reference of references) {
      if (!firstReferenceById.has(reference.id)) {
        firstReferenceById.set(reference.id, reference);
      }
    }

    const links: monaco.languages.ILink[] = [];

    for (const reference of references) {
      const definition = definitionById.get(reference.id);
      if (!definition) {
        continue;
      }
      links.push({
        range: this.toMonacoRange(reference.range),
        url: this.revealUri(uri, definition.range.start.line, definition.range.start.character),
        tooltip: nls.localize(
          'ai-focused-editor/editor/footnote-goto-definition',
          'Go to footnote [{0}] definition',
          numbers.get(reference.id) ?? reference.id
        )
      });
    }

    for (const definition of definitions) {
      const reference = firstReferenceById.get(definition.id);
      if (!reference) {
        continue;
      }
      links.push({
        range: this.toMonacoRange(definition.range),
        url: this.revealUri(uri, reference.range.start.line, reference.range.start.character),
        tooltip: nls.localize(
          'ai-focused-editor/editor/footnote-goto-reference',
          'Go to footnote [{0}] reference',
          numbers.get(definition.id) ?? definition.id
        )
      });
    }

    return { links };
  }

  protected revealUri(uri: string, line: number, character: number): monaco.Uri {
    const args = encodeURIComponent(JSON.stringify([uri, line, character]));
    return monaco.Uri.parse(`command:${SemanticMarkdownActionCommands.REVEAL_FOOTNOTE.id}?${args}`);
  }

  protected toMonacoRange(range: FootnoteReference['range']): monaco.Range {
    return new monaco.Range(
      range.start.line + 1,
      range.start.character + 1,
      range.end.line + 1,
      range.end.character + 1
    );
  }
}
