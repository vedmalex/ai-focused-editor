/**
 * "Поиск сущностей" — a {@link FuzzySuggestModal} over the whole vault's entity
 * index. Obsidian's fuzzy matcher runs over `getItemText`, which folds in the
 * label, id, and aliases so any of them matches. Enter opens the card.
 */

import { FuzzySuggestModal, type App, type FuzzyMatch } from 'obsidian';
import type { BookContext } from './book-context';
import type { EntityIndexEntry } from './core/book-model';
import type { Translator } from './i18n';
import { cssKind } from './manuscript-view';

export class EntitySearchModal extends FuzzySuggestModal<EntityIndexEntry> {
  constructor(
    app: App,
    private readonly books: BookContext,
    private readonly t: Translator,
    private readonly openCard: (entry: EntityIndexEntry) => void
  ) {
    super(app);
    this.setPlaceholder(this.t('search.placeholder'));
  }

  getItems(): EntityIndexEntry[] {
    return this.books.allEntities();
  }

  getItemText(entry: EntityIndexEntry): string {
    return [entry.label, entry.id, ...entry.aliases].join(' ');
  }

  renderSuggestion(match: FuzzyMatch<EntityIndexEntry>, el: HTMLElement): void {
    const entry = match.item;
    el.addClass('afe-suggest-item');
    el.createEl('span', { cls: `afe-kind-dot afe-kind-${cssKind(entry.tagKind)}` });
    el.createEl('span', { cls: 'afe-suggest-label', text: entry.label });
    el.createEl('span', { cls: 'afe-suggest-meta', text: `${entry.tagKind}:${entry.id}` });
  }

  onChooseItem(entry: EntityIndexEntry): void {
    this.openCard(entry);
  }
}
