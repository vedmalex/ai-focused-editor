/**
 * AFE Companion — the Obsidian "field notebook" for AI Focused Editor books.
 *
 * Wires the pure `core/*` model + the Obsidian-facing pieces together:
 *  1. the "Manuscript" side panel ({@link ManuscriptView});
 *  2. semantic-tag autocomplete ({@link SemanticTagSuggest});
 *  3. reading-mode tag navigation ({@link SemanticReadingProcessor}) + editor
 *     command / entity search / create-missing-card;
 *  4. an optional YAML entity-card view ({@link YamlCardView}), gated by a setting.
 *
 * The book index ({@link BookContext}) is rebuilt (debounced) whenever a
 * `manifest.yaml` / `entities/**` file changes, and every open panel re-renders.
 */

import { Plugin, Notice, TFile, MarkdownView, Menu, Platform, debounce, type Editor } from 'obsidian';
import { BookContext, DEFAULT_SETTINGS, type AfeSettings } from './book-context';
import { createTranslator, resolveLang, type Translator } from './i18n';
import { ManuscriptView, MANUSCRIPT_VIEW_TYPE, MANUSCRIPT_VIEW_ICON } from './manuscript-view';
import { SemanticTagSuggest } from './tag-suggest';
import { CitationSuggest } from './cite-suggest';
import { ExcerptInsertModal } from './excerpt-insert-modal';
import { SemanticReadingProcessor } from './reading-navigation';
import { HoverPreview } from './hover-preview';
import { createLivePreviewExtension } from './live-preview';
import { EntitySearchModal } from './entity-search-modal';
import { CreateEntityModal } from './create-entity-modal';
import { YamlCardView, YAML_CARD_VIEW_TYPE } from './yaml-card-view';
import { AfeSettingTab } from './settings';
import { tagAtPosition } from './core/tag-at-position';
import type { EntityIndexEntry } from './core/book-model';

export class AfeCompanionPlugin extends Plugin {
  settings: AfeSettings = { ...DEFAULT_SETTINGS };
  t: Translator = createTranslator('en');
  private books!: BookContext;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.books = new BookContext(this.app, () => this.settings);

    // --- Manuscript panel ---
    this.registerView(
      MANUSCRIPT_VIEW_TYPE,
      leaf => new ManuscriptView(leaf, this.books, this.t, entry => this.openCard(entry))
    );
    this.addRibbonIcon(MANUSCRIPT_VIEW_ICON, this.t('ribbon.open'), () => void this.activatePanel());
    this.addCommand({
      id: 'afe-open-manuscript-panel',
      name: this.t('command.openPanel'),
      callback: () => void this.activatePanel()
    });

    // --- Autocomplete ---
    this.registerEditorSuggest(new SemanticTagSuggest(this.app, this.books));
    this.registerEditorSuggest(new CitationSuggest(this.app, this.books));

    // --- Insert an excerpt as a blockquote at the caret ---
    this.addCommand({
      id: 'afe-insert-excerpt',
      name: this.t('command.insertExcerpt'),
      editorCallback: (editor: Editor) => {
        const sourcePath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? '';
        if (!ExcerptInsertModal.openFor(this.app, this.books, editor, sourcePath, this.t)) {
          new Notice(this.t('excerpt.none'));
        }
      }
    });

    // --- Full-card hover (desktop only; mobile has no pointer hover) ---
    const hover = Platform.isMobile ? undefined : new HoverPreview(this.app, this.books, this.t, this);

    // --- Reading-mode navigation ---
    const processor = new SemanticReadingProcessor(
      this.books,
      entry => this.openCard(entry),
      (sourcePath, kind, id) => this.offerCreate(sourcePath, kind, id),
      hover
    );
    this.registerMarkdownPostProcessor(processor.process);

    // --- Live Preview decorations ---
    this.registerEditorExtension(
      createLivePreviewExtension({
        books: this.books,
        hover,
        openCard: entry => void this.openCard(entry),
        onMissing: (sourcePath, kind, id) => this.offerCreate(sourcePath, kind, id)
      })
    );

    // --- Editor command + context menu: open the card under the cursor ---
    this.addCommand({
      id: 'afe-open-card-under-cursor',
      name: this.t('command.openCardUnderCursor'),
      editorCallback: (editor: Editor) => this.openCardUnderCursor(editor)
    });
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
        const tag = this.tagUnderCursor(editor);
        if (!tag) {
          return;
        }
        menu.addItem(item =>
          item
            .setTitle(this.t('command.openCardUnderCursor'))
            .setIcon('link')
            .onClick(() => this.openCardUnderCursor(editor))
        );
      })
    );

    // --- Entity search ---
    this.addCommand({
      id: 'afe-search-entities',
      name: this.t('command.searchEntities'),
      callback: () => new EntitySearchModal(this.app, this.books, this.t, entry => this.openCard(entry)).open()
    });

    // --- Optional YAML card view (vault-wide; gated by setting) ---
    this.registerView(YAML_CARD_VIEW_TYPE, leaf => new YamlCardView(leaf, this.books, this.t));
    if (this.settings.yamlCardView) {
      this.registerExtensions(['yaml', 'yml'], YAML_CARD_VIEW_TYPE);
    }

    this.addSettingTab(new AfeSettingTab(this.app, this));

    // --- Index lifecycle ---
    const reindex = debounce(() => void this.reindex(), 400, true);
    const maybeReindex = (path: string): void => {
      if (this.isBookStructureFile(path)) {
        reindex();
      }
    };
    this.registerEvent(this.app.vault.on('create', file => maybeReindex(file.path)));
    this.registerEvent(this.app.vault.on('modify', file => maybeReindex(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => maybeReindex(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      maybeReindex(file.path);
      maybeReindex(oldPath);
    }));
    this.app.workspace.onLayoutReady(() => void this.reindex());
  }

  onunload(): void {
    // Views + events are auto-released by the Plugin lifecycle.
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.applyLanguage();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyLanguage();
  }

  private applyLanguage(): void {
    const lang = this.settings.lang === 'auto' ? resolveLang(this.getObsidianLocale()) : this.settings.lang;
    this.t = createTranslator(lang);
  }

  private getObsidianLocale(): string {
    // `getLanguage()` exists on recent Obsidian; fall back to the browser locale.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getLanguage } = require('obsidian');
      if (typeof getLanguage === 'function') {
        return getLanguage();
      }
    } catch {
      /* older Obsidian: fall through */
    }
    return typeof navigator !== 'undefined' ? navigator.language : 'en';
  }

  private isBookStructureFile(path: string): boolean {
    return (
      /(?:^|\/)manifest\.yaml$/.test(path) ||
      /(?:^|\/)entities\/.+\.(ya?ml)$/.test(path) ||
      /(?:^|\/)metadata\.yaml$/.test(path) ||
      /(?:^|\/)sources\/(?:citations\.yaml|excerpts\.jsonl)$/.test(path) ||
      /(?:^|\/)content\/.+\.(md|markdown)$/.test(path)
    );
  }

  private async reindex(): Promise<void> {
    await this.books.reload();
    for (const leaf of this.app.workspace.getLeavesOfType(MANUSCRIPT_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof ManuscriptView) {
        view.render();
      }
    }
  }

  private async activatePanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(MANUSCRIPT_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: MANUSCRIPT_VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(leaf);
    }
  }

  private tagUnderCursor(editor: Editor): { kind: string; id: string } | null {
    const cursor = editor.getCursor();
    const tag = tagAtPosition(editor.getLine(cursor.line), cursor.ch);
    return tag ? { kind: tag.kind, id: tag.id } : null;
  }

  private openCardUnderCursor(editor: Editor): void {
    const tag = this.tagUnderCursor(editor);
    if (!tag) {
      new Notice(this.t('command.openCard.notFound'));
      return;
    }
    const sourcePath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? '';
    const entry = this.books.findEntity(sourcePath, tag.kind || undefined, tag.id);
    if (entry) {
      this.openCard(entry);
    } else {
      this.offerCreate(sourcePath, tag.kind, tag.id);
    }
  }

  private offerCreate(sourcePath: string, kind: string, id: string): void {
    if (!kind) {
      new Notice(this.t('notice.missingId', { id }));
      return;
    }
    new CreateEntityModal(this.app, this.books, this.t, sourcePath, kind, id, () => void this.reindex()).open();
  }

  private async openCard(entry: EntityIndexEntry): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice(this.t('notice.missingId', { id: entry.id }));
    }
  }
}

export default AfeCompanionPlugin;
