/**
 * Semantic-tag autocomplete as an Obsidian {@link EditorSuggest}. All the trigger
 * and ranking rules are the pure `core/tag-suggest-core` helpers; this wrapper
 * only adapts them to the editor and inserts the accepted text.
 *
 * Trigger design vs Obsidian's native `[[` wikilink suggester (deliberately
 * conservative, see `activeTagContext`):
 *  - The ENTITY phase (`[[kind:prefix`) is ours unambiguously — a `kind:` prefix
 *    never appears in a normal wikilink, so we own it and complete entity cards.
 *  - The KIND phase (`[[prefix`) only fires when `prefix` is a letters/digits run
 *    that already matches a known tag kind for the current book. A plain
 *    `[[Note title` (space, or a prefix matching no kind) is left entirely to
 *    Obsidian. This means the two suggesters can briefly co-exist while typing a
 *    kind that is also a note-name prefix; we accept that over hijacking `[[`.
 */

import {
  EditorSuggest,
  type App,
  type Editor,
  type EditorPosition,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
  type TFile
} from 'obsidian';
import type { BookContext, LoadedBook } from './book-context';
import { activeTagContext, rankEntities, rankTagKinds, buildTagInsertion } from './core/tag-suggest-core';
import type { EntityIndexEntry } from './core/book-model';
import { cssKind } from './manuscript-view';

type Suggestion =
  | { type: 'entity'; kind: string; entry: EntityIndexEntry }
  | { type: 'kind'; tagKind: string; label: string };

const MAX_SUGGESTIONS = 30;

export class SemanticTagSuggest extends EditorSuggest<Suggestion> {
  // NOTE: the base class owns `this.context` (the live EditorSuggestContext);
  // our book state is kept under a distinct name to avoid clobbering it.
  private active: { phase: 'kind' | 'entity'; kind?: string; book: LoadedBook } | null = null;

  constructor(app: App, private readonly books: BookContext) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!file) {
      return null;
    }
    const book = this.books.bookForPath(file.path) ?? this.books.getBooks()[0];
    if (!book) {
      return null;
    }
    const line = editor.getLine(cursor.line);
    const ctx = activeTagContext(line, cursor.ch);
    if (!ctx) {
      this.active = null;
      return null;
    }

    if (ctx.phase === 'kind') {
      // Only hijack `[[` when the prefix already names a real tag kind.
      if (rankTagKinds(this.books.tagKindsFor(book), ctx.query).length === 0) {
        this.active = null;
        return null;
      }
      this.active = { phase: 'kind', book };
    } else {
      this.active = { phase: 'entity', kind: ctx.kind, book };
    }

    return {
      start: { line: cursor.line, ch: ctx.tokenStart },
      end: cursor,
      query: ctx.query
    };
  }

  getSuggestions(context: EditorSuggestContext): Suggestion[] {
    const state = this.active;
    if (!state) {
      return [];
    }
    if (state.phase === 'kind') {
      // In the kind phase the query is the bare prefix after `[[` (the trigger
      // range starts at `[[`, so strip it back off).
      const query = context.query.replace(/^\[\[/, '');
      return rankTagKinds(this.books.tagKindsFor(state.book), query)
        .slice(0, MAX_SUGGESTIONS)
        .map(tagKind => ({
          type: 'kind' as const,
          tagKind,
          label: state.book.types.find(type => type.tagKind === tagKind)?.label ?? tagKind
        }));
    }
    const kind = state.kind ?? '';
    return rankEntities(state.book.entities, kind, context.query)
      .slice(0, MAX_SUGGESTIONS)
      .map(ranked => ({ type: 'entity' as const, kind, entry: ranked.entry }));
  }

  renderSuggestion(item: Suggestion, el: HTMLElement): void {
    el.addClass('afe-suggest-item');
    if (item.type === 'kind') {
      el.createEl('span', { cls: `afe-kind-dot afe-kind-${cssKind(item.tagKind)}` });
      el.createEl('span', { cls: 'afe-suggest-label', text: item.label });
      el.createEl('span', { cls: 'afe-suggest-meta', text: `${item.tagKind}:` });
      return;
    }
    el.createEl('span', { cls: `afe-kind-dot afe-kind-${cssKind(item.entry.tagKind)}` });
    el.createEl('span', { cls: 'afe-suggest-label', text: item.entry.label });
    el.createEl('span', { cls: 'afe-suggest-meta', text: `${item.kind}:${item.entry.id}` });
  }

  selectSuggestion(item: Suggestion, _evt: MouseEvent | KeyboardEvent): void {
    const live = this.context;
    if (!live) {
      return;
    }
    const { editor, start, end } = live;
    if (item.type === 'kind') {
      const insert = `[[${item.tagKind}:`;
      editor.replaceRange(insert, start, end);
      editor.setCursor({ line: start.line, ch: start.ch + insert.length });
      // Leaving the cursor right after `kind:` lets the entity phase re-trigger
      // on the next keystroke.
      return;
    }
    const insert = buildTagInsertion(item.kind, item.entry);
    editor.replaceRange(insert, start, end);
    editor.setCursor({ line: start.line, ch: start.ch + insert.length });
    this.close();
  }
}
