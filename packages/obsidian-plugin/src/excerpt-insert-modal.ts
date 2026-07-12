/**
 * "Вставить выдержку…" — a {@link FuzzySuggestModal} over the current book's
 * `sources/excerpts.jsonl`. The fuzzy matcher runs over the excerpt text, its
 * note, and its source id; choosing one inserts it as a blockquote (with a
 * trailing `[@cite:id]` reference) at the caret. The blockquote shape is the pure
 * `core/citations` builder.
 */

import { FuzzySuggestModal, type App, type Editor, type FuzzyMatch } from 'obsidian';
import type { BookContext, LoadedBook } from './book-context';
import type { Translator } from './i18n';
import { buildExcerptBlockquote, type Excerpt } from './core/citations';

export class ExcerptInsertModal extends FuzzySuggestModal<Excerpt> {
  constructor(
    app: App,
    private readonly book: LoadedBook,
    private readonly editor: Editor,
    private readonly t: Translator
  ) {
    super(app);
    this.setPlaceholder(this.t('excerpt.placeholder'));
  }

  /** Resolve the book for the active editor and open the modal, or notice why not. */
  static openFor(app: App, books: BookContext, editor: Editor, sourcePath: string, t: Translator): boolean {
    const book = books.bookForPath(sourcePath) ?? books.getBooks()[0];
    if (!book || book.excerpts.length === 0) {
      return false;
    }
    new ExcerptInsertModal(app, book, editor, t).open();
    return true;
  }

  getItems(): Excerpt[] {
    return this.book.excerpts;
  }

  getItemText(excerpt: Excerpt): string {
    return [excerpt.text, excerpt.note ?? '', excerpt.sourceId ?? ''].join(' ');
  }

  renderSuggestion(match: FuzzyMatch<Excerpt>, el: HTMLElement): void {
    const excerpt = match.item;
    el.addClass('afe-suggest-item', 'afe-excerpt-item');
    el.createEl('div', { cls: 'afe-excerpt-text', text: truncate(excerpt.text, 140) });
    const ref = excerpt.sourceId || excerpt.id;
    const meta = excerpt.note ? `${ref} · ${excerpt.note}` : ref;
    el.createEl('div', { cls: 'afe-suggest-meta', text: meta });
  }

  onChooseItem(excerpt: Excerpt): void {
    this.editor.replaceSelection(buildExcerptBlockquote(excerpt) + '\n');
  }
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
