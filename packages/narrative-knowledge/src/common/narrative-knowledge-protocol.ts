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
 * adds the reading surface and the full rebuild; `updateDocument` and
 * `configure` arrive in WP-4b.
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
}
