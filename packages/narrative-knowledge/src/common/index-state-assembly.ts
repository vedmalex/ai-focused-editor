/**
 * Assembling `IndexState` from the store's lifecycle PRIMITIVES (TASK-022
 * WP-4a; the assignment is plan WP-1 / WP-3 F-TS3-4 and tech_spec ОВ-1
 * "Поверхность порта").
 *
 * WHY THIS FUNCTION EXISTS AT ALL, AND WHY IT IS HERE. `NarrativeIndexStore`
 * lives inside `src/common/graph/`, where prohibition (e) half 2 forbids
 * importing anything from `src/common` above it — and `IndexState` is exactly
 * such a neighbour. So the port returns four primitives (`generation`,
 * `readOnly`, `corrupted`, `foreignWriter`) and the envelope is built OUT here.
 * That is not bookkeeping: the rejecting case for prohibition (e) half 2 IS an
 * import of `IndexState` into `graph/`, so a `getState(): IndexState` on the
 * port would make the layer test fail on its own rejecting case, and the
 * cheapest repair would dissolve the separation the test exists to protect.
 *
 * WHICH `generation` THIS SURFACES — A DECISION, RECORDED (see the type note in
 * `index-state.ts`). It is the store's WRITE counter: the number advanced by
 * the compare-and-set on every committed write transaction (tech_spec ОВ-4).
 * It is NOT a count of completed rebuilds, and it is NOT `document.generation`.
 */

import type { IndexAbsentCause, IndexStaleReason, IndexState } from './index-state';
import type { IndexFailureReason } from './index-failure';
import type { NarrativeIndexStoreLifecycle } from './graph';

/** What the service knows that the store cannot. */
export interface IndexStateFacts {
  /** The four primitives, straight from {@link NarrativeIndexStore.lifecycle}. */
  lifecycle: NarrativeIndexStoreLifecycle;
  /** Set while a rebuild transaction is in flight. */
  rebuilding?: boolean;
  /** Present when recovery refused. Outranks everything else. */
  failure?: IndexFailureReason;
  /**
   * Present when there is no data to speak of, and WHY.
   *
   * `no-manuscript` can only come from here: it is decided BEFORE a store is
   * opened (a workspace with no `manifest.yaml` must not even get a database
   * file), so no lifecycle primitive could ever carry it.
   */
  absent?: IndexAbsentCause;
  /**
   * A staleness the SERVICE knows about — `watcher-lost` or
   * `partial-update-failed`. The third reason, `foreign-writer`, is derived
   * from the lifecycle instead, because only the store can observe it.
   */
  stale?: { reason: Exclude<IndexStaleReason, 'foreign-writer'>; since: number };
  /**
   * Epoch ms at which this instance was first seen to be read-only.
   *
   * REMEMBERED BY THE CALLER, not defaulted to "now" here: `staleSince` that
   * moves every time a consumer polls is not a timestamp, it is noise, and a UI
   * showing "stale for 0 seconds" forever is worse than showing nothing.
   *
   * ABSENT yields `staleSince: 0`, which reads as "the moment was not
   * recorded" — an epoch nobody can mistake for a real one.
   * {@link NarrativeIndexSession} always records it.
   */
  readOnlySince?: number;
}

/**
 * Build the envelope.
 *
 * PRECEDENCE, AND THE REASON FOR EACH STEP DOWN:
 *
 *   1. `failed`  — recovery refused. Nothing below is worth saying; a consumer
 *                  told "stale" about a broken index will wait for a refresh
 *                  that is never coming.
 *   2. `absent`  — there is no data. Distinguishing `no-manuscript` from
 *                  `not-built` is what stops a text editor opened on a photo
 *                  folder from reporting a problem.
 *   3. `rebuilding` — work is in progress, so an empty answer is temporary.
 *   4. `stale`   — data exists and was right; freshness is no longer promised.
 *   5. `ready`.
 *
 * `not-built` IS DERIVED FROM `generation === 0` RATHER THAN REMEMBERED. A
 * database that has never committed a write transaction has generation zero by
 * construction, and that is precisely "nothing has ever been indexed here" —
 * including after corruption recovery, which rebuilds an empty file. Deriving
 * it means the answer survives a backend restart, which a session flag would
 * not, and it is why `corrupted` needs no branch of its own: a store that
 * recovered is an empty store, and an empty store is `absent/not-built` until
 * something is written to it.
 *
 * `readOnly` — NOT `foreignWriter` — SELECTS THE STALE BRANCH, and the
 * difference is load-bearing. ОВ-6 defines `foreign-writer` as "this process
 * does not hold the writer lock and is running read-only", which is what
 * `readOnly` says. In the SQLite adapter the two always agree (both the
 * lock-lost path and the compare-and-set-lost path set both). In the in-memory
 * adapter `readOnly` is a constructor switch and `foreignWriter` is honestly
 * `false`, because nothing in memory has a foreign writer — so keying on
 * `foreignWriter` would make a read-only store report `ready` in the fast lane,
 * and the contract case for "not ready" would be green against a lie.
 */
export function assembleIndexState(facts: IndexStateFacts): IndexState {
  const generation = facts.lifecycle.generation;

  if (facts.failure !== undefined) {
    return { state: 'failed', generation, reason: facts.failure };
  }
  if (facts.absent !== undefined) {
    return { state: 'absent', generation, cause: facts.absent };
  }
  // ABOVE the `generation === 0` derivation, not below it: the FIRST build of a
  // workspace runs at generation zero, and a consumer told `absent` while a
  // rebuild is in flight will render "there is no index" for the whole of it.
  if (facts.rebuilding === true) {
    return { state: 'rebuilding', generation };
  }
  // ABOVE `stale`, and that ordering is a claim: `stale` means "data exists and
  // was right", which an index that has never been written does not have.
  if (generation === 0) {
    return { state: 'absent', generation, cause: 'not-built' };
  }
  if (facts.lifecycle.readOnly) {
    return {
      state: 'stale',
      generation,
      staleReason: 'foreign-writer',
      staleSince: facts.readOnlySince ?? 0
    };
  }
  if (facts.stale !== undefined) {
    return {
      state: 'stale',
      generation,
      staleReason: facts.stale.reason,
      staleSince: facts.stale.since
    };
  }
  return { state: 'ready', generation };
}
