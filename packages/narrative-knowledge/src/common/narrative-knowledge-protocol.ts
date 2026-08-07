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
  DuplicateEntityRecord,
  EntityQuery,
  EventQuery,
  IndexedDocument,
  IndexedEvent,
  MentionDocumentCount,
  MentionOrderExclusion,
  MentionQuery,
  NarrativeEntity,
  NarrativeMention,
  NarrativeRelation,
  RelationQuery
} from './graph';
import type { EffectiveEntityType, EntityTypeProblem } from './entity-type-registry';
import type { ManuscriptManifest } from './extraction';
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

/**
 * Why an appearance carries no quoted text (gh#47, architecture §5.4).
 *
 * DECLARED HERE RATHER THAN BESIDE THE READER because the reader lives in
 * `node/` and this crosses the RPC boundary: `common/` may not import from
 * `node/`, and a consumer rendering the absence has to name the reason.
 *
 * ABSENCE IS ALWAYS EXPLAINED. "Here is the passage" and "the file changed since
 * indexing, so the passage cannot be located" are different claims to the author,
 * and only one of them is true at a time. A missing excerpt with no reason would
 * be rendered as an empty quotation, which reads as "nothing was written there".
 */
export type ExcerptUnavailableReason = 'document-changed' | 'no-position' | 'unreadable';

/**
 * One place an entity appears, ready to render (gh#47).
 *
 * A PROJECTION OF `NarrativeMention`, NOT A REPLACEMENT: the mention is carried
 * whole, so nothing about evidence or resolution is lost in translation, and the
 * fields beside it are the ones a card needs and a mention does not know —
 * the containing chapter's manifest title, its place in the built book, and the
 * quotation.
 */
export interface EntityAppearance {
  mention: NarrativeMention;
  /** Manifest title of the containing document; absent when the manifest does
   *  not name the file. Absent is not `''` — see `IndexedDocumentInput.title`. */
  chapterTitle?: string;
  /** Position in the built book; absent for a file the manifest does not list. */
  chapterOrder?: number;
  /** Present when this appearance has no place in manuscript order. Consumers
   *  must not present such an appearance as a first or latest one. */
  orderExclusion?: MentionOrderExclusion;
  /** The quoted passage, present only when it is provably the indexed text. */
  excerpt?: string;
  /** Present exactly when {@link excerpt} is absent AND excerpts were asked for. */
  excerptUnavailable?: ExcerptUnavailableReason;
}

/**
 * Everything the card asks about one entity's presence in the manuscript.
 *
 * ONE RESULT RATHER THAN TWO METHODS, AND THE REASON IS GENERATION CONSISTENCY,
 * not round-trip count. The appearance list and the per-chapter spread are two
 * views of the same rows; fetched by two calls they could straddle a rebuild and
 * disagree — a card stating "first seen in chapter 2" beside "mentioned in 5
 * chapters" computed from a different generation. TASK-022 already learned this
 * on the diagnostics path, where three envelopes must carry an equal
 * `generation` or the pass is abandoned. One envelope makes the question moot.
 */
export interface EntityAppearanceResult {
  /** In the requested order, capped by `limit`. */
  appearances: EntityAppearance[];
  /**
   * The FIRST appearance in the built book, when one was asked for.
   *
   * IN THIS RESULT RATHER THAN A SECOND CALL, and the reason is the same rule
   * this type states: a card shows "first seen in chapter 2" beside "last seen
   * in chapter 9", and two calls can straddle a rebuild and disagree. The first
   * edition of the card did exactly that — an ascending call for the first and a
   * descending one for the latest — which satisfied the rule's letter for the
   * spread and broke it for the pair of values the headline is made of.
   *
   * ABSENT when nothing placeable exists: an entity seen only in chapters
   * outside the built book HAS appearances and has no first appearance.
   */
  first?: EntityAppearance;
  /**
   * Every document holding a mention, in ascending book order, with counts.
   *
   * PRESENT ONLY WHEN ASKED FOR: unlike {@link appearances} it is never capped,
   * so a caller wanting one first appearance should not pay for a hub
   * character's whole spread.
   */
  spread?: MentionDocumentCount[];
}

/** Filter for {@link NarrativeKnowledgeService.getEntityAppearances}. */
export interface EntityAppearanceQuery {
  /** Also return the per-document spread — see {@link EntityAppearanceResult.spread}. */
  withSpread?: boolean;
  /** Also return the first appearance in the built book, from THIS envelope —
   *  see {@link EntityAppearanceResult.first}. */
  withFirst?: boolean;
  /** `asc` for first appearances, `desc` for the most recent. Default `asc`. */
  direction?: 'asc' | 'desc';
  /** Hard cap, applied after ordering. */
  limit?: number;
  /**
   * Read the quoted passage for each returned appearance.
   *
   * OPT-IN, because it costs ONE FILE READ PER DISTINCT DOCUMENT: a card asking
   * for a first appearance and a latest one wants two quotations, while a caller
   * counting appearances wants none. Defaults to `false` so the expensive answer
   * is the one that was asked for.
   */
  withExcerpt?: boolean;
}

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
   * Events, in the order asked for (gh#48).
   *
   * ON THIS SERVICE AND NOT A SECOND ONE. `StoryTimelineService` from the issue
   * text was rejected by gh#48's own plan (П-9) and by architecture §3.1: a
   * second knowledge seam is a second freshness history, a second envelope and a
   * second chance to lie about staleness. Events are a new kind of data in one
   * index, not a new index.
   *
   * `orderBy` IS REQUIRED. There are two orders and they answer different
   * questions — story order is `sequence`, manuscript order is the chapter's
   * place in the built book — and a flashback separates them. A default would
   * let a panel render one of them and look authoritative about the other.
   *
   * EVENTS THAT CANNOT BE PLACED ARE RETURNED, NOT DROPPED, carrying
   * `orderExclusion` and trailing the ordered ones in BOTH directions. The
   * reason is per ORDER: an event with a `sequence` and no chapter is placeable
   * in story order and not in manuscript order, so the exclusion belongs to the
   * query rather than to the event.
   */
  listEvents(rootUri: string, query: EventQuery): Promise<Envelope<IndexedEvent[]>>;

  /** One event by id (gh#48). `undefined` data under a `ready` envelope means
   *  the manuscript defines no such event — not that the index is unsure. */
  getEvent(rootUri: string, eventId: string): Promise<Envelope<IndexedEvent | undefined>>;

  /**
   * Where an entity appears, in manuscript order, optionally quoted (gh#47).
   *
   * WHY THIS IS A METHOD AND NOT A COMPOSITION ON THE CALLER'S SIDE — the rule
   * architecture §3.1 sets is that a new RPC needs a written justification, so
   * here it is. Building this outside would take three round trips (mentions,
   * documents, manifest) and would still not reach the quotation, which requires
   * reading manuscript files — something a widget is forbidden to do. The
   * ordering itself is a store concern (`MentionQuery.orderBy`), and the excerpt
   * is a `node/` concern (§5.4); this method is the seam where they meet.
   *
   * THE QUOTATION IS NEVER CONFIDENTLY WRONG. An appearance whose document has
   * changed since indexing comes back with `excerptUnavailable:
   * 'document-changed'` and NO text — not with text read from a range that has
   * since shifted. Consumers must render the reason rather than an empty quote,
   * and must degrade navigation for such an appearance instead of jumping to a
   * stale range.
   *
   * APPEARANCES THAT CANNOT BE PLACED ARE RETURNED, NOT DROPPED, carrying
   * `orderExclusion`; they trail the ordered ones in BOTH directions, so neither
   * end of the list can be an unplaceable appearance. See `MentionOrderExclusion`.
   */
  getEntityAppearances(
    rootUri: string,
    entityId: string,
    query?: EntityAppearanceQuery
  ): Promise<Envelope<EntityAppearanceResult>>;

  /**
   * Every entity id currently claimed by more than one card (TASK-022 WP-5,
   * ISS-353).
   *
   * READ DIRECTLY FROM THE STORE, NOT FROM A REBUILD REPORT — and cheaper than
   * the pattern this mirrors ({@link getEntityTypeRegistry}), which re-reads a
   * YAML file from disk. `NarrativeIndexSession.getDuplicateEntities` already
   * exists and answers from the index the way {@link getMentions} and
   * {@link getRelations} do; before this method the ONLY way to see a
   * `DuplicateEntityRecord` was `rebuild()`'s report, which collapses every
   * collision into a bare count (`NarrativeRebuildReport.duplicateEntities`) —
   * enough to say a collision exists, never enough to say WHERE. This method is
   * a one-line delegation to the session, added so a consumer that needs the
   * per-collision detail is not forced to pay for a full, write-guarded rebuild
   * to get it.
   */
  getDuplicateEntities(rootUri: string): Promise<Envelope<DuplicateEntityRecord[]>>;

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
   * `manifest.yaml`, read directly and without a rebuild (TASK-022 WP-7,
   * tech_spec TECH_SPEC WP-7 §7, obstacle 1).
   *
   * WHY THIS EXISTS ALONGSIDE `listDocuments`. `IndexedDocument.manifestIncluded`
   * answers "does the manifest LIST this file", never "is it part of the BUILT
   * book" — that second, INHERITED question (`include: false` on a parent
   * excludes every descendant) only {@link ManifestChapter.buildIncluded} can
   * answer, and it requires the full manifest walk `listDocuments` does not do.
   * The same walk is also the only way to learn that the manifest names a
   * chapter no document row exists for at all: `listDocuments` can only be
   * silent about a path it never scanned. A caller that has both this method's
   * `chapters` and `listDocuments`' rows can therefore compute BOTH `Skipping
   * missing chapter file: …` (present here, absent there) AND `buildIncluded`
   * (present here, unavailable there) without a third protocol method.
   *
   * `present: false` (no `manifest.yaml` at all) is not an error — same rule as
   * {@link getEntityTypeRegistry} for a missing `entities/types.yaml` — and
   * `problems` reports only a MALFORMED manifest, exactly what
   * `NarrativeRebuildReport.problems.manifest` would report from a full rebuild,
   * read here without paying for one.
   */
  getManifestChapters(rootUri: string): Promise<Envelope<ManuscriptManifest>>;

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
   * "Check for Changes Now" (TASK-022 UR-036 part 1, UR-037): a cheap,
   * ON-DEMAND sweep over the whole workspace, for the reader who wants a
   * predictable "check now" lever rather than trusting the watcher alone.
   *
   * NOT `rebuild()` UNDER A DIFFERENT NAME. `rebuild()` drops the index and
   * re-extracts every file from nothing; this reuses the SAME `prefiltered`
   * sweep the fallback timer already runs (`NarrativeIndexMaintainer.sweep`),
   * which `stat()`s everything and reads only what the `(size, mtime)`
   * prefilter says might have moved. `rootUri`, not `uri`, because a sweep is
   * whole-workspace by nature — there is no single document to name.
   *
   * MUST STAY CALLABLE UNDER A FOREIGN LOCK. tech_spec ОВ-4 refuses `rebuild()`
   * outright whenever another live process owns the writer role, because a
   * rebuild's first act is to drop the store; a sweep that finds nothing to
   * write never opens a transaction at all (ОВ-4's "пустой проход бесплатен"),
   * so it succeeds read-only exactly like every other read method here. It
   * REJECTS only if the sweep actually finds a change and the write is refused
   * — the same ownership refusal `rebuild()` reports, surfaced here instead of
   * hidden, because a caller that asked to check and got silence would not
   * know whether nothing changed or nothing could be written.
   *
   * GOES THROUGH THE SAME GUARD as the watcher, `updateDocument` and the
   * explicit rebuild — one queue, one writer at a time, no exception.
   */
  checkForChanges(rootUri: string): Promise<Envelope<NarrativeUpdateReport>>;

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

/**
 * Pushed to every connected frontend when a workspace's index generation
 * advances (TASK-022 UR-043).
 *
 * `generation` IS THE SAME COUNTER `IndexState.generation` ALREADY CARRIES —
 * no new concept, just the existing one delivered instead of polled.
 * `rootUri` is the SAME STRING a caller passes as this protocol's own
 * `rootUri` parameter (`workspaceService.tryGetRoots()[0].resource.toString()`
 * in every existing consumer): a frontend matches it against its own cached
 * workspace root by plain equality, no canonicalisation on this side of the
 * RPC boundary — see `NodeNarrativeKnowledgeService`'s doc for how the
 * backend recovers that exact string from a workspace root that is stored
 * internally as a canonical filesystem path.
 *
 * DEBOUNCED, NOT ONE-PUSH-PER-COMMIT. See
 * `INDEX_CHANGE_NOTIFICATION_DEBOUNCE_MS` (`narrative-index-maintainer.ts`)
 * for where the coalescing happens and why: a full rebuild commits many
 * transactions in one drain-to-empty cycle, and UR-043's own boundary forbids
 * redrawing a panel once per commit.
 */
export interface NarrativeIndexChangedEvent {
  readonly rootUri: string;
  readonly generation: number;
}

/**
 * Client side of {@link NarrativeKnowledgeService} (TASK-022 UR-043): the one
 * push a frontend needs to stop polling and redraw itself instead.
 *
 * DELIBERATELY NOT A METHOD ON `NarrativeKnowledgeService` ITSELF. That
 * interface is implemented BOTH by the frontend RPC proxy (a plain method call
 * becomes a request) AND by the backend (`NodeNarrativeKnowledgeService`);
 * neither shape can carry a live `Event<T>` PROPERTY across the RPC boundary —
 * the proxy factory turns every property access into a remote method call, so
 * an `Event`-typed field on the shared interface would silently break rather
 * than push anything. Every other server→client push in this codebase
 * (`GitWatcherClient.onGitChanged`, `FileSystemWatcherClient.onDidFilesChanged`)
 * uses the same separate-client-interface shape, for the identical reason.
 */
export interface NarrativeKnowledgeServiceClient {
  onIndexChanged(event: NarrativeIndexChangedEvent): void;
}
