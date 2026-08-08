/**
 * What the timeline panel shows, decided without a shell (gh#48 WP-6).
 *
 * PURE, AND THAT IS WHERE THE TEETH GO. Filtering, searching, the facet lists,
 * which rows are diagnostics and which of the three empty states applies are all
 * decisions; rendering them is not. Keeping them here means the panel's
 * behaviour is asserted against VALUES rather than against a React tree, and the
 * widget test is left to prove only what a widget can uniquely get wrong.
 *
 * ## Ordering is NOT decided here
 *
 * The rows arrive already ordered, because ordering belongs to the store: one
 * rule, written once in `event-ordering.ts`, from which both the SQL and the
 * in-memory predicate are derived. A second ordering in the panel would be a
 * third edition of that rule, and the two orders — story and manuscript —
 * answer different questions that the panel is not entitled to re-decide.
 *
 * What the panel DOES decide is that unplaceable events stay visible: an event
 * the author has not given a `sequence` is real, and a timeline that hid it
 * would be lying about the manuscript to keep its own list tidy.
 *
 * ## Filters combine by AND, and the facets are built from what is there
 *
 * A character filter and a location filter applied together mean "events with
 * both", which is the question an author asks ("where were these two at the
 * same time"). The facet lists are derived from the events themselves rather
 * than from the entity registry: offering a filter that matches nothing is a
 * worse answer than offering fewer.
 */

import type {
  EventOrderExclusion,
  EventRef,
  IndexedEvent,
  NarrativeEvent,
  NarrativeOrigin
} from '@ai-focused-editor/narrative-knowledge';

/** Which order the panel is showing. Mirrors `EventOrderBy`. */
export type TimelineOrder = 'story' | 'manuscript';

/** Roles the panel offers as filters. Deliberately the three the extractor
 *  writes today; the role vocabulary itself is open (gh#57). */
export const TIMELINE_FILTER_ROLES = ['participant', 'location', 'thread'] as const;
export type TimelineFilterRole = (typeof TIMELINE_FILTER_ROLES)[number];

export interface TimelineFilter {
  /** Entity id required in the given role. Absent means "any". */
  readonly participant?: string;
  readonly location?: string;
  readonly thread?: string;
  /** Workspace-relative chapter path the event must name. */
  readonly chapterPath?: string;
  /** Free text matched against the title, case-insensitively. */
  readonly search?: string;
}

/** One row of the panel. */
export interface TimelineRow {
  readonly event: NarrativeEvent;
  /** Timeline file the event was read from — where "open source" goes. */
  readonly relPath: string;
  /** Present when the event has no place in the order being shown. */
  readonly orderExclusion?: EventOrderExclusion;
  /**
   * References naming an id the manuscript does not define.
   *
   * KEPT ON THE ROW rather than filtered out: an author who wrote `char:ivan`
   * before creating Ivan's card made a real statement, and the panel's job is to
   * show it AS A DIAGNOSTIC, not to pretend it was never written.
   */
  readonly brokenRefs: readonly EventRef[];
}

/** One offered filter value, with how many events carry it. */
export interface TimelineFacet {
  readonly id: string;
  readonly count: number;
}

/** Why the panel has nothing to show — three different sentences. */
export type TimelineEmptyKind =
  /** The manuscript holds no events at all. Offer to create the first one. */
  | 'no-events'
  /** There are events; this filter matches none. Offer to clear the filter. */
  | 'no-matches'
  /** Not empty. */
  | 'has-rows';

export interface TimelineViewModel {
  readonly rows: readonly TimelineRow[];
  /** Events the index holds, before filtering — the "N of M" numerator's mate. */
  readonly total: number;
  readonly emptyKind: TimelineEmptyKind;
  /** Values worth offering, per role, built from the events themselves. */
  readonly facets: Readonly<Record<TimelineFilterRole, readonly TimelineFacet[]>>;
  /** Chapters the events name, in the order the events arrived. */
  readonly chapters: readonly TimelineFacet[];
  /** How many rows carry at least one unresolved reference. */
  readonly brokenCount: number;
}

/** `true` when the filter asks for nothing. */
export function isEmptyFilter(filter: TimelineFilter): boolean {
  return (
    filter.participant === undefined &&
    filter.location === undefined &&
    filter.thread === undefined &&
    filter.chapterPath === undefined &&
    (filter.search === undefined || filter.search.trim().length === 0)
  );
}

function refsOf(event: NarrativeEvent, role: TimelineFilterRole): EventRef[] {
  return event.refs.filter(ref => ref.role === role);
}

function matches(event: NarrativeEvent, filter: TimelineFilter): boolean {
  for (const role of TIMELINE_FILTER_ROLES) {
    const wanted = filter[role];
    if (wanted !== undefined && !refsOf(event, role).some(ref => ref.entityId === wanted)) {
      return false;
    }
  }
  if (filter.chapterPath !== undefined && event.chapterPath !== filter.chapterPath) {
    return false;
  }
  const search = filter.search?.trim();
  if (search !== undefined && search.length > 0) {
    // Case-insensitive and locale-aware enough for Cyrillic: `toLowerCase` on
    // both sides, which is what the rest of this package's search does.
    if (!event.title.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function countBy(events: readonly IndexedEvent[], pick: (event: NarrativeEvent) => readonly string[]): TimelineFacet[] {
  const counts = new Map<string, number>();
  for (const indexed of events) {
    // A value named TWICE by one event counts ONCE for that event: the facet
    // answers "how many events would this filter keep", and the filter is a
    // membership test.
    for (const id of new Set(pick(indexed.event))) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => right.count - left.count || compareByCodePoint(left.id, right.id));
}

/** Code-point order, matching what the store promises everywhere else. */
function compareByCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the panel's state from an ordered list of events.
 *
 * `events` MUST ALREADY BE ORDERED — see the module note. This function
 * preserves their order exactly; it filters and annotates, it does not sort.
 */
export function buildTimelineViewModel(
  events: readonly IndexedEvent[],
  filter: TimelineFilter = {}
): TimelineViewModel {
  const rows: TimelineRow[] = [];
  for (const indexed of events) {
    if (!matches(indexed.event, filter)) {
      continue;
    }
    rows.push({
      event: indexed.event,
      relPath: indexed.relPath,
      ...(indexed.orderExclusion === undefined ? {} : { orderExclusion: indexed.orderExclusion }),
      brokenRefs: indexed.event.refs.filter(ref => !ref.resolved)
    });
  }

  const facets = {
    participant: countBy(events, event => refsOf(event, 'participant').map(ref => ref.entityId)),
    location: countBy(events, event => refsOf(event, 'location').map(ref => ref.entityId)),
    thread: countBy(events, event => refsOf(event, 'thread').map(ref => ref.entityId))
  } as const;

  return {
    rows,
    total: events.length,
    // THREE STATES, NOT TWO. "You have no events yet" and "your filter matches
    // none of your events" need different sentences and different offers, and a
    // panel that showed one message for both would send an author looking for a
    // feature they already have.
    emptyKind: rows.length > 0 ? 'has-rows' : events.length === 0 ? 'no-events' : 'no-matches',
    facets,
    chapters: countBy(events, event => (event.chapterPath === undefined ? [] : [event.chapterPath])),
    brokenCount: rows.filter(row => row.brokenRefs.length > 0).length
  };
}

/**
 * A short, human reason for an event having no place in the current order.
 *
 * RETURNS A KEY, NOT A SENTENCE: the panel localizes. Exhaustive over
 * `EventOrderExclusion` by a total record, so a sixth reason added to the union
 * fails to compile here rather than rendering as nothing.
 */
export const TIMELINE_EXCLUSION_KEYS: Record<EventOrderExclusion, string> = {
  'no-sequence': 'no-sequence',
  'no-chapter': 'no-chapter',
  'chapter-not-indexed': 'chapter-not-indexed',
  'no-chapter-order': 'no-chapter-order',
  'not-in-built-book': 'not-in-built-book'
};

/** Origins the panel badges. Total, so a fourth origin cannot render blank. */
export const TIMELINE_ORIGIN_KEYS: Record<NarrativeOrigin, string> = {
  explicit: 'explicit',
  derived: 'derived',
  'ai-candidate': 'ai-candidate'
};
