/**
 * A manuscript event — the domain type of gh#48.
 *
 * ## Why events are not entity cards
 *
 * The obvious cheap move is to declare `event` an entity kind and let the
 * existing registry carry it. That was considered and rejected: the registry
 * drags a form, a wiki tag kind, a navigator section and a Book Doctor rule
 * along with it, an event needs none of those, and an event's substance —
 * an order, typed references with roles, a story time — does not fit the flat
 * fields of a card. So events are their own shape, stored in their own table,
 * read through the same service.
 *
 * ## The one thing this file refuses to do
 *
 * IT DOES NOT COMPARE STORY TIMES. `story_time.value` is whatever the author
 * wrote — a date, "three winters later", a season. The project already learned
 * this on `ownership.from`/`to`, whose own validator states they are freeform
 * story-time labels ordered by list position, and gh#46 recorded the
 * consequence: they cannot drive a timeline. Ordering is `sequence`, an explicit
 * number the author controls; the parsed date, when there is one, exists only so
 * that {@link NarrativeEventProblem} can say "this claims to be exact and is not
 * a date". Sorting by a value nobody can compare would be a fabrication wearing
 * a chronology.
 */

import type { EvidenceRef } from './evidence';
import type { NarrativeOrigin } from './narrative-origin';

/**
 * How firmly an event is placed in story time.
 *
 * CLOSED UNION WITH A DATA TWIN, the same device `NARRATIVE_ORIGINS` uses: a
 * fifth value has to be added in two places, and the second is what a total
 * `Record` over the union will refuse to compile without.
 *
 * `unknown` IS A REAL ANSWER, not a missing one. An author who knows an event
 * happened and not when has said something true, and an event that could not
 * carry that would push them into inventing a time.
 */
export type EventTimeKind = 'exact' | 'relative' | 'sequence' | 'unknown';

/** Every member of {@link EventTimeKind}, as data. */
export const EVENT_TIME_KINDS = ['exact', 'relative', 'sequence', 'unknown'] as const satisfies readonly EventTimeKind[];

/**
 * What role an entity plays in an event.
 *
 * OPAQUE, LIKE `relType`. The vocabulary of roles becomes the author's with
 * gh#57; hard-coding a union here would make that a breaking change instead of
 * an additive one. The three below are what the manuscript schema writes today
 * and are documented rather than enforced.
 */
export type EventRefRole = string;

/** The roles this package writes today. Not a closed set — see {@link EventRefRole}. */
export const KNOWN_EVENT_REF_ROLES = ['participant', 'location', 'thread'] as const;

/**
 * One reference from an event to an entity.
 *
 * AN UNRESOLVED REFERENCE IS KEPT, exactly as an unresolved mention is. An
 * author who writes `char:ivan` before creating Ivan's card has made a real
 * statement about their story; dropping it would hide the very thing they most
 * need to see, and `resolved: false` is what lets a diagnostic point at it.
 */
export interface EventRef {
  role: EventRefRole;
  /** Verbatim as written — `char:ivan`, `location:moscow`. */
  raw: string;
  /** The id part, split from the kind prefix. Present even when unresolved. */
  entityId: string;
  /** The `kind:` prefix when one was written. */
  kind?: string;
  /** False when no card defines {@link entityId}. */
  resolved: boolean;
}

/** Story time as the author stated it, plus what could be made of it. */
export interface EventStoryTime {
  kind: EventTimeKind;
  /** Verbatim. Absent for `unknown`, and absent is not `''`. */
  value?: string;
  /**
   * `value` parsed as an instant, when `kind` is `exact` AND it parses.
   *
   * PRESENT ONLY FOR DIAGNOSTICS. Nothing orders by it — see the module note.
   * Its absence beside `kind: 'exact'` is precisely what makes
   * `exact-time-unparsable` reportable.
   */
  parsedMs?: number;
}

export interface NarrativeEvent {
  /** Stable, rebuild-surviving identity. Unique across the manuscript. */
  id: string;
  title: string;
  storyTime: EventStoryTime;
  /**
   * The author's explicit narrative order.
   *
   * THE ONLY THING THAT ORDERS EVENTS, and absent is allowed: an event the
   * author has not placed yet is real, and it trails the ordered ones rather
   * than being dropped or guessed at.
   */
  sequence?: number;
  /** Workspace-relative path of the chapter the event belongs to, when stated. */
  chapterPath?: string;
  refs: EventRef[];
  origin: NarrativeOrigin;
  /** Author or model confidence, when stated. Never defaulted — an absent
   *  confidence and a stated `1` are different claims. */
  confidence?: number;
  /** Where the event was read from. Required: an event that cannot be navigated
   *  to is the failure this index exists to prevent. */
  evidence: EvidenceRef;
  /** Passages the event points at, beyond the file it was read from. */
  sourceRefs: EvidenceRef[];
}

/** Why an event could not be read, or was read with a defect. */
export type NarrativeEventProblemKind =
  /** The file is not a mapping, or `events:` is not a list. */
  | 'malformed'
  /** No `id`, or it is not a non-empty string. */
  | 'missing-id'
  /** No `title`. */
  | 'missing-title'
  /** `story_time.kind` is not a member of {@link EventTimeKind}. */
  | 'unknown-time-kind'
  /** `kind: exact` with a `value` that is not a parsable instant. */
  | 'exact-time-unparsable'
  /** `sequence` is present and not a finite number. */
  | 'invalid-sequence';

export interface NarrativeEventProblem {
  kind: NarrativeEventProblemKind;
  /** Workspace-relative path of the file the problem is in. */
  path: string;
  /** The event id when one could be read — absent for `missing-id`. */
  eventId?: string;
  message: string;
}
