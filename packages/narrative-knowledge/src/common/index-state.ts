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
 * SCOPE — WP-0 MINIMUM. WP-0 needs exactly as much of the envelope as
 * `getIndexStatus()` can honestly return before any indexing exists. The full
 * envelope is WP-1's deliverable and adds the two branches deliberately absent
 * here:
 *   - `failed`, carrying `IndexFailureReason` (tech_spec ОВ-8);
 *   - `stale`, carrying `staleReason` + `staleSince` (tech_spec ОВ-6 — the
 *     single printed edition of that branch).
 * Both are additive union members; nothing declared here changes when they
 * arrive. The branches are NOT stubbed with a guessed shape on purpose: a
 * second, diverging edition of a type whose canonical form lives elsewhere is
 * the exact defect the plan spent four gate rounds removing.
 */

/**
 * Why the index holds no data.
 *
 * - `no-manuscript` — the workspace is not a manuscript, so there is nothing
 *   to index. Not an error, and consumers must not present it as one.
 * - `not-built`     — a manuscript exists but the index has never been built.
 */
export type IndexAbsentCause = 'no-manuscript' | 'not-built';

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
  | { state: 'absent'; generation: number; cause: IndexAbsentCause };

/** The state of an index that has never been built in a manuscript workspace. */
export const NOT_BUILT_INDEX_STATE: IndexState = {
  state: 'absent',
  generation: 0,
  cause: 'not-built'
};
