/**
 * `Envelope<T>` — data and the state it was read under, together (TASK-022
 * WP-4a; the rule is plan WP-1, "каждый читающий метод отдаёт `IndexState`
 * вместе с данными").
 *
 * WHY EVERY READ CARRIES ONE. An empty list is ambiguous in exactly the way
 * that matters: "no such relation exists" and "the index is being rebuilt" and
 * "the index is broken" all look like `[]`. A consumer that cannot tell them
 * apart will present a rebuild as an authoritative absence, which is the single
 * failure mode this whole epic exists to remove.
 *
 * WHY A WRAPPER AND NOT AN INTERSECTION. `T & { state }` collides the moment a
 * payload has a field called `state` — and `SectionAvailability` already does.
 * A wrapper costs one `.data` and can never collide.
 *
 * DECLARED HERE RATHER THAN IN WP-1's FILES, AND SAID OUT LOUD: tech_spec ОВ-2
 * writes `Promise<Envelope<NarrativeDocumentContext>>` and annotates it
 * "Envelope = данные + IndexState (WP-1)", but no such type was ever declared —
 * `grep -rn "Envelope" packages/narrative-knowledge/src` returns nothing at
 * `408557c`. WP-4a is the first caller that needs it, so it is declared here
 * instead of being left as a comment that describes code nobody wrote.
 */

import type { IndexState } from './index-state';

/** A read result and the index state it was produced under. */
export interface Envelope<T> {
  state: IndexState;
  data: T;
}

/** Pair a value with a state. Trivial, and worth having so that no call site
 *  has to remember the field names. */
export function envelope<T>(state: IndexState, data: T): Envelope<T> {
  return { state, data };
}
