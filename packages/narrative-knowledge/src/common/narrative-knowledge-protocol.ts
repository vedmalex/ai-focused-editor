/**
 * RPC contract of the narrative knowledge service (TASK-022 WP-0).
 *
 * Deliberately free of Theia imports, even the ones prohibition (c) would
 * allow: the whole protocol is a symbol, a path string and structural types,
 * so `src/common` stays runnable under plain `bun test` with nothing resolved
 * from a frontend or a backend.
 *
 * WP-0 ships ONE method. `getIndexStatus()` is the round-trip probe: it is the
 * smallest call that proves the frontend proxy reaches the node implementation
 * over RPC in BOTH the browser and the electron target. The reading methods
 * (`getContextForDocument`, the entity/mention/relation queries) and
 * `configure` arrive in WP-4a/WP-4b/WP-3.
 */

import type { IndexState } from './index-state';

/** DI symbol of the service. Bound to the node implementation on the backend
 *  and to the RPC proxy on the frontend. */
export const NarrativeKnowledgeService = Symbol('NarrativeKnowledgeService');

/** RPC path the backend exposes the service on, and the frontend proxies. */
export const NarrativeKnowledgeServicePath = '/services/ai-focused-editor/narrative-knowledge';

export interface NarrativeKnowledgeService {
  /**
   * Current state of the narrative index.
   *
   * Every reading method added later returns its data TOGETHER WITH this
   * envelope (plan WP-1); this method is the degenerate case that returns the
   * envelope alone. It never rejects: a backend that cannot determine a state
   * reports one, it does not throw across the RPC boundary.
   */
  getIndexStatus(): Promise<IndexState>;
}
