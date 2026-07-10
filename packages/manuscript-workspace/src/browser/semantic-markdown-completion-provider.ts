import { DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import type { NarrativeEntity } from '../common';
import { NarrativeEntityService } from '../common';

const TAG_PREFIX_PATTERN = /\[\[([a-z]*)(?::([^\s|\]]*))?$/i;
const ENTITY_CACHE_TTL_MS = 5000;

/**
 * Autocompletion for semantic `[[kind:id|label]]` tags (spec §3.4).
 * Entity suggestions come from the YAML-backed knowledge base, so writers can
 * insert characters/terms without remembering ids.
 */
@injectable()
export class SemanticMarkdownCompletionProvider implements FrontendApplicationContribution {
  @inject(NarrativeEntityService)
  protected readonly narrativeEntities!: NarrativeEntityService;

  protected readonly toDispose = new DisposableCollection();
  protected cachedEntities: NarrativeEntity[] = [];
  protected cacheExpiresAt = 0;

  onStart(): void {
    this.toDispose.push(monaco.languages.registerCompletionItemProvider(
      { language: 'markdown' },
      {
        triggerCharacters: ['[', ':'],
        provideCompletionItems: (model, position) => this.provideCompletionItems(model, position)
      }
    ));
  }

  onStop(): void {
    this.toDispose.dispose();
  }

  protected async provideCompletionItems(
    model: monaco.editor.ITextModel,
    position: monaco.Position
  ): Promise<monaco.languages.CompletionList> {
    const linePrefix = model.getValueInRange(new monaco.Range(
      position.lineNumber, 1, position.lineNumber, position.column
    ));
    const match = linePrefix.match(TAG_PREFIX_PATTERN);
    if (!match) {
      return { suggestions: [] };
    }

    const [fullMatch, kindPrefix, idPrefix] = match;
    const replaceRange = new monaco.Range(
      position.lineNumber,
      position.column - fullMatch.length + 2,
      position.lineNumber,
      position.column
    );

    const entities = await this.getEntities();
    const suggestions: monaco.languages.CompletionItem[] = [];

    for (const entity of entities) {
      const kind = this.toTagKind(entity.kind);
      if (kindPrefix && !kind.startsWith(kindPrefix.toLowerCase()) && idPrefix === undefined) {
        continue;
      }
      if (idPrefix !== undefined && !entity.id.toLowerCase().startsWith(idPrefix.toLowerCase())) {
        continue;
      }
      suggestions.push({
        label: `${kind}:${entity.id}`,
        kind: this.toCompletionItemKind(entity.kind),
        detail: entity.label,
        documentation: entity.summary,
        insertText: `${kind}:${entity.id}|\${1:${entity.label}}]]`,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: replaceRange,
        sortText: `0-${kind}-${entity.id}`
      });
    }

    // Bare-kind scaffolds so the syntax is discoverable even without entities.
    for (const kind of ['char', 'term', 'artifact', 'location']) {
      if (kindPrefix && !kind.startsWith(kindPrefix.toLowerCase())) {
        continue;
      }
      suggestions.push({
        label: `${kind}:...`,
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail: `New ${kind} tag`,
        insertText: `${kind}:\${1:id}|\${2:label}]]`,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: replaceRange,
        sortText: `1-${kind}`
      });
    }

    return { suggestions };
  }

  /**
   * Map an entity kind to the tag kind used inside `[[kind:id|label]]`.
   * Characters use the shorthand `char`; artifacts/locations/terms use their
   * kind verbatim so their tags complete directly (spec §4.3/§5.2).
   */
  protected toTagKind(kind: NarrativeEntity['kind']): string {
    return kind === 'character' ? 'char' : kind;
  }

  protected toCompletionItemKind(kind: NarrativeEntity['kind']): monaco.languages.CompletionItemKind {
    switch (kind) {
      case 'character':
        return monaco.languages.CompletionItemKind.User;
      case 'artifact':
        return monaco.languages.CompletionItemKind.Value;
      case 'location':
        return monaco.languages.CompletionItemKind.Folder;
      case 'term':
      default:
        return monaco.languages.CompletionItemKind.Keyword;
    }
  }

  protected async getEntities(): Promise<NarrativeEntity[]> {
    const now = Date.now();
    if (now < this.cacheExpiresAt) {
      return this.cachedEntities;
    }
    try {
      const snapshot = await this.narrativeEntities.getSnapshot();
      this.cachedEntities = snapshot.entities;
      this.cacheExpiresAt = now + ENTITY_CACHE_TTL_MS;
    } catch {
      this.cacheExpiresAt = now + ENTITY_CACHE_TTL_MS;
    }
    return this.cachedEntities;
  }
}
