/**
 * DI-facing counterpart of `NarrativeKnowledgeServiceClient`
 * (`narrative-knowledge-protocol.ts`), TASK-022 UR-043.
 *
 * WHY THIS IS A SEPARATE FILE, NOT PART OF THE PROTOCOL. The protocol file
 * says of itself: "Deliberately free of Theia imports, even the ones
 * prohibition (c) would allow". `Event<T>` is exactly such an allowed-but-
 * declined import — prohibition (c) permits `@theia/core/lib/common` in
 * `src/common` outside `graph/`, but the protocol file's own stated goal is
 * running under plain `bun test` with NOTHING resolved from a frontend or a
 * backend, and this type only exists to be resolved by one. Splitting it out
 * keeps that promise intact instead of quietly narrowing it.
 *
 * WHY THE SYMBOL LIVES IN `src/common` AT ALL, RATHER THAN NEXT TO ITS ONLY
 * IMPLEMENTATION IN `src/browser`. `NarrativeMapWidget` and `EntityCardsWidget`
 * — the two consumers UR-043 names — live in `@ai-focused-editor/manuscript-
 * workspace`, a DIFFERENT package. That package already reaches
 * `NarrativeKnowledgeService` itself (`entity-cards-widget.ts`) by importing
 * the SYMBOL from this package's `src/common` barrel and injecting it,
 * without ever importing the browser proxy that answers it — the concrete
 * binding lives in `narrative-knowledge-frontend-module.ts` and the consumer
 * never sees it. This symbol follows the identical shape for the identical
 * reason: one DI token in `common`, one binding in `browser`, zero new
 * cross-package coupling beyond the one AD-1 already allows (manuscript-
 * workspace importing FROM narrative-knowledge's `src/common`).
 */

import type { Event } from '@theia/core/lib/common';
import type { NarrativeIndexChangedEvent } from './narrative-knowledge-protocol';

/** DI symbol AND interface (the same pairing `NarrativeKnowledgeService`
 *  itself uses) for the frontend-side sink of {@link NarrativeIndexChangedEvent}.
 *  Bound to `BrowserNarrativeIndexChangeWatcher` in
 *  `narrative-knowledge-frontend-module.ts`. */
export const NarrativeIndexChangeWatcher = Symbol('NarrativeIndexChangeWatcher');

export interface NarrativeIndexChangeWatcher {
  /**
   * Fires once per debounced push from the backend — see
   * `INDEX_CHANGE_NOTIFICATION_DEBOUNCE_MS` (`narrative-index-maintainer.ts`)
   * for the window and why it exists.
   *
   * NOT FILTERED BY ROOT HERE: this object carries events for every
   * workspace root the backend has ever pushed for, on the single shared RPC
   * connection. A consumer compares `event.rootUri` to its OWN cached
   * workspace root string before reacting — the same thing
   * `GitWatcher.onGitEvent` leaves to each of ITS consumers, and for the same
   * reason: one connection, potentially several repositories/roots watched
   * over its life.
   */
  readonly onDidIndexChange: Event<NarrativeIndexChangedEvent>;
}
