/**
 * RPC contract of the narrative knowledge service (TASK-022 WP-0, extended by
 * WP-4a).
 *
 * Deliberately free of Theia imports, even the ones prohibition (c) would
 * allow: the whole protocol is a symbol, a path string and structural types,
 * so `src/common` stays runnable under plain `bun test` with nothing resolved
 * from a frontend or a backend.
 *
 * WP-0 shipped ONE method — `getIndexStatus()`, the round-trip probe. WP-4a
 * added the reading surface and the full rebuild. WP-4b completes it with
 * `updateDocument` and `configure`.
 *
 * EVERY READING METHOD RETURNS AN `Envelope`, never a bare payload (plan WP-1).
 * An empty list on its own cannot distinguish "there is no such relation" from
 * "the index is being rebuilt" from "the index is broken", and a consumer that
 * cannot tell them apart will present a rebuild as an authoritative absence.
 *
 * EVERY METHOD BUT ONE TAKES `rootUri`, because one backend serves N
 * workspaces: every existing narrative backend method already does the same
 * (`node-narrative-graph-service.ts:64-82`), and tech_spec ОВ-4 Б keeps one
 * database per workspace root behind an LRU. The exception is
 * {@link NarrativeKnowledgeService.getContextForDocument}, whose signature
 * tech_spec ОВ-2 pins to `(uri, options?)`; it resolves the root by walking up
 * from the document to the nearest ancestor holding a `manifest.yaml`.
 */

import type {
  EntityQuery,
  MentionQuery,
  NarrativeEntity,
  NarrativeMention,
  NarrativeRelation,
  RelationQuery
} from './graph';
import type { IndexState } from './index-state';
import type { Envelope } from './narrative-envelope';
import type { NarrativeContextOptions, NarrativeDocumentContext } from './narrative-context';
import type { NarrativeRebuildReport } from './narrative-index-session';
import type { NarrativeUpdateReport } from './narrative-index-update';
import type { ConfigureResult, NarrativeMemoryConfigPatch } from './narrative-memory-configure';

/** DI symbol of the service. Bound to the node implementation on the backend
 *  and to the RPC proxy on the frontend. */
export const NarrativeKnowledgeService = Symbol('NarrativeKnowledgeService');

/** RPC path the backend exposes the service on, and the frontend proxies. */
export const NarrativeKnowledgeServicePath = '/services/ai-focused-editor/narrative-knowledge';

export interface NarrativeKnowledgeService {
  /**
   * Current state of the narrative index.
   *
   * `rootUri` is OPTIONAL, and its absence is the WP-0 round-trip probe's case:
   * a caller with no workspace in hand gets `absent`/`not-built` rather than a
   * rejection. Every other method requires one, because an answer without a
   * workspace would be an answer about nothing.
   *
   * It never rejects: a backend that cannot determine a state reports one, it
   * does not throw across the RPC boundary.
   */
  getIndexStatus(rootUri?: string): Promise<IndexState>;

  /**
   * Rebuild the whole index for `rootUri` from the files on disk.
   *
   * REJECTS rather than reporting an empty result when the rebuild is refused —
   * a live foreign writer owns the database, or this instance is read-only.
   * tech_spec ОВ-4's first invariant is that nothing is lost silently, and a
   * refusal reported as a report of zero is exactly a silent loss.
   */
  rebuild(rootUri: string): Promise<Envelope<NarrativeRebuildReport>>;

  getEntity(rootUri: string, entityId: string): Promise<Envelope<NarrativeEntity | undefined>>;
  findEntities(rootUri: string, query?: EntityQuery): Promise<Envelope<NarrativeEntity[]>>;
  getMentions(rootUri: string, query?: MentionQuery): Promise<Envelope<NarrativeMention[]>>;
  getRelations(rootUri: string, query?: RelationQuery): Promise<Envelope<NarrativeRelation[]>>;

  /**
   * Everything the index can say about one passage (tech_spec ОВ-2).
   *
   * `data: undefined` means THIS DOCUMENT IS NOT IN THE INDEX — a different
   * statement from every section being empty, and the honest answer for a file
   * that is not a chapter or lies outside the manuscript.
   */
  getContextForDocument(
    uri: string,
    options?: NarrativeContextOptions
  ): Promise<Envelope<NarrativeDocumentContext | undefined>>;

  /**
   * Re-index ONE document (TASK-022 WP-4b).
   *
   * `uri` AND NO `rootUri`, matching `getContextForDocument` and for the same
   * reason: the workspace is found by walking up to the nearest ancestor holding
   * a `manifest.yaml`, which is deterministic and needs no second parameter a
   * caller could get wrong.
   *
   * IT GOES THROUGH THE SAME WRITE GUARD as the watcher and the explicit
   * rebuild. A caller cannot use it to slip a write past a rebuild in flight,
   * and it may return `mode: 'rebuild'` — a change to an entity card, the
   * manifest or `types.yaml` shifts facts the whole workspace depends on, and
   * the escalation is reported rather than hidden.
   */
  updateDocument(uri: string): Promise<Envelope<NarrativeUpdateReport>>;

  /**
   * Change the live configuration (tech_spec ОВ-9б).
   *
   * RETURNS A RESULT, NEVER `void`. Without it a settings UI can prove it CALLED
   * this method and nothing else: not that the value was accepted, not that it
   * was refused as out of range or locked by a launch flag, not that it will
   * only take effect at the next start. Those three are different things and the
   * user has to be told which one happened.
   *
   * `rootUri` ABSENT MEANS GLOBAL — every open workspace and every future one.
   * Two windows on two manuscripts of very different sizes legitimately want
   * different debounce windows, and Theia settings can be workspace-scoped, so
   * the scope has to be expressible.
   *
   * NOT PERSISTED. The durable home for these values is Theia's own preference
   * storage, which re-sends them whenever a frontend connects. Persisting here
   * would create a sixth source that outlives the UI that set it and drifts
   * quietly away from it — the divergence this whole epic exists to remove.
   */
  configure(patch: NarrativeMemoryConfigPatch, rootUri?: string): Promise<ConfigureResult>;
}
