/**
 * Index lifecycle state (`IndexState`) — a SERVICE-lifecycle type, and
 * therefore deliberately OUTSIDE `src/common/graph/`.
 *
 * The layer rule (plan.md, "Слои пакета и правило импортов") splits the two
 * kinds of type: the domain of the graph (entities, mentions, relations,
 * evidence, the store port) lives INSIDE `graph/`; the lifecycle of the
 * service that maintains the index (`IndexState`, `IndexFailureReason`,
 * `NarrativeMemoryConfig`, the watcher port) lives OUT here, and the core does
 * NOT see it. That split is what makes prohibition (e) half 2 checkable at
 * all: an import of `IndexState` INTO `graph/` is the rejecting case for the
 * inward half of the boundary.
 *
 * SCOPE — COMPLETED IN WP-1. WP-0 shipped only the three branches
 * `getIndexStatus()` could honestly return before any indexing existed, and
 * deliberately left `failed` and `stale` unstubbed rather than guess their
 * shape. Both arrive here, taken from their single printed editions:
 *   - `failed`, carrying `IndexFailureReason` (tech_spec ОВ-8);
 *   - `stale`, carrying `staleReason` + `staleSince` (tech_spec ОВ-6).
 * Both are purely additive; nothing WP-0 declared changed.
 */

import type { IndexFailureReason } from './index-failure';

/**
 * Why the index holds no data.
 *
 * - `no-manuscript` — the workspace is not a manuscript, so there is nothing
 *   to index. Not an error, and consumers must not present it as one.
 * - `not-built`     — a manuscript exists but the index has never been built.
 */
export type IndexAbsentCause = 'no-manuscript' | 'not-built';

/** Every member of {@link IndexAbsentCause}, as data. */
export const INDEX_ABSENT_CAUSES = ['no-manuscript', 'not-built'] as const satisfies readonly IndexAbsentCause[];

/**
 * Why an otherwise usable index can no longer promise freshness.
 *
 * `stale` means: the index is internally consistent and fit to answer with, but
 * THIS store instance KNOWS its contents may no longer match the files, and it
 * will not fix that by itself. The neighbouring members are sharply different —
 * `rebuilding` means work is IN PROGRESS, `failed` means recovery REFUSED,
 * `absent` means there is no data at all.
 *
 * THE LIST IS CLOSED, and closing it is the decision. An open `stale` becomes
 * the bin for everything inconvenient to classify, and in half a year it means
 * "something is wrong". A fourth candidate is either `rebuilding` or `failed`.
 */
export type IndexStaleReason =
  /** This process does not hold the writer lock and is running read-only. */
  | 'foreign-writer'
  /** The file watcher died, or never started. Changes are arriving unseen. */
  | 'watcher-lost'
  /** One document failed to update incrementally; the rest of the index is intact. */
  | 'partial-update-failed';

/** Every member of {@link IndexStaleReason}, as data. */
export const INDEX_STALE_REASONS = [
  'foreign-writer',
  'watcher-lost',
  'partial-update-failed'
] as const satisfies readonly IndexStaleReason[];

/**
 * State of the narrative index, as reported to every consumer alongside the
 * data it asks for.
 *
 * `generation` increments on each completed rebuild, so a consumer can tell a
 * stale answer from a fresh one without comparing payloads. It is present on
 * EVERY branch: an empty answer during a rebuild must be distinguishable from
 * an empty answer meaning "there is no such thing", which is the whole reason
 * this envelope exists.
 */
export type IndexState =
  | { state: 'ready' | 'rebuilding'; generation: number }
  | { state: 'absent'; generation: number; cause: IndexAbsentCause }
  /**
   * Something went hard wrong and recovery refused.
   *
   * This branch is not decoration. Without it a hard failure collapses into
   * `absent`, and every consumer then says "there is no index" where the honest
   * answer is "the index is broken, here is why": the status bar shows an error
   * tone rather than emptiness, the AI tools say "broken, reason X" rather than
   * returning nothing, diagnostics are NOT published, and `getIndexStatus()`
   * hands back the whole {@link IndexFailureReason}.
   */
  | { state: 'failed'; generation: number; reason: IndexFailureReason }
  /**
   * Usable, but no longer guaranteed to match the files.
   *
   * Consumers answer WITH A MARK rather than refusing: a watcher failure can
   * last a whole session, so refusing makes the feature useless, and answering
   * silently makes it a liar. Already-published diagnostics are KEPT and new
   * ones are NOT published — withdrawing them would hide real broken links,
   * adding them would invent new ones from possibly stale data.
   */
  | {
      state: 'stale';
      generation: number;
      staleReason: IndexStaleReason;
      /** Epoch milliseconds at which freshness stopped being guaranteed. */
      staleSince: number;
    };

/** The state of an index that has never been built in a manuscript workspace. */
export const NOT_BUILT_INDEX_STATE: IndexState = {
  state: 'absent',
  generation: 0,
  cause: 'not-built'
};
