/**
 * The "Manuscript" side panel: an {@link ItemView} in the right leaf that lists
 * every AFE book in the vault → its parts/chapters in manifest order → an
 * entities-by-kind summary. Clicking a chapter opens its Markdown file. Pure
 * structure comes from {@link BookContext}; this view only renders + wires clicks.
 */

import { ItemView, WorkspaceLeaf, TFile, MarkdownView } from 'obsidian';
import type { BookContext, LoadedBook } from './book-context';
import type { Translator } from './i18n';
import type { ChapterNode, EntityIndexEntry } from './core/book-model';
import { countMentions, mentionsForEntity, type MentionSpot } from './core/entity-mentions';

/** How many entities the tag cloud shows, and its label size tiers. */
const CLOUD_CAP = 40;

/** One grouped kind bucket for the entities tree. */
interface KindGroup {
  kind: string;
  tagKind: string;
  label: string;
  entries: EntityIndexEntry[];
}

/** A cloud item: an entity with its mention count and a 1–4 size step. */
interface CloudItem {
  entry: EntityIndexEntry;
  count: number;
  step: 1 | 2 | 3 | 4;
}

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
    const wrap = section.createDiv({ cls: 'afe-entities' });
    const details = wrap.createEl('details', { cls: 'afe-entities-details' });
    details.setAttr('open', '');
    details.createEl('summary', { cls: 'afe-entities-title', text: this.t('panel.entities') });

    this.renderCloud(details, book);

    const groups = groupByKind(book);
    const groupsWrap = details.createDiv({ cls: 'afe-entities-groups' });
    for (const group of groups) {
      this.renderKindGroup(groupsWrap, book, group);
    }
  }

  /** The "Облако" block: entity labels sized by mention count. */
  private renderCloud(container: HTMLElement, book: LoadedBook): void {
    const items = buildCloud(book);
    if (items.length === 0) {
      return;
    }
    const cloud = container.createDiv({ cls: 'afe-cloud' });
    cloud.createEl('div', { cls: 'afe-cloud-title', text: this.t('panel.cloud') });
    const tags = cloud.createDiv({ cls: 'afe-cloud-tags' });
    for (const item of items) {
      const tag = tags.createEl('span', {
        cls: `afe-cloud-tag afe-cloud-step-${item.step} afe-kind-${cssKind(item.entry.tagKind)}`,
        text: item.entry.label
      });
      tag.setAttr('aria-label', `${item.entry.label} · ${item.count}`);
      tag.onClickEvent(() => this.openCard(item.entry));
    }
  }

  private renderKindGroup(container: HTMLElement, book: LoadedBook, group: KindGroup): void {
    const details = container.createEl('details', { cls: 'afe-kind-details' });
    const summary = details.createEl('summary', { cls: 'afe-entities-row' });
    summary.createEl('span', { cls: `afe-kind-dot afe-kind-${cssKind(group.tagKind)}` });
    summary.createEl('span', { cls: 'afe-entities-kind', text: group.label });
    summary.createEl('span', { cls: 'afe-entities-count', text: String(group.entries.length) });

    const list = details.createEl('ul', { cls: 'afe-entities-list' });
    for (const entry of group.entries) {
      this.renderEntityRow(list, book, entry);
    }
  }

  private renderEntityRow(list: HTMLElement, book: LoadedBook, entry: EntityIndexEntry): void {
    const item = list.createEl('li', { cls: 'afe-entity-item' });
    const row = item.createDiv({ cls: 'afe-entity-row' });
    const label = row.createEl('span', { cls: 'afe-entity-label', text: entry.label });
    label.onClickEvent(() => this.openCard(entry));

    const count = countMentions(book.mentions, entry);
    const badge = row.createEl('span', { cls: 'afe-mention-badge', text: String(count) });
    badge.setAttr('aria-label', this.t('panel.mentions'));

    const spotsWrap = item.createDiv({ cls: 'afe-mention-list is-hidden' });
    let filled = false;
    badge.onClickEvent(() => {
      if (!filled) {
        this.fillMentionList(spotsWrap, book, entry);
        filled = true;
      }
      spotsWrap.toggleClass('is-hidden', !spotsWrap.hasClass('is-hidden'));
    });
  }

  private fillMentionList(container: HTMLElement, book: LoadedBook, entry: EntityIndexEntry): void {
    const spots = mentionsForEntity(book.mentions, entry);
    if (spots.length === 0) {
      container.createEl('div', { cls: 'afe-mention-empty', text: this.t('panel.noMentions') });
      return;
    }
    for (const spot of spots) {
      const row = container.createDiv({ cls: 'afe-mention-spot' });
      row.createEl('span', { cls: 'afe-mention-loc', text: `${basename(spot.path)}:${spot.line}` });
      row.createEl('span', { cls: 'afe-mention-preview', text: spot.preview });
      row.onClickEvent(() => void this.openAt(spot));
    }
  }

  private async openChapter(book: LoadedBook, chapterPath: string): Promise<void> {
    const fullPath = book.root ? `${book.root}/${chapterPath}` : chapterPath;
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  /** Open a mention's file and reveal its line. */
  private async openAt(spot: MentionSpot): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(spot.path);
    if (!(file instanceof TFile)) {
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = leaf.view;
    if (view instanceof MarkdownView) {
      const pos = { line: Math.max(0, spot.line - 1), ch: 0 };
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
    }
  }
}

/** Group a book's entities by kind, each group + entries sorted by label. */
function groupByKind(book: LoadedBook): KindGroup[] {
  const groups = new Map<string, KindGroup>();
  for (const entry of book.entities) {
    const existing = groups.get(entry.kind);
    if (existing) {
      existing.entries.push(entry);
    } else {
      const type = book.types.find(candidate => candidate.id === entry.kind);
      groups.set(entry.kind, {
        kind: entry.kind,
        tagKind: entry.tagKind,
        label: type?.label ?? entry.kind,
        entries: [entry]
      });
    }
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.entries.sort((a, b) => a.label.localeCompare(b.label));
  }
  result.sort((a, b) => a.label.localeCompare(b.label));
  return result;
}

/**
 * Build the tag cloud: every entity ranked by mention count (desc), ties broken
 * by label, capped at {@link CLOUD_CAP}. Each label's size step is a 4-tier
 * bucket of its count relative to the busiest entity — so the sizing is
 * deterministic and self-scaling to the book.
 */
function buildCloud(book: LoadedBook): CloudItem[] {
  const counted = book.entities.map(entry => ({ entry, count: countMentions(book.mentions, entry) }));
  counted.sort((a, b) => b.count - a.count || a.entry.label.localeCompare(b.entry.label));
  const top = counted.slice(0, CLOUD_CAP);
  const max = top.length > 0 ? top[0].count : 0;
  return top.map(({ entry, count }) => ({ entry, count, step: cloudStep(count, max) }));
}

/** Map a mention count to a 1–4 size step against the busiest entity's count. */
function cloudStep(count: number, max: number): 1 | 2 | 3 | 4 {
  if (max <= 0 || count <= 0) {
    return 1;
  }
  const ratio = count / max;
  if (ratio > 0.66) {
    return 4;
  }
  if (ratio > 0.33) {
    return 3;
  }
  return 2;
}

/** Basename of a vault path, for a compact mention location label. */
function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Reduce an arbitrary tag kind to a css-safe suffix; built-ins keep their known accent classes. */
export function cssKind(tagKind: string): string {
  return tagKind.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}
