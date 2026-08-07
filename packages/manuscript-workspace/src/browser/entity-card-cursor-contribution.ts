/**
 * The card follows the caret (gh#47 WP-5, closing F-47-1).
 *
 * WHAT WAS WRONG BEFORE THIS FILE: the widget had `followCursor` and nothing
 * called it, so the panel could not show a single entity by any path — the
 * workflow gh#47 is written about did not exist, while a commit claimed WP-5.
 *
 * ## Two costs this file exists to bound
 *
 * PARSING. `findEntityTokenAt` parses the whole document, and the caret moves on
 * every arrow key. The debounce below is what bounds this: a sweep of the caret
 * across a paragraph costs ONE parse, not one per keystroke. There is no parse
 * cache keyed by document version, and this note says so rather than implying
 * one — if profiling on a long chapter shows the parse itself is the cost, that
 * is the next thing to add, and it is not there today.
 *
 * RPC. {@link EntityCardWidget.followCursor} drops a repeat of the entity
 * already shown BEFORE any query is issued, so moving within one tag — or
 * between two tags naming the same entity — costs nothing beyond the parse.
 *
 * ## The two-source rule, applied
 *
 * The resolver answers with an ID; the INDEX answers what is true about it. The
 * `note`-first branch needs to know whether an id names an entity at all, and
 * that predicate is backed here by the index's own entity list, refreshed when
 * the index changes — not by a second snapshot service. A token the resolver
 * declines is not reported as "unknown entity": the card is simply not switched.
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { DisposableCollection } from '@theia/core/lib/common';
import { WidgetManager, type FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EditorManager, TextEditor } from '@theia/editor/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  NarrativeIndexChangeWatcher,
  NarrativeKnowledgeService,
  type NarrativeIndexChangeWatcher as NarrativeIndexChangeWatcherType,
  type NarrativeKnowledgeService as NarrativeKnowledgeServiceType
} from '@ai-focused-editor/narrative-knowledge';
import { findEntityTokenAt } from '../common';
import { EntityCardWidget } from './entity-card-widget';

/** Long enough to swallow a caret sweep, short enough to feel immediate. */
export const CURSOR_FOLLOW_DEBOUNCE_MS = 250;

@injectable()
export class EntityCardCursorContribution implements FrontendApplicationContribution {
  @inject(EditorManager)
  protected readonly editorManager!: EditorManager;

  @inject(WidgetManager)
  protected readonly widgetManager!: WidgetManager;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(NarrativeKnowledgeService)
  protected readonly knowledge!: NarrativeKnowledgeServiceType;

  @inject(NarrativeIndexChangeWatcher)
  protected readonly indexChangeWatcher!: NarrativeIndexChangeWatcherType;

  protected readonly toDispose = new DisposableCollection();
  protected timer: ReturnType<typeof setTimeout> | undefined;
  /** Entity ids the index knows, for the `note`-first branch. Refreshed on
   *  index change rather than polled — the push already exists. */
  protected knownIds: Set<string> | undefined;

  onStart(): void {
    this.toDispose.push(
      this.editorManager.onCreated(widget => this.track(widget.editor))
    );
    for (const widget of this.editorManager.all) {
      this.track(widget.editor);
    }
    this.toDispose.push(this.indexChangeWatcher.onDidIndexChange(() => {
      this.knownIds = undefined;
    }));
  }

  onStop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.toDispose.dispose();
  }

  protected track(editor: TextEditor): void {
    this.toDispose.push(editor.onCursorPositionChanged(() => this.onCursorMoved(editor)));
  }

  protected onCursorMoved(editor: TextEditor): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.resolveAndShow(editor);
    }, CURSOR_FOLLOW_DEBOUNCE_MS);
  }

  protected async resolveAndShow(editor: TextEditor): Promise<void> {
    const widget = this.editorManager.all.find(item => item.editor === editor);
    if (widget === undefined) {
      return;
    }
    const text = editor.document.getText();
    const offset = editor.document.offsetAt(editor.cursor);
    const token = findEntityTokenAt(text, offset, id => this.isKnownEntity(id));
    if (token === undefined) {
      // The caret is not on a reference. The card KEEPS SHOWING what it showed:
      // clearing it on every move through prose would make the panel flicker
      // empty while the author writes, which is the opposite of "remember a
      // character while writing".
      return;
    }
    const card = this.cardWidget();
    await card?.followCursor(token.id);
  }

  /**
   * Whether the index knows this id.
   *
   * SYNCHRONOUS BY NECESSITY — the resolver's predicate cannot await — so the
   * first caret landing on a bare `[[id]]` before the list has loaded answers
   * `false` and simply does not switch the card. It is not reported as "no such
   * entity"; the next caret move after the list arrives resolves normally.
   */
  protected isKnownEntity(id: string): boolean {
    if (this.knownIds === undefined) {
      void this.loadKnownIds();
      return false;
    }
    return this.knownIds.has(id);
  }

  protected async loadKnownIds(): Promise<void> {
    const rootUri = this.workspaceService.tryGetRoots()[0]?.resource.toString();
    if (rootUri === undefined) {
      return;
    }
    const answer = await this.knowledge.findEntities(rootUri);
    this.knownIds = new Set(answer.data.map(entity => entity.id));
  }

  /**
   * The card panel, IF it already exists.
   *
   * `tryGetWidget`, never `getWidget`: the panel is placed in the shell at
   * startup (`initializeLayout`), so it is normally there — but a caret move
   * must not CREATE it, and must never open or focus it. An author who closed
   * the panel has said something, and following the caret is not a reason to
   * overrule them.
   */
  protected cardWidget(): EntityCardWidget | undefined {
    return this.widgetManager.tryGetWidget<EntityCardWidget>(EntityCardWidget.ID);
  }
}
