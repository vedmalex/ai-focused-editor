import { DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { injectable, inject } from '@theia/core/shared/inversify';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import type { EditorDecoration } from '@theia/editor/lib/browser/decorations/editor-decoration';
import type { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import type { TextEditor } from '@theia/editor/lib/browser/editor';
import type { NarrativeEntity } from '../common';
import { NarrativeEntityService } from '../common';
import { classifyWikiLinkDecorations, type WikiLinkDecorationToken } from './semantic-markdown-decoration-classifier';
import { NoteIndexService } from './note-index-service';

const DECORATION_CLASS_PREFIX = 'afe-semantic-tag';
const DECORATION_UPDATE_DELAY_MS = 150;

/**
 * Refresh window for the entity snapshot cache, matching
 * `SemanticLinkContribution`'s `ENTITY_CACHE_TTL_MS` (both consumers read the
 * same `NarrativeEntityService` and can tolerate the same staleness — keeping
 * the values in sync avoids one flickering ahead of the other).
 */
const ENTITY_CACHE_TTL_MS = 5000;

/**
 * Applies the `.afe-semantic-tag` styling decorations to `[[kind:id|label]]`
 * entity tags AND (TASK-013) Obsidian-style `[[note]]` links in the markdown
 * editor, distinguishing resolved / ambiguous / unresolved note references.
 * Hover CONTENT for entity tags is owned by the separate
 * {@link SemanticEntityHoverContribution} (a Monaco hover provider that renders
 * the full entity card) — this service still carries no `hoverMessage` for
 * entity decorations, so the two never duplicate rows. The ONE exception is
 * the `note-ambiguous` variant's diagnostic (plan §2/UR-005(1)): there is no
 * other consumer rendering a card for an ambiguous note link, so its
 * `hoverMessage` is set directly here.
 */
@injectable()
export class SemanticMarkdownDecorationService implements FrontendApplicationContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(NoteIndexService)
  protected readonly noteIndexService!: NoteIndexService;

  @inject(NarrativeEntityService)
  protected readonly narrativeEntities!: NarrativeEntityService;

  protected readonly toDispose = new DisposableCollection();
  protected readonly editorDisposables = new Map<TextEditor, DisposableCollection>();
  protected readonly decorationIds = new Map<TextEditor, string[]>();
  protected readonly pendingUpdates = new Map<TextEditor, ReturnType<typeof setTimeout>>();

  protected cachedEntities: NarrativeEntity[] = [];
  protected entityCacheExpiresAt = 0;

  onStart(): void {
    this.toDispose.push(this.editorManager.onCurrentEditorChanged(widget => this.trackEditor(widget)));
    this.trackEditor(this.editorManager.currentEditor ?? this.editorManager.activeEditor);
  }

  onStop(): void {
    this.toDispose.dispose();
    for (const editor of this.editorDisposables.keys()) {
      this.clearDecorations(editor);
    }
    this.editorDisposables.clear();
  }

  protected trackEditor(widget: EditorWidget | undefined): void {
    const editor = widget?.editor;
    if (!editor || this.editorDisposables.has(editor)) {
      return;
    }

    const disposables = new DisposableCollection();
    this.editorDisposables.set(editor, disposables);
    disposables.push(editor.onDocumentContentChanged(() => this.scheduleUpdate(editor)));
    disposables.push(editor.onLanguageChanged(() => this.scheduleUpdate(editor)));
    disposables.push(widget.onDispose(() => {
      this.cancelScheduledUpdate(editor);
      this.clearDecorations(editor);
      this.editorDisposables.get(editor)?.dispose();
      this.editorDisposables.delete(editor);
    }));

    this.updateDecorations(editor);
  }

  /**
   * Re-parsing the whole document on every keystroke stalls typing in large
   * chapters; coalesce bursts of edits into one parse per delay window.
   */
  protected scheduleUpdate(editor: TextEditor): void {
    this.cancelScheduledUpdate(editor);
    this.pendingUpdates.set(editor, setTimeout(() => {
      this.pendingUpdates.delete(editor);
      this.updateDecorations(editor);
    }, DECORATION_UPDATE_DELAY_MS));
  }

  protected cancelScheduledUpdate(editor: TextEditor): void {
    const pending = this.pendingUpdates.get(editor);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingUpdates.delete(editor);
    }
  }

  protected updateDecorations(editor: TextEditor): void {
    void this.doUpdateDecorations(editor);
  }

  /**
   * Hot-path budget (plan §3 "Производительность keystroke", DECORATION_UPDATE_DELAY_MS
   * debounce already coalesces bursts): on every debounced update this method
   * does ONLY (a) a synchronous regex parse of the document text, (b) an
   * in-memory `NoteIndexService.getIndex()` map read (no filesystem access —
   * the index itself is rebuilt out-of-band, never from here), and (c) an
   * in-memory read of the 5s entity cache (refreshed via a single RPC when
   * stale, exactly like `SemanticLinkContribution`). It deliberately NEVER
   * calls `NoteIndexService.resolveTitleLazily` (which reads file contents) —
   * that lazy title/H1 fallback is reserved for non-keystroke consumers
   * (U4's click/open path); an unresolved decoration here honestly reflects
   * only the basename/path miss, not the full title-fallback chain (plan §9
   * ISS-139(d)/§11 documents this narrower-than-full-chain trade-off).
   */
  protected async doUpdateDecorations(editor: TextEditor): Promise<void> {
    if (!this.isMarkdownEditor(editor)) {
      this.clearDecorations(editor);
      return;
    }

    const text = editor.document.getText();
    const entities = await this.getEntities();
    const noteIndex = this.noteIndexService.getIndex();
    // NoteIndexService's `byBasename`/`titleIndex` store the FULL URI strings
    // FileSearchService returns (`file:///...`, see note-index.test.ts) — the
    // document side of the comparison must match that representation
    // (`editor.uri.toString()`), not just the URI's path segment, or
    // `resolveNoteLink`'s directory-distance tie-break would compare
    // mismatched path shapes.
    const documentPath = editor.uri.toString();

    const tokens = classifyWikiLinkDecorations(text, documentPath, entities, noteIndex);
    const newDecorations: EditorDecoration[] = tokens.map(token => ({
      range: {
        start: editor.document.positionAt(token.range.start),
        end: editor.document.positionAt(token.range.end)
      },
      options: {
        className: this.getDecorationClassName(token),
        ...(token.hoverMessage ? { hoverMessage: token.hoverMessage } : {})
      }
    }));

    const oldDecorations = this.decorationIds.get(editor) ?? [];
    this.decorationIds.set(editor, editor.deltaDecorations({
      oldDecorations,
      newDecorations
    }));
  }

  protected clearDecorations(editor: TextEditor): void {
    const oldDecorations = this.decorationIds.get(editor) ?? [];
    if (oldDecorations.length > 0) {
      editor.deltaDecorations({
        oldDecorations,
        newDecorations: []
      });
      this.decorationIds.delete(editor);
    }
  }

  protected isMarkdownEditor(editor: TextEditor): boolean {
    return editor.uri.path.ext.toLowerCase() === '.md' || editor.document.languageId === 'markdown';
  }

  protected getDecorationClassName(token: WikiLinkDecorationToken): string {
    switch (token.variant) {
      case 'entity':
        return `${DECORATION_CLASS_PREFIX} ${DECORATION_CLASS_PREFIX}-${this.normalizeKind(token.kind ?? '')}`;
      case 'note-resolved':
        return `${DECORATION_CLASS_PREFIX} ${DECORATION_CLASS_PREFIX}-note`;
      case 'note-ambiguous':
        return `${DECORATION_CLASS_PREFIX} ${DECORATION_CLASS_PREFIX}-note ${DECORATION_CLASS_PREFIX}-note-ambiguous`;
      case 'note-unresolved':
        return `${DECORATION_CLASS_PREFIX} ${DECORATION_CLASS_PREFIX}-unresolved`;
    }
  }

  protected normalizeKind(kind: string): string {
    return kind.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  }

  /** Refresh the 5s entity cache; kept warm so decoration updates stay cheap. */
  protected async getEntities(): Promise<NarrativeEntity[]> {
    const now = Date.now();
    if (now < this.entityCacheExpiresAt) {
      return this.cachedEntities;
    }
    try {
      const snapshot = await this.narrativeEntities.getSnapshot();
      this.cachedEntities = snapshot.entities;
    } catch {
      // Keep the previous cache if the snapshot RPC fails.
    }
    this.entityCacheExpiresAt = now + ENTITY_CACHE_TTL_MS;
    return this.cachedEntities;
  }
}
