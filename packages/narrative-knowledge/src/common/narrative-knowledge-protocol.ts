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
  IndexedDocument,
  MentionQuery,
  NarrativeEntity,
  NarrativeMention,
  NarrativeRelation,
  RelationQuery
} from './graph';
import type { EffectiveEntityType, EntityTypeProblem } from './entity-type-registry';
import type { IndexState } from './index-state';
import type { Envelope } from './narrative-envelope';
import type { NarrativeContextOptions, NarrativeDocumentContext } from './narrative-context';
import type { NarrativeRebuildReport } from './narrative-index-session';
import type { NarrativeUpdateReport } from './narrative-index-update';
import type { ConfigureResult, NarrativeMemoryConfigPatch } from './narrative-memory-configure';

/**
 * One document, as a consumer outside this package may see it (TASK-022 WP-7).
 *
 * `docId`/`generation` ARE NOT HERE, on purpose: `IndexedDocument` (the store's
 * own row shape, `graph/narrative-index-store.ts`) says explicitly that both
 * are internal and appear in no RPC result. This type is that same row with
 * exactly those two fields removed — nothing else narrows, nothing renames.
 */
export type NarrativeDocumentSummary = Omit<IndexedDocument, 'docId' | 'generation'>;

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
   * Every document the index holds for `rootUri`, code point ascending by
   * `relPath` (TASK-022 WP-7).
   *
   * Added for consumers that need a whole-workspace document listing without
   * paying for a rebuild — the timeline a narrative map draws, in particular,
   * which needs chapter titles and manifest order independent of any single
   * entity or relation. `docId`/`generation` are stripped at this boundary
   * (see {@link NarrativeDocumentSummary}); nothing else about the row changes.
   */
  listDocuments(rootUri: string): Promise<Envelope<NarrativeDocumentSummary[]>>;

  /**
   * The effective entity-type registry and its validation problems, read
   * WITHOUT a rebuild (TASK-022 WP-7, tech_spec TECH_SPEC WP-7 §2).
   *
   * Before this method the ONLY way to see `EntityTypeProblem[]` was
   * `rebuild()`'s report — a full, write-guarded pass. Both migrated
   * consumers that need the registry (Entity Cards' thin adapter, Book
   * Doctor) need it cheaply and often, so this method reads `entities/types.yaml`
   * the same way extraction does, with no effect on the store.
   */
  getEntityTypeRegistry(
    rootUri: string
  ): Promise<Envelope<{ types: EffectiveEntityType[]; problems: EntityTypeProblem[] }>>;

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

  /**
   * Whether a manual Rebuild would be refused right now, and why (WP-5, ОВ-4).
   *
   * A SEPARATE QUESTION FROM `getIndexStatus()`, ASKED SEPARATELY. tech_spec
   * ОВ-4 restates the refusal BY OWNERSHIP rather than by state — "Rebuild Index
   * ОТКЛОНЯЕТСЯ всегда, пока в `meta` виден ЖИВОЙ чужой замок писателя,
   * НЕЗАВИСИМО от того, какое состояние это породило" — after the state-keyed
   * formulation contradicted itself once. Folding the answer into `IndexState`
   * would put the contradiction back, because a `failed` index whose foreign
   * lock is still beating and a `failed` index whose lock expired are the SAME
   * state and must get different answers. So does a `stale/foreign-writer`
   * index whose owner has since exited.
   *
   * ANSWERED AT CALL TIME, from the database file, never from a cached state:
   * the lock may have expired while a human was reading the status bar. The
   * frontend uses it for the enabled/disabled affordance and asks again before
   * actually rebuilding; the authoritative refusal still lives in the store.
   */
  getRebuildAvailability(rootUri: string): Promise<RebuildAvailability>;
}

/** Why a manual Rebuild is refused. Ownership is the only reason there is —
 *  every other cause of "you cannot rebuild now" is visible in `IndexState`. */
export type RebuildRefusalReason = 'foreign-writer';

export interface RebuildAvailability {
  readonly available: boolean;
  /** Present exactly when `available` is false. */
  readonly reason?: RebuildRefusalReason;
}
