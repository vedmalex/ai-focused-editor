/**
 * The "Manuscript" side panel: an {@link ItemView} in the right leaf that lists
 * every AFE book in the vault → its parts/chapters in manifest order → an
 * entities-by-kind summary. Clicking a chapter opens its Markdown file. Pure
 * structure comes from {@link BookContext}; this view only renders + wires clicks.
 */

import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import type { BookContext, LoadedBook } from './book-context';
import type { Translator } from './i18n';
import type { ChapterNode, EntityIndexEntry } from './core/book-model';

export const MANUSCRIPT_VIEW_TYPE = 'afe-manuscript-view';
export const MANUSCRIPT_VIEW_ICON = 'book-open';

export class ManuscriptView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly context: BookContext,
    private readonly t: Translator,
    private readonly openCard: (entry: EntityIndexEntry) => void
  ) {
    super(leaf);
  }

  getViewType(): string {
    return MANUSCRIPT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.t('panel.title');
  }

  getIcon(): string {
    return MANUSCRIPT_VIEW_ICON;
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  /** Rebuild the panel DOM from the current book models. */
  render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('afe-manuscript-panel');

    const books = this.context.getBooks();
    if (books.length === 0) {
      container.createEl('div', { cls: 'afe-panel-empty', text: this.t('panel.noBook') });
      return;
    }

    for (const book of books) {
      this.renderBook(container, book);
    }
  }

  private renderBook(container: HTMLElement, book: LoadedBook): void {
    const section = container.createDiv({ cls: 'afe-book' });
    section.createEl('div', { cls: 'afe-book-title', text: book.title });

    if (book.chapters.length === 0) {
      section.createEl('div', { cls: 'afe-panel-empty', text: this.t('panel.empty') });
    } else {
      const list = section.createEl('ul', { cls: 'afe-chapter-list' });
      for (const node of book.chapters) {
        this.renderChapter(list, book, node);
      }
    }

    this.renderEntities(section, book);
  }

  private renderChapter(list: HTMLElement, book: LoadedBook, node: ChapterNode): void {
    const item = list.createEl('li', { cls: 'afe-chapter-item' });
    const isPart = !!(node.children && node.children.length > 0);
    const row = item.createEl('div', {
      cls: isPart ? 'afe-chapter-row afe-chapter-part' : 'afe-chapter-row afe-chapter-leaf'
    });
    row.createEl('span', { cls: 'afe-chapter-title', text: node.title });

    if (isPart) {
      const childList = item.createEl('ul', { cls: 'afe-chapter-list' });
      for (const child of node.children!) {
        this.renderChapter(childList, book, child);
      }
      // A part with its own file is still openable.
      if (/\.(md|markdown)$/i.test(node.path)) {
        row.addClass('afe-chapter-clickable');
        row.onClickEvent(() => this.openChapter(book, node.path));
      }
    } else {
      row.addClass('afe-chapter-clickable');
      row.onClickEvent(() => this.openChapter(book, node.path));
    }
  }

  private renderEntities(section: HTMLElement, book: LoadedBook): void {
    if (book.entities.length === 0) {
      return;
    }
    const counts = new Map<string, { label: string; tagKind: string; count: number }>();
    for (const entry of book.entities) {
      const bucket = counts.get(entry.kind);
      if (bucket) {
        bucket.count++;
      } else {
        const type = book.types.find(candidate => candidate.id === entry.kind);
        counts.set(entry.kind, { label: type?.label ?? entry.kind, tagKind: entry.tagKind, count: 1 });
      }
    }

    const wrap = section.createDiv({ cls: 'afe-entities' });
    wrap.createEl('div', { cls: 'afe-entities-title', text: this.t('panel.entities') });
    const list = wrap.createEl('ul', { cls: 'afe-entities-list' });
    for (const [kind, info] of counts) {
      const row = list.createEl('li', { cls: 'afe-entities-row' });
      row.createEl('span', { cls: `afe-kind-dot afe-kind-${cssKind(info.tagKind)}` });
      row.createEl('span', { cls: 'afe-entities-kind', text: info.label });
      row.createEl('span', { cls: 'afe-entities-count', text: String(info.count) });
      void kind;
    }
  }

  private async openChapter(book: LoadedBook, chapterPath: string): Promise<void> {
    const fullPath = book.root ? `${book.root}/${chapterPath}` : chapterPath;
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}

/** Reduce an arbitrary tag kind to a css-safe suffix; built-ins keep their known accent classes. */
export function cssKind(tagKind: string): string {
  return tagKind.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}
