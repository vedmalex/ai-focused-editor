/**
 * A small, robust custom view for entity `.yaml`/`.yml` cards. It renders a
 * read-only card HEADER — the label, a kind badge, and the type's schema fields
 * with their current values — above a plain editable `<textarea>` bound to the
 * raw file text. The header re-derives from the text on every edit (best-effort;
 * a YAML parse error just hides the header, never blocks editing), and saves go
 * through the framework's debounced `requestSave`.
 *
 * Registration is gated behind a plugin setting because `registerExtensions`
 * is vault-wide: turning it on makes EVERY `.yaml`/`.yml` open in this view.
 */

import { TextFileView, type WorkspaceLeaf } from 'obsidian';
import { parse } from 'yaml';
import type { BookContext } from './book-context';
import type { EffectiveEntityType } from '@ai-focused-editor/manuscript-workspace/src/common/entity-type-registry';
import type { Translator } from './i18n';
import { cssKind } from './manuscript-view';

export const YAML_CARD_VIEW_TYPE = 'afe-yaml-card-view';

export class YamlCardView extends TextFileView {
  private textarea!: HTMLTextAreaElement;
  private headerEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly books: BookContext,
    private readonly t: Translator
  ) {
    super(leaf);
  }

  getViewType(): string {
    return YAML_CARD_VIEW_TYPE;
  }

  getIcon(): string {
    return 'file-text';
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'YAML';
  }

  protected async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('afe-card-view');
    this.headerEl = root.createDiv({ cls: 'afe-card-header' });
    this.textarea = root.createEl('textarea', { cls: 'afe-card-textarea' });
    this.textarea.spellcheck = false;
    this.textarea.addEventListener('input', () => {
      this.data = this.textarea.value;
      this.renderHeader();
      this.requestSave();
    });
  }

  getViewData(): string {
    return this.textarea ? this.textarea.value : this.data;
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (this.textarea) {
      this.textarea.value = data;
    }
    if (clear) {
      // Nothing cached beyond the textarea value; header re-derives below.
    }
    this.renderHeader();
  }

  clear(): void {
    this.data = '';
    if (this.textarea) {
      this.textarea.value = '';
    }
    if (this.headerEl) {
      this.headerEl.empty();
    }
  }

  /** Re-derive the read-only header from the current text; robust to parse errors. */
  private renderHeader(): void {
    if (!this.headerEl) {
      return;
    }
    this.headerEl.empty();

    let record: Record<string, unknown> | undefined;
    try {
      const parsed = parse(this.data);
      record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      record = undefined;
    }

    const type = this.resolveType();
    const labelField = type?.fields.find(field => field.role === 'label')?.name ?? 'name';
    const label = str(record?.[labelField]) ?? str(record?.id) ?? this.file?.basename ?? '';

    const titleRow = this.headerEl.createDiv({ cls: 'afe-card-title-row' });
    if (type) {
      const badge = titleRow.createEl('span', { cls: `afe-card-badge afe-kind-${cssKind(type.tagKind)}` });
      badge.createEl('span', { cls: 'afe-kind-dot' });
      badge.createEl('span', { text: type.label });
    } else {
      titleRow.createEl('span', { cls: 'afe-card-badge afe-card-badge-unknown', text: this.t('card.unresolvedType') });
    }
    titleRow.createEl('span', { cls: 'afe-card-label', text: label });

    if (record && type) {
      const fields = this.headerEl.createEl('dl', { cls: 'afe-card-fields' });
      for (const field of type.fields) {
        if (field.role === 'label' || field.name === 'id') {
          continue;
        }
        const value = record[field.name];
        const display = fieldToText(value);
        if (!display) {
          continue;
        }
        fields.createEl('dt', { text: field.name });
        fields.createEl('dd', { text: display });
      }
    }
  }

  /** Resolve the entity type for this card from its `entities/<dir>/…` path. */
  private resolveType(): EffectiveEntityType | undefined {
    if (!this.file) {
      return undefined;
    }
    const book = this.books.bookForPath(this.file.path) ?? this.books.getBooks()[0];
    if (!book) {
      return undefined;
    }
    const match = /(?:^|\/)entities\/([^/]+)\//.exec(this.file.path);
    const directory = match?.[1];
    return directory ? book.types.find(type => type.directory === directory) : undefined;
  }
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function fieldToText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === 'string').join(', ');
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}
