/**
 * The timeline panel (gh#48 WP-6, plan Р-8).
 *
 * ## What is decided here and what is not
 *
 * NOTHING ABOUT WHICH ROWS TO SHOW. Filtering, searching, the facet lists, which
 * rows are diagnostics and which of the three empty states applies are
 * `timeline-view-model.ts`, pure and asserted against values. This class fetches,
 * renders and navigates — and its own test asserts the RENDERED tree, because
 * that is the part a view model cannot get wrong on its behalf.
 *
 * NOTHING ABOUT ORDER EITHER. The two orders are the store's, one rule written
 * once in `event-ordering.ts`; the toggle changes the QUERY, not a comparator
 * here. That is why switching it costs a round trip: the alternative is a second
 * edition of an ordering rule this project has already paid to keep single.
 *
 * ## Four states, not two
 *
 * The envelope distinguishes `ready`-and-empty from `not-ready` from `failed`
 * from `stale`, and the panel says all four in its own words. A list that
 * rendered "no events" while the index was rebuilding would be asserting an
 * absence nobody checked — the exact confusion `SectionAvailability` and
 * `Envelope` exist to prevent.
 *
 * ## Navigation degrades rather than lying
 *
 * An event points at a passage with `sourceRefs`. A `range` reference opens the
 * chapter AT that range; a `whole-file` reference opens the chapter with NO
 * selection, because `evidence.ts` is explicit that a weaker claim must stay
 * distinguishable from a precise one. Landing at the top of the right file is
 * honest; landing confidently on the wrong paragraph is not.
 */

import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { OpenerService, open } from '@theia/core/lib/browser';
import { nls } from '@theia/core/lib/common/nls';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import React from '@theia/core/shared/react';
import type URI from '@theia/core/lib/common/uri';
import {
  NarrativeIndexChangeWatcher,
  NarrativeKnowledgeService,
  isRangeEvidence,
  type EvidenceRef,
  type IndexedEvent,
  type NarrativeIndexChangedEvent,
  type NarrativeIndexChangeWatcher as NarrativeIndexChangeWatcherType,
  type NarrativeKnowledgeService as NarrativeKnowledgeServiceType,
  type IndexState
} from '@ai-focused-editor/narrative-knowledge';
import {
  buildTimelineViewModel,
  isEmptyFilter,
  TIMELINE_FILTER_ROLES,
  type TimelineFilter,
  type TimelineOrder,
  type TimelineRow,
  type TimelineViewModel
} from '../common/timeline-view-model';

const h = React.createElement;

@injectable()
export class TimelineWidget extends ReactWidget {
  static readonly ID = 'ai-focused-editor.timeline';
  static readonly LABEL = 'Timeline';

  @inject(NarrativeKnowledgeService)
  protected readonly knowledge!: NarrativeKnowledgeServiceType;

  @inject(NarrativeIndexChangeWatcher)
  protected readonly indexChangeWatcher!: NarrativeIndexChangeWatcherType;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  @inject(OpenerService)
  protected readonly openerService!: OpenerService;

  protected rootUri: string | undefined;
  protected order: TimelineOrder = 'story';
  protected filter: TimelineFilter = {};
  protected events: readonly IndexedEvent[] = [];
  protected state: IndexState | undefined;
  protected loading = false;
  /** A change arrived while hidden; refresh when the panel is shown again. */
  protected pendingRefresh = false;

  @postConstruct()
  protected init(): void {
    this.id = TimelineWidget.ID;
    this.title.label = nls.localize('ai-focused-editor/timeline/panel-title', TimelineWidget.LABEL);
    this.title.caption = nls.localize(
      'ai-focused-editor/timeline/panel-caption',
      'Manuscript events in story or manuscript order'
    );
    this.title.iconClass = 'fa fa-clock-o';
    this.title.closable = true;
    this.addClass('afe-timeline');
    this.toDispose.push(this.indexChangeWatcher.onDidIndexChange(event => this.onIndexChanged(event)));
    this.toDispose.push(
      this.onDidChangeVisibility(visible => {
        if (visible && this.pendingRefresh) {
          this.pendingRefresh = false;
          void this.refresh();
        }
      })
    );
    void this.refresh();
  }

  /**
   * EVERY index change refreshes, not only the first.
   *
   * The lesson gh#46 wrote down as "a subscription that fired once": a handler
   * that unsubscribes, or that guards on a flag it never clears, looks identical
   * to a working one under a test that makes ONE edit. This one is asserted with
   * two.
   */
  protected onIndexChanged(event: NarrativeIndexChangedEvent): void {
    if (this.rootUri === undefined || event.rootUri !== this.rootUri) {
      return;
    }
    if (this.isVisible) {
      void this.refresh();
    } else {
      this.pendingRefresh = true;
    }
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.update();
    try {
      this.rootUri = await this.resolveRootUri();
      if (this.rootUri === undefined) {
        this.events = [];
        this.state = undefined;
        return;
      }
      const answer = await this.knowledge.listEvents(this.rootUri, {
        orderBy: this.order,
        direction: 'asc'
      });
      // BOTH FROM ONE ENVELOPE. The list and the readiness the panel reports
      // beside it are two views of one answer; taking them from two calls could
      // straddle a rebuild and let the panel say "ready" over a list from
      // another generation (architecture §3.1).
      this.state = answer.state;
      this.events = answer.data;
    } finally {
      this.loading = false;
      this.update();
    }
  }

  async setOrder(order: TimelineOrder): Promise<void> {
    if (this.order === order) {
      return;
    }
    this.order = order;
    // A ROUND TRIP, NOT A LOCAL SORT — see the class note.
    await this.refresh();
  }

  setFilter(filter: TimelineFilter): void {
    this.filter = filter;
    this.update();
  }

  /** The model the panel is currently rendering. Exposed so a test — and the
   *  view contribution's focused commands — read the same value the render
   *  does, rather than re-deriving it from a second query. */
  get model(): TimelineViewModel {
    return buildTimelineViewModel(this.events, this.filter);
  }

  /** The filter in force. Read by the focused commands so they NARROW what the
   *  author already chose instead of replacing it. */
  get filterValue(): TimelineFilter {
    return this.filter;
  }

  /** The order in force — read by the panel's own test and by nothing else. */
  get orderValue(): TimelineOrder {
    return this.order;
  }

  protected async resolveRootUri(): Promise<string | undefined> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    return root?.resource.toString();
  }

  protected render(): React.ReactNode {
    return h(
      'div',
      { className: 'afe-timeline-body' },
      this.renderToolbar(),
      this.renderStatus(),
      this.renderRows()
    );
  }

  protected renderToolbar(): React.ReactNode {
    const model = this.model;
    const orderButton = (order: TimelineOrder, label: string): React.ReactNode =>
      h(
        'button',
        {
          key: order,
          className: this.order === order ? 'afe-timeline-order active' : 'afe-timeline-order',
          'data-order': order,
          'aria-pressed': this.order === order,
          onClick: () => void this.setOrder(order)
        },
        label
      );
    return h(
      'div',
      { className: 'afe-timeline-toolbar' },
      h(
        'div',
        { className: 'afe-timeline-orders' },
        orderButton('story', nls.localize('ai-focused-editor/timeline/order-story', 'Story order')),
        orderButton('manuscript', nls.localize('ai-focused-editor/timeline/order-manuscript', 'Manuscript order'))
      ),
      h('input', {
        className: 'afe-timeline-search',
        type: 'search',
        value: this.filter.search ?? '',
        placeholder: nls.localize('ai-focused-editor/timeline/search', 'Search titles'),
        onChange: (event: { target: { value: string } }) =>
          this.setFilter({ ...this.filter, search: event.target.value })
      }),
      ...TIMELINE_FILTER_ROLES.map(role =>
        h(
          'select',
          {
            key: role,
            className: 'afe-timeline-facet',
            'data-role': role,
            value: this.filter[role] ?? '',
            onChange: (event: { target: { value: string } }) =>
              this.setFilter({
                ...this.filter,
                [role]: event.target.value === '' ? undefined : event.target.value
              })
          },
          h('option', { key: '', value: '' }, nls.localize('ai-focused-editor/timeline/any', 'Any')),
          ...model.facets[role].map(facet =>
            h('option', { key: facet.id, value: facet.id }, `${facet.id} (${facet.count})`)
          )
        )
      )
    );
  }

  /**
   * The index's own state, in the panel's words.
   *
   * A `stale` index still ANSWERS — the rows below are real — so the line says
   * so rather than blanking the list. `not-built`, `rebuilding` and `failed` are
   * each different from "you have no events", which is why none of them falls
   * through to the empty state.
   */
  protected renderStatus(): React.ReactNode {
    const state = this.state;
    if (this.loading) {
      return h('div', { className: 'afe-timeline-status', 'data-status': 'loading' },
        nls.localize('ai-focused-editor/timeline/loading', 'Loading…'));
    }
    if (state === undefined) {
      return h('div', { className: 'afe-timeline-status', 'data-status': 'no-workspace' },
        nls.localize('ai-focused-editor/timeline/no-workspace', 'Open a manuscript folder to see its timeline.'));
    }
    if (state.state === 'failed') {
      return h('div', { className: 'afe-timeline-status', 'data-status': 'failed' },
        nls.localize('ai-focused-editor/timeline/failed', 'The index could not be read, so this list may be incomplete.'));
    }
    if (state.state === 'rebuilding') {
      return h('div', { className: 'afe-timeline-status', 'data-status': 'rebuilding' },
        nls.localize('ai-focused-editor/timeline/rebuilding', 'The index is rebuilding — this list is not final yet.'));
    }
    if (state.state === 'absent') {
      // `absent` carries WHY — "this folder is not a manuscript" and "the index
      // was never built" are different things to tell an author, and the cause
      // is what tells them apart.
      return h('div', { className: 'afe-timeline-status', 'data-status': 'absent', 'data-cause': state.cause },
        state.cause === 'no-manuscript'
          ? nls.localize('ai-focused-editor/timeline/no-manuscript', 'This folder is not a manuscript, so it has no timeline.')
          : nls.localize('ai-focused-editor/timeline/not-built', 'The index is not built yet, so no events can be listed.'));
    }
    if (state.state === 'stale') {
      return h('div', { className: 'afe-timeline-status', 'data-status': 'stale' },
        nls.localize('ai-focused-editor/timeline/stale', 'The index may be behind the files — recent edits might be missing.'));
    }
    return undefined;
  }

  protected renderRows(): React.ReactNode {
    const model = this.model;
    if (model.emptyKind === 'no-events') {
      return h('div', { className: 'afe-timeline-empty', 'data-empty': 'no-events' },
        nls.localize(
          'ai-focused-editor/timeline/empty-no-events',
          'No events yet. Select a passage in a chapter and run “Add Timeline Event from Selection”.'
        ));
    }
    if (model.emptyKind === 'no-matches') {
      return h('div', { className: 'afe-timeline-empty', 'data-empty': 'no-matches' },
        nls.localize(
          'ai-focused-editor/timeline/empty-no-matches',
          'None of your {0} events match this filter.',
          String(model.total)
        ));
    }
    return h(
      'ul',
      { className: 'afe-timeline-list' },
      ...model.rows.map(row => this.renderRow(row)),
      ...(isEmptyFilter(this.filter)
        ? []
        : [
            h('li', { key: '__count', className: 'afe-timeline-count', 'data-count': 'filtered' },
              nls.localize(
                'ai-focused-editor/timeline/showing',
                'Showing {0} of {1}.',
                String(model.rows.length),
                String(model.total)
              ))
          ])
    );
  }

  protected renderRow(row: TimelineRow): React.ReactNode {
    const target = row.event.sourceRefs[0];
    return h(
      'li',
      {
        key: row.event.id,
        className: 'afe-timeline-row',
        'data-event': row.event.id,
        'data-origin': row.event.origin,
        ...(row.orderExclusion === undefined ? {} : { 'data-unplaced': row.orderExclusion }),
        ...(row.brokenRefs.length > 0 ? { 'data-broken': String(row.brokenRefs.length) } : {})
      },
      h(
        'button',
        {
          className: 'afe-timeline-title',
          disabled: target === undefined,
          onClick: () => (target === undefined ? undefined : void this.openEvidence(target))
        },
        row.event.title
      ),
      // ORIGIN IS VISIBLE, because the issue's own criterion is that explicit,
      // derived and unapproved AI candidates are told apart at a glance.
      h('span', { className: `afe-timeline-origin afe-timeline-origin-${row.event.origin}` }, row.event.origin),
      ...(row.orderExclusion === undefined
        ? []
        : [h('span', { className: 'afe-timeline-unplaced' },
            nls.localize(`ai-focused-editor/timeline/exclusion-${row.orderExclusion}`, row.orderExclusion))]),
      // A BROKEN REFERENCE IS A ROW OF ITS OWN WORDS, not a missing row. The
      // author wrote `char:ivan` before creating Ivan's card, and that is a real
      // statement about their story.
      ...row.brokenRefs.map(ref =>
        h('span', { key: ref.raw, className: 'afe-timeline-broken', 'data-broken-ref': ref.raw }, ref.raw)
      )
    );
  }

  /**
   * Open the passage an event points at.
   *
   * A `whole-file` reference opens the chapter WITHOUT a selection — see the
   * class note. Manufacturing a range for it would make the weaker claim
   * indistinguishable from a precise one at the only moment it matters.
   */
  protected async openEvidence(evidence: EvidenceRef): Promise<void> {
    const root = this.workspaceService.tryGetRoots()[0]?.resource;
    if (root === undefined) {
      return;
    }
    const uri: URI = root.resolve(evidence.path);
    if (!isRangeEvidence(evidence)) {
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
