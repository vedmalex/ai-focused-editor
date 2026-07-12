/**
 * Citation autocomplete as an Obsidian {@link EditorSuggest}. Triggers on `[@`
 * plus a prefix, suggests the book's `sources/citations.yaml` entries (ranked by
 * id/title/source), and inserts `[@cite:id]` on accept. All trigger + ranking
 * rules are the pure `core/citations` helpers; this wrapper only adapts them to
 * the editor.
 *
 * Trigger design: `[@` never begins a normal wikilink or markdown construct, so
 * unlike the semantic-tag suggester this one owns its trigger unambiguously and
 * needs no "only when it matches a known kind" guard.
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
import { activeCiteContext, rankCitations, citeInsertion, type Citation } from './core/citations';

const MAX_SUGGESTIONS = 30;

export class CitationSuggest extends EditorSuggest<Citation> {
  private book: LoadedBook | null = null;

  constructor(app: App, private readonly books: BookContext) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!file) {
      return null;
    }
    const book = this.books.bookForPath(file.path) ?? this.books.getBooks()[0];
    if (!book || book.citations.length === 0) {
      this.book = null;
      return null;
    }
    const line = editor.getLine(cursor.line);
    const ctx = activeCiteContext(line, cursor.ch);
    if (!ctx) {
      this.book = null;
      return null;
    }
    this.book = book;
    return {
      start: { line: cursor.line, ch: ctx.tokenStart },
      end: cursor,
      query: ctx.query
    };
  }

  getSuggestions(context: EditorSuggestContext): Citation[] {
    if (!this.book) {
      return [];
    }
    // The trigger range starts at `[@`, so the live query still carries that
    // prefix (and a possible `cite:`); re-derive the bare prefix.
    const parsed = activeCiteContext(context.query, context.query.length);
    const query = parsed ? parsed.query : context.query;
    return rankCitations(this.book.citations, query).slice(0, MAX_SUGGESTIONS);
  }

  renderSuggestion(citation: Citation, el: HTMLElement): void {
    el.addClass('afe-suggest-item');
    el.createEl('span', { cls: 'afe-cite-marker', text: '@' });
    el.createEl('span', { cls: 'afe-suggest-label', text: citation.title });
    const meta = citation.source ? `${citation.id} · ${citation.source}` : citation.id;
    el.createEl('span', { cls: 'afe-suggest-meta', text: meta });
  }

  selectSuggestion(citation: Citation, _evt: MouseEvent | KeyboardEvent): void {
    const live = this.context;
    if (!live) {
      return;
    }
    const insert = citeInsertion(citation.id);
    live.editor.replaceRange(insert, live.start, live.end);
    live.editor.setCursor({ line: live.start.line, ch: live.start.ch + insert.length });
    this.close();
  }
}
