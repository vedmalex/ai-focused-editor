/**
 * The contextual entity card (gh#47 WP-4).
 *
 * A SECOND PANEL BESIDE `EntityCardsWidget`, NOT A MODE INSIDE IT (decision D2).
 * The list answers "what is in this book"; this answers "who is under my
 * cursor". They have different state — a pinned entity versus a scroll position
 * — and folding them would make one widget with two personalities where the two
 * states compete.
 *
 * THIN BY CONSTRUCTION. Every rule about what a card shows lives in
 * `common/entity-card.ts`, which has no DOM and runs in the ordinary test
 * process. What is left here is rendering and the two things only a widget can
 * own: which entity is being shown, and whether the author pinned it.
 */

import URI from '@theia/core/lib/common/uri';
import { open, OpenerService } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
  NarrativeIndexChangeWatcher,
  isRangeEvidence,
  type EntityAppearance,
  type NarrativeIndexChangeWatcher as NarrativeIndexChangeWatcherType
} from '@ai-focused-editor/narrative-knowledge';
import { shouldFollowCursor, type EntityCardViewModel } from '../common';
import { EntityCardService, type EntityCardResult } from './entity-card-service';

const KEY = 'ai-focused-editor/entities/card';

@injectable()
export class EntityCardWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.entity-card';
  static readonly LABEL = 'Knowledge Card';

  @inject(EntityCardService)
  protected readonly cards!: EntityCardService;

  @inject(NarrativeIndexChangeWatcher)
  protected readonly indexChangeWatcher!: NarrativeIndexChangeWatcherType;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  /** The entity currently shown, or `undefined` before anything is asked for. */
  protected entityId: string | undefined;
  protected result: EntityCardResult | undefined;
  /**
   * While pinned, {@link followCursor} is ignored.
   *
   * THE POINT OF THE PANEL, not a convenience: gh#47's workflow is "remember a
   * character WHILE WRITING", and a card that swaps itself out as the caret
   * moves through prose is unusable for exactly that. An explicit `showEntity`
   * (the command, a click) still wins — pinning resists the cursor, not the
   * author.
   */
  protected pinned = false;
  /** Set when a change arrives while this panel is hidden (same catch-up rule
   *  as `EntityCardsWidget`: a hidden panel must not pull, but must not go on
   *  showing stale data once shown again). */
  protected pendingRefresh = false;

  @postConstruct()
  protected init(): void {
    this.id = EntityCardWidget.ID;
    this.title.label = nls.localize(`${KEY}-title`, EntityCardWidget.LABEL);
    this.title.caption = nls.localize(`${KEY}-caption`, 'The entity under the cursor, with its sources');
    this.title.iconClass = 'fa fa-id-card-o';
    this.title.closable = true;
    this.addClass('afe-entity-card-widget');
    this.toDispose.push(this.indexChangeWatcher.onDidIndexChange(() => this.onIndexChanged()));
    this.toDispose.push(
      this.onDidChangeVisibility(visible => {
        if (visible && this.pendingRefresh) {
          this.pendingRefresh = false;
          void this.refresh();
        }
      })
    );
    this.update();
  }

  /** Show `entityId`, whatever the pin says. Explicit intent outranks it. */
  async showEntity(entityId: string): Promise<void> {
    this.entityId = entityId;
    await this.refresh();
  }

  /**
   * Show `entityId` because the caret moved onto it.
   *
   * IGNORED WHILE PINNED — the whole reason pinning exists. Also ignored when it
   * names the entity already on screen, so cursor movement inside one tag does
   * not re-issue RPC on every keystroke.
   */
  async followCursor(entityId: string): Promise<void> {
    if (!shouldFollowCursor(this.pinned, this.entityId, entityId)) {
      return;
    }
    await this.showEntity(entityId);
  }

  get isPinned(): boolean {
    return this.pinned;
  }

  togglePin(): void {
    this.pinned = !this.pinned;
    this.update();
  }

  protected onIndexChanged(): void {
    if (this.entityId === undefined) {
      return;
    }
    if (this.isVisible) {
      void this.refresh();
    } else {
      this.pendingRefresh = true;
    }
  }

  async refresh(): Promise<void> {
    if (this.entityId === undefined) {
      return;
    }
    this.result = await this.cards.getCard(this.entityId);
    this.update();
  }

  protected render(): React.ReactNode {
    if (this.result === undefined) {
      return this.message(nls.localize(`${KEY}-empty`, 'Place the cursor on a semantic link to see its card.'));
    }
    if (this.result.kind === 'no-workspace') {
      return this.message(nls.localize(`${KEY}-no-workspace`, 'Open a manuscript to see knowledge cards.'));
    }
    if (this.result.kind === 'unknown-entity') {
      // TWO DIFFERENT SENTENCES, and the difference is the point: "no such
      // entity" is a fact about the manuscript, "the index is not ready" is a
      // fact about the tool. Rendering one for both would tell the author their
      // character does not exist while the index is still starting up.
      return this.message(
        this.result.indexState.state === 'ready'
          ? nls.localize(`${KEY}-unknown`, 'No card defines "{0}" yet.', this.result.entityId)
          : nls.localize(`${KEY}-not-ready`, 'The index is not ready yet, so "{0}" cannot be looked up.', this.result.entityId)
      );
    }
    return this.renderCard(this.result.card);
  }

  protected message(text: string): React.ReactNode {
    return React.createElement('div', { className: 'afe-entity-card-message' }, text);
  }

  protected renderCard(card: EntityCardViewModel): React.ReactNode {
    const children: React.ReactNode[] = [
      React.createElement(
        'div',
        { className: 'afe-entity-card-header', key: 'header' },
        React.createElement('span', { className: 'afe-entity-card-name' }, card.entity.name),
        card.type === undefined
          ? undefined
          : React.createElement('span', { className: 'afe-entity-card-type' }, card.type.label),
        React.createElement(
          'button',
          {
            className: 'theia-button afe-entity-card-pin',
            onClick: () => this.togglePin(),
            title: this.pinned
              ? nls.localize(`${KEY}-unpin`, 'Unpin: follow the cursor again')
              : nls.localize(`${KEY}-pin`, 'Pin: keep this card while writing')
          },
          this.pinned ? '📌' : '📍'
        )
      )
    ];

    if (card.otherNames.length > 0) {
      children.push(
        React.createElement(
          'div',
          { className: 'afe-entity-card-names', key: 'names' },
          `${nls.localize(`${KEY}-other-names`, 'Also known as')}: ${card.otherNames.join(', ')}`
        )
      );
    }

    // Only facts that HAVE a value are in the model at all — the emptiness rule
    // is enforced by `buildEntityCard`, so there is no guard to forget here.
    for (const fact of card.explicitFacts) {
      children.push(
        React.createElement(
          'div',
          { className: 'afe-entity-card-fact', key: `fact-${fact.field}` },
          React.createElement(
            'span',
            { className: 'afe-entity-card-fact-label' },
            nls.localize(`ai-focused-editor/entities/field/${fact.field}`, fact.field)
          ),
          React.createElement(
            'span',
            { className: 'afe-entity-card-fact-value' },
            Array.isArray(fact.value) ? fact.value.join(' · ') : fact.value
          )
        )
      );
    }

    if (card.chapterCount > 0) {
      children.push(
        React.createElement(
          'div',
          { className: 'afe-entity-card-spread', key: 'spread' },
          nls.localize(`${KEY}-chapters`, 'Appears in {0} document(s)', String(card.chapterCount))
        )
      );
    }

    const first = card.firstAppearance;
    if (first !== undefined) {
      children.push(this.renderAppearance('first', nls.localize(`${KEY}-first`, 'First appearance'), first));
    }
    // NO SAMENESS CHECK HERE: the model already omits `latestAppearance` when it
    // is the same place as the first. Deciding it again in the renderer is how
    // the first edition compared `mention.raw` — the tag TEXT, equal across
    // chapters — and silently dropped the latest appearance in the commonest
    // case there is.
    const latest = card.latestAppearance;
    if (latest !== undefined) {
      children.push(this.renderAppearance('latest', nls.localize(`${KEY}-latest`, 'Latest appearance'), latest));
    }
    for (const [index, appearance] of card.recentAppearances.entries()) {
      children.push(this.renderAppearance(`recent-${index}`, '', appearance));
    }

    return React.createElement('div', { className: 'afe-entity-card' }, ...children);
  }

  protected renderAppearance(key: string, label: string, appearance: EntityAppearance): React.ReactNode {
    const parts: React.ReactNode[] = [];
    if (label.length > 0) {
      parts.push(React.createElement('span', { className: 'afe-entity-card-appearance-label', key: 'l' }, label));
    }
    parts.push(
      React.createElement(
        'span',
        { className: 'afe-entity-card-appearance-where', key: 'w' },
        appearance.chapterTitle ?? appearance.mention.evidence.path
      )
    );
    if (appearance.excerpt !== undefined) {
      parts.push(React.createElement('blockquote', { key: 'q' }, appearance.excerpt));
    } else if (appearance.excerptUnavailable !== undefined) {
      // SAID IN WORDS, never rendered as an empty quotation. An absent excerpt
      // whose reason is swallowed reads as "nothing is written there".
      parts.push(
        React.createElement(
          'div',
          { className: 'afe-entity-card-excerpt-missing', key: 'q' },
          nls.localize(`${KEY}-excerpt-${appearance.excerptUnavailable}`, this.excerptFallback(appearance))
        )
      );
    }
    parts.push(
      React.createElement(
        'button',
        {
          className: 'theia-button secondary afe-entity-card-open',
          key: 'o',
          onClick: () => void this.openAppearance(appearance)
        },
        nls.localize(`${KEY}-open-source`, 'Open source')
      )
    );
    return React.createElement('div', { className: 'afe-entity-card-appearance', key }, ...parts);
  }

  protected excerptFallback(appearance: EntityAppearance): string {
    switch (appearance.excerptUnavailable) {
      case 'document-changed':
        return 'The file changed after indexing, so this passage cannot be quoted yet.';
      case 'no-position':
        return 'This reference names the file, not a place in it.';
      default:
        return 'This file could not be read.';
    }
  }

  /**
   * Open the manuscript at the appearance.
   *
   * NAVIGATION DEGRADES WITH THE QUOTATION. When the document changed after
   * indexing, the stored range no longer means what it meant — the same reason
   * the excerpt is withheld — so the file is opened WITHOUT a selection rather
   * than jumping confidently to a line that has since moved. Landing at the top
   * of the right file is honest; landing precisely on the wrong paragraph is
   * not.
   */
  protected async openAppearance(appearance: EntityAppearance): Promise<void> {
    const root = this.workspaceService.tryGetRoots()[0]?.resource;
    if (root === undefined) {
      return;
    }
    const uri: URI = root.resolve(appearance.mention.evidence.path);
    const stale = appearance.excerptUnavailable === 'document-changed';
    const evidence = appearance.mention.evidence;
    if (stale || !isRangeEvidence(evidence)) {
      await open(this.openerService, uri);
      return;
    }
    await open(this.openerService, uri, {
      selection: {
        start: { line: evidence.range.start.line, character: evidence.range.start.character },
        end: { line: evidence.range.end.line, character: evidence.range.end.character }
      }
    });
  }
}
