/**
 * The two orders an event list can be in (gh#48 WP-2).
 *
 * SAME SHAPE AS `mention-ordering.ts`, deliberately: one rule stated once, a
 * predicate for the in-memory adapter and an `ORDER BY` generated from the same
 * reasoning for SQLite, with the shared contract suite running identical
 * assertions against both. That file's own history is the argument — the two
 * adapters drifted on the trailing group there, and only the shared suite caught
 * it.
 *
 * ## Two orders, and they answer different questions
 *
 * STORY order is the order things happened, and it is `sequence` — a number the
 * author writes. MANUSCRIPT order is the order the reader meets them, and it is
 * the chapter's place in the built book. A flashback has a low `sequence` and a
 * late chapter; collapsing the two would make one of those questions
 * unanswerable.
 *
 * ## Nothing is ordered by a date
 *
 * `story_time.value` is freeform — "three winters later", a season, a date — and
 * `narrative-event.ts` says why comparing it would be a fabrication. Time
 * appears in diagnostics and never in a sort key.
 */

import type { MentionOrderDocument } from './mention-ordering';
import type { NarrativeEvent } from './narrative-event';

/** Which order a query asks for. */
export type EventOrderBy = 'story' | 'manuscript';

/**
 * Why an event cannot be placed in the requested order.
 *
 * DISTINCT PER ORDER, because the same event can be placeable in one and not the
 * other: an event with a `sequence` and no chapter has a story position and no
 * manuscript position. A single boolean would force a consumer to guess which.
 */
export type EventOrderExclusion =
  /** Story order: the author has not given it a `sequence` yet. */
  | 'no-sequence'
  /** Manuscript order: the event names no chapter. */
  | 'no-chapter'
  /** Manuscript order: the chapter it names is not in the index. */
  | 'chapter-not-indexed'
  /** Manuscript order: the chapter has no place in the manifest. */
  | 'no-chapter-order'
  /** Manuscript order: the chapter is excluded from the built book. */
  | 'not-in-built-book';

/**
 * Why `event` cannot be placed, or `undefined` when it can.
 *
 * `resolveDocument` is only consulted for manuscript order — story order is a
 * property of the event alone, and asking the store for a document to answer it
 * would be a cost with no question behind it.
 */
export function eventOrderExclusion(
  event: NarrativeEvent,
  orderBy: EventOrderBy,
  resolveDocument: (relPath: string) => MentionOrderDocument | undefined
): EventOrderExclusion | undefined {
  if (orderBy === 'story') {
    return event.sequence === undefined ? 'no-sequence' : undefined;
  }
  if (event.chapterPath === undefined) {
    return 'no-chapter';
  }
  const document = resolveDocument(event.chapterPath);
  if (document === undefined) {
    // NOT folded into `no-chapter-order`: "the author named a chapter that does
    // not exist" is a fixable authoring mistake, and "the chapter exists and the
    // manifest omits it" is a different one. A consumer rendering advice needs
    // to tell them apart.
    return 'chapter-not-indexed';
  }
  if (document.chapterOrder === undefined) {
    return 'no-chapter-order';
  }
  if (!document.buildIncluded) {
    return 'not-in-built-book';
  }
  return undefined;
}

/**
 * Order events, unplaceable ones trailing in BOTH directions.
 *
 * THE TRAILING RULE IS THE SAME ONE, AND FOR THE SAME REASON. Mirroring the
 * exclusion flag with the direction reads as the symmetric choice and is the
 * worse one: an event with no `sequence` would become the "last thing that
 * happened" under `desc` exactly as readily as it would become the first under
 * `asc`. Trailing in both says the true thing — these are real events, and
 * neither end of the story is a claim they can support.
 */
export function orderEvents(
  events: readonly NarrativeEvent[],
  orderBy: EventOrderBy,
  direction: 'asc' | 'desc',
  resolveDocument: (relPath: string) => MentionOrderDocument | undefined
): NarrativeEvent[] {
  const sign = direction === 'desc' ? -1 : 1;
  const keyed = events.map((event, insertionIndex) => {
    const excluded = eventOrderExclusion(event, orderBy, resolveDocument) !== undefined;
    const document = event.chapterPath === undefined ? undefined : resolveDocument(event.chapterPath);
    return {
      event,
      insertionIndex,
      excluded,
      primary: orderBy === 'story' ? event.sequence ?? 0 : document?.chapterOrder ?? 0
    };
  });
  keyed.sort((a, b) => {
    // ALWAYS ascending on this key, in both directions.
    if (a.excluded !== b.excluded) {
      return a.excluded ? 1 : -1;
    }
    if (a.excluded) {
      return compareIds(a.event.id, b.event.id);
    }
    if (a.primary !== b.primary) {
      return sign * (a.primary - b.primary);
    }
    // ID BREAKS THE TIE, NOT INSERTION ORDER. Two events sharing a `sequence` is
    // ordinary — an author numbers in tens and then writes two things "at the
    // same time" — and the answer must survive a rebuild, which insertion order
    // does not. This is what makes "stable after restart" an assertion.
    return compareIds(a.event.id, b.event.id);
  });
  return keyed.map(entry => entry.event);
}

/** Code-point order, matching SQLite's default BINARY collation (ISS-349). */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The SQLite spelling of {@link orderEvents}, for a query that has joined
 * `event e` to `document d` (LEFT, because an event may name no chapter — and
 * because it may name one that is not indexed, which is a different fact the
 * join must be able to express by finding nothing).
 *
 * THE JOIN IS ON `d.rel_path = e.chapter_rel_path`, so "is this chapter
 * indexed" is asked at READ time — the same moment the in-memory adapter asks
 * it. A stored `doc_id` answered it once, at write time, and the two adapters
 * disagreed about an event whose chapter was indexed afterwards.
 *
 * Both `${}` interpolations are narrowed unions mapped through a switch, so no
 * caller-supplied string reaches the SQL. The exclusion flag stays `ASC`.
 */
export function eventOrderSql(orderBy: EventOrderBy, direction: 'asc' | 'desc'): string {
  const dir = direction === 'desc' ? 'DESC' : 'ASC';
  const excluded =
    orderBy === 'story'
      ? 'e.sequence IS NULL'
      : `d.doc_id IS NULL OR d.chapter_order IS NULL OR d.build_included = 0`;
  const primary = orderBy === 'story' ? 'e.sequence' : 'd.chapter_order';
  // Neutralised for excluded rows rather than merely flagged — the mistake the
  // mention ordering made and the shared suite caught: SQLite orders NULL FIRST
  // under ASC, so an unplaceable row would lead its own trailing group, and that
  // group's internal order would flip with `direction`.
  return `ORDER BY
      (CASE WHEN ${excluded} THEN 1 ELSE 0 END) ASC,
      (CASE WHEN ${excluded} THEN 0 ELSE ${primary} END) ${dir},
      e.event_id ASC`;
}
