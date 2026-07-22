import { DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import * as monaco from '@theia/monaco-editor-core';
import type { NarrativeEntity } from '../common';
import { NarrativeEntityService } from '../common';
import { EntityTypeRegistryService } from './entity-type-registry-service';
import { NoteIndexService } from './note-index-service';
import { buildNoteCompletionSuggestions, type NoteCompletionEntry } from '../common/note-completion';

const TAG_PREFIX_PATTERN = /\[\[([a-z]*)(?::([^\s|\]]*))?$/i;
// Broader than TAG_PREFIX_PATTERN: matches whatever has been typed after the
// last unclosed `[[` on the line, regardless of charset (Cyrillic, spaces,
// uppercase, `/`, ...) — the general "note name in progress" context (TASK-013
// U6/UR-003(г)). Deliberately independent of the entity pattern above so
// entity-suggestion behavior is untouched; the two simply run side by side
// and their results are merged.
const NOTE_PREFIX_PATTERN = /\[\[([^\]\n]*)$/;
const ENTITY_CACHE_TTL_MS = 5000;

/**
 * Autocompletion for semantic `[[kind:id|label]]` tags (spec §3.4) AND
 * Obsidian-style `[[note]]` links (TASK-013 U6/UR-003(г)/UR-005(3)).
 * Entity suggestions come from the YAML-backed knowledge base, so writers can
 * insert characters/terms without remembering ids. The completed tag kinds come
 * from the EFFECTIVE type list ({@link EntityTypeRegistryService}) — built-in AND
 * author-declared — read fresh on every keystroke, so a type the author adds to
 * `entities/types.yaml` starts completing without any explicit refresh.
 *
 * Note suggestions come from {@link NoteIndexService}'s in-memory index (no
 * filesystem access on the completion path — the index is kept fresh
 * independently, see `note-index-service.ts`) and are built by the pure
 * {@link buildNoteCompletionSuggestions} (`../common/note-completion.ts`):
 * a unique basename inserts as `[[basename]]`; a basename shared by 2+ files
 * inserts as `[[relative/path]]` instead, mirroring Obsidian. This provider's
 * own job is thin — resolve each index entry's vault-relative path (via the
 * workspace root), run the pure builder, and turn the result into Monaco
 * `CompletionItem`s alongside the (unchanged) entity suggestions below.
 */
@injectable()
export class SemanticMarkdownCompletionProvider implements FrontendApplicationContribution {
  @inject(NarrativeEntityService)
  protected readonly narrativeEntities!: NarrativeEntityService;

  @inject(EntityTypeRegistryService)
  protected readonly entityTypeRegistry!: EntityTypeRegistryService;

  @inject(NoteIndexService)
  protected readonly noteIndex!: NoteIndexService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

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

    const suggestions: monaco.languages.CompletionItem[] = [];

    const match = linePrefix.match(TAG_PREFIX_PATTERN);
    if (match) {
      const [fullMatch, kindPrefix, idPrefix] = match;
      const replaceRange = new monaco.Range(
        position.lineNumber,
        position.column - fullMatch.length + 2,
        position.lineNumber,
        position.column
      );

      const entities = await this.getEntities();

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
      // Kinds are the effective tag kinds (built-in + author-declared), read fresh.
      for (const kind of this.tagKinds()) {
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
    }

    // Note-file suggestions (TASK-013 U6): runs independently of the entity
    // pattern above (`NOTE_PREFIX_PATTERN` accepts any charset — Cyrillic,
    // spaces, `/`, ...), so both suggestion sets can appear side by side; the
    // prefix filter naturally suppresses irrelevant note matches while the
    // author is typing an entity tag.
    const noteMatch = linePrefix.match(NOTE_PREFIX_PATTERN);
    if (noteMatch) {
      const [noteFullMatch, notePrefix] = noteMatch;
      const noteReplaceRange = new monaco.Range(
        position.lineNumber,
        position.column - noteFullMatch.length + 2,
        position.lineNumber,
        position.column
      );

      for (const suggestion of buildNoteCompletionSuggestions(this.noteCompletionEntries(), notePrefix)) {
        suggestions.push({
          label: suggestion.label,
          kind: monaco.languages.CompletionItemKind.File,
          detail: suggestion.relativePath,
          insertText: `${suggestion.insertText}]]`,
          range: noteReplaceRange,
          sortText: `2-${suggestion.label}`
        });
      }
    }

    return { suggestions };
  }

  /**
   * Map every {@link NoteIndexService} entry to a `{basename, relativePath}`
   * pair for the pure {@link buildNoteCompletionSuggestions}: `relativePath`
   * is the entry's full path resolved against whichever open workspace root
   * contains it (`.md` stripped, POSIX-separated), matching the same
   * `root.relative(uri)` idiom used elsewhere in this package (e.g.
   * `git-actions-contribution.ts`). An entry outside every open root (should
   * not happen — the index is itself built from `FileSearchService` scoped to
   * the open roots) falls back to its bare basename so it is never silently
   * dropped.
   */
  protected noteCompletionEntries(): NoteCompletionEntry[] {
    const roots = this.workspaceService.tryGetRoots();
    return this.noteIndex.getIndex().entries.map(entry => ({
      basename: entry.basename,
      relativePath: this.toRelativePath(entry.path, roots)
    }));
  }

  protected toRelativePath(path: string, roots: readonly { resource: URI }[]): string {
    let uri: URI;
    try {
      uri = new URI(path);
    } catch {
      return path.replace(/\.md$/i, '');
    }
    for (const root of roots) {
      const relative = root.resource.relative(uri);
      if (relative) {
        return relative.toString().replace(/\.md$/i, '');
      }
    }
    return path.replace(/\.md$/i, '');
  }

  /**
   * The effective tag kinds (built-in + author-declared) for the open book, in
   * registry order. Read fresh so an author type added to `entities/types.yaml`
   * appears without an explicit refresh.
   */
  protected tagKinds(): string[] {
    return this.entityTypeRegistry.getEffectiveTypes().map(type => type.tagKind);
  }

  /**
   * Map an entity kind to the tag kind used inside `[[kind:id|label]]` via the
   * effective type list: characters use the shorthand `char`; every other built-in
   * and each author type uses its declared tag kind (spec §4.3/§5.2). An entity of
   * an unknown kind (no matching effective type) falls back to its kind verbatim.
   */
  protected toTagKind(kind: NarrativeEntity['kind']): string {
    return this.entityTypeRegistry.getEffectiveTypes().find(type => type.id === kind)?.tagKind ?? kind;
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
