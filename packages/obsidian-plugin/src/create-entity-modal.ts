/**
 * Confirmation modal for creating a missing entity card. Given the tag kind + id
 * of an unresolved reference, it resolves the effective type for the current
 * book, previews the create, and on confirm writes a minimal YAML skeleton
 * (built from the type's field schema via `buildEntitySkeleton`) then opens it.
 */

import { Modal, Notice, TFile, type App } from 'obsidian';
import type { BookContext, LoadedBook } from './book-context';
import { buildEntitySkeleton } from './core/book-model';
import type { EffectiveEntityType } from '@ai-focused-editor/manuscript-workspace/src/common/entity-type-registry';
import type { Translator } from './i18n';

export class CreateEntityModal extends Modal {
  constructor(
    app: App,
    private readonly books: BookContext,
    private readonly t: Translator,
    private readonly sourcePath: string,
    private readonly kind: string,
    private readonly id: string,
    private readonly onCreated: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.t('create.title'));

    const book = this.books.bookForPath(this.sourcePath) ?? this.books.getBooks()[0];
    const type = book ? resolveType(book, this.kind) : undefined;

    if (!book || !type) {
      contentEl.createEl('p', { text: this.t('create.noType', { kind: this.kind }) });
      this.addButtons(contentEl, undefined);
      return;
    }

    contentEl.createEl('p', { text: this.t('create.body', { id: `${this.kind}:${this.id}` }) });
    this.addButtons(contentEl, { book, type });
  }

  private addButtons(container: HTMLElement, ready: { book: LoadedBook; type: EffectiveEntityType } | undefined): void {
    const row = container.createDiv({ cls: 'afe-modal-buttons' });
    const cancel = row.createEl('button', { text: this.t('create.cancel') });
    cancel.onClickEvent(() => this.close());
    if (!ready) {
      return;
    }
    const confirm = row.createEl('button', { text: this.t('create.confirm'), cls: 'mod-cta' });
    confirm.onClickEvent(() => void this.create(ready.book, ready.type));
  }

  private async create(book: LoadedBook, type: EffectiveEntityType): Promise<void> {
    const dir = book.root ? `${book.root}/entities/${type.directory}` : `entities/${type.directory}`;
    const path = `${dir}/${this.id}.yaml`;
    try {
      if (!this.app.vault.getAbstractFileByPath(dir)) {
        await this.app.vault.createFolder(dir);
      }
      let file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        file = await this.app.vault.create(path, buildEntitySkeleton(type, this.id));
      }
      this.close();
      new Notice(this.t('notice.created', { path }));
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(file);
      }
      this.onCreated();
    } catch (error) {
      new Notice(String(error));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Resolve the effective type whose tagKind OR id matches the reference's kind. */
function resolveType(book: LoadedBook, kind: string): EffectiveEntityType | undefined {
  const needle = kind.toLowerCase();
  return book.types.find(type => type.tagKind.toLowerCase() === needle || type.id.toLowerCase() === needle);
}
