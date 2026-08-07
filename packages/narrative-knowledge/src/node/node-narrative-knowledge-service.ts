import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { inject, injectable } from '@theia/core/shared/inversify';
import { Emitter, type Event } from '@theia/core/lib/common';
import { FileUri } from '@theia/core/lib/common/file-uri';
import {
  InMemoryNarrativeIndexStore,
  NarrativeIndexMaintainer,
  NarrativeIndexSession,
  NarrativeMemoryConfigurator,
  NOT_BUILT_INDEX_STATE,
  envelope,
  extractManifestChapters,
  mentionOrderExclusion,
  resolveEffectiveEntityTypes,
  type ConfigureResult,
  type DuplicateEntityRecord,
  type EffectiveEntityType,
  type EntityAppearance,
  type EntityAppearanceQuery,
  type EntityAppearanceResult,
  type EntityQuery,
  type EntityTypeProblem,
  type Envelope,
  type EventQuery,
  type IndexState,
  type IndexedDocument,
  type IndexedEvent,
  type ManuscriptManifest,
  type MentionQuery,
  type NarrativeContextOptions,
  type NarrativeDocumentContext,
  type NarrativeDocumentSummary,
  type NarrativeEntity,
  type NarrativeFileWatcher,
  type NarrativeIndexChangedEvent,
  type NarrativeIndexStore,
  type NarrativeKnowledgeService,
  type NarrativeMemoryConfigPatch,
  type NarrativeMention,
  type NarrativeRebuildReport,
  type NarrativeRelation,
  type NarrativeUpdateReport,
  type RebuildAvailability,
  type RelationQuery
} from '../common';
import { NARRATIVE_INDEX_SCHEMA_VERSION } from './narrative-index-schema';
import { readVerifiedDocument, sliceExcerpt, type VerifiedDocument } from './evidence-excerpt';
import { NarrativeMemoryConfigResolver } from './narrative-memory-config-resolver';
import { NodeNarrativeWorkspaceSource } from './node-narrative-workspace-source';
import {
  NarrativeIndexStoreRegistry,
  canonicalWorkspaceKey,
  hasManuscriptManifest
} from './narrative-index-store-registry';

/**
 * Backend implementation of `NarrativeKnowledgeService` (TASK-022 WP-0,
 * completed for reading and full rebuild by WP-4a).
 *
 * IT IS A SHELL, AND THAT IS THE DESIGN. Everything WP-4a decides — which state
 * to report, what a query returns, what a passage's context is, what a rebuild
 * writes — lives in `NarrativeIndexSession` in `src/common`, where the same
 * code runs against the in-memory adapter under `bun` and against SQLite under
 * real `node`. What is left here is only what needs a disk or a container:
 * walking the workspace, canonicalizing roots, converting URIs, and holding one
 * session per open store.
 *
 * A WORKSPACE WITH NO `manifest.yaml` NEVER GETS A STORE. The manifest is
 * checked BEFORE the registry is asked for anything, so opening the editor on a
 * photo folder does not litter it with a database — and the answer is
 * `{state:'absent', cause:'no-manuscript'}`, which is an ANSWER, not a failure,
 * and consumers must not present it as one.
 */
@injectable()
export class NodeNarrativeKnowledgeService implements NarrativeKnowledgeService {
  @inject(NarrativeIndexStoreRegistry)
  protected readonly registry!: NarrativeIndexStoreRegistry;

  @inject(NarrativeMemoryConfigResolver)
  protected readonly resolver!: NarrativeMemoryConfigResolver;

  /** One session per canonical workspace root, alongside the registry's store.
   *  The session holds what the store cannot: whether a rebuild is in flight,
   *  the last hard failure, and when this instance first became read-only. */
  protected readonly sessions = new Map<string, NarrativeIndexSession>();

  /** One maintainer per root: the watcher subscription, the debounce window,
   *  the fallback sweep and THE SINGLE WRITE GUARD for that workspace. */
  protected readonly maintainers = new Map<string, NarrativeIndexMaintainer>();

  /**
   * The exact `rootUri` string a frontend last passed in, keyed by the
   * CANONICAL path {@link session} opens a store under (TASK-022 UR-043).
   *
   * WHY THIS EXISTS. `NarrativeIndexChangedEvent.rootUri` has to be a string a
   * frontend can compare against its own cached `workspaceService.tryGetRoots()
   * [0].resource.toString()` by PLAIN EQUALITY — the frontend has no `fs`
   * module to canonicalise anything with. Every RPC method here canonicalises
   * `rootUri` through {@link canonicalWorkspaceKey} BEFORE it ever reaches a
   * session or a maintainer, so neither holds the original string — this map
   * is the one place it survives.
   *
   * ONLY EVER SET FROM A `file:` URI, DELIBERATELY (see {@link session}).
   * `getContextForDocument`/`updateDocument` also call `session()`, but with
   * an ALREADY-CANONICAL root path found by walking up to a `manifest.yaml`
   * — recording that value here would overwrite a good `file://` string with
   * a bare filesystem path on the very next document edit, and every
   * `NarrativeIndexChangedEvent` after that would carry a `rootUri` no
   * frontend's cached string could ever equal.
   *
   * NOT PRUNED BY {@link reconcileMaintainers}. A root the LRU evicted and a
   * root that was never opened both answer with `?? rootPath` (the canonical
   * key) if pushed to before any `file:` call repopulates the entry — a
   * strictly worse but still HARMLESS answer (no consumer will ever have
   * cached that exact string as ITS workspace root, so the comparison simply
   * never matches, exactly as if no event had been sent). Pruning on eviction
   * would buy nothing a session reopen does not already fix on its own.
   */
  protected readonly originalRootUriByPath = new Map<string, string>();

  /**
   * Debounced "the index for this root changed" push (TASK-022 UR-043).
   *
   * FED BY EACH ROOT'S OWN {@link NarrativeIndexMaintainer}, which is where
   * the actual debounce/coalescing lives — see
   * `INDEX_CHANGE_NOTIFICATION_DEBOUNCE_MS` (`narrative-index-maintainer.ts`).
   * This emitter itself does no additional debouncing; it exists only to fan
   * one root's already-debounced signal out to every RPC connection currently
   * subscribed (`narrative-knowledge-backend-module.ts`), same as
   * `FileSystemWatcherServiceDispatcher` fans a filesystem event out to
   * several registered clients.
   */
  protected readonly onIndexChangedEmitter = new Emitter<NarrativeIndexChangedEvent>();

  /** Public surface of {@link onIndexChangedEmitter}. Subscribed to, once per
   *  RPC connection, in `narrative-knowledge-backend-module.ts` — NOT via
   *  `setClient`, because this service is bound in singleton scope and serves
   *  every connection with the SAME instance (UR-041 made that plural: one
   *  process can now serve more than one open window). `setClient` REPLACES
   *  the one client it remembers, which would silently stop pushing to every
   *  connection but the most recent; a plain `Event`, subscribed to per
   *  connection and disposed on that connection's close, has no such limit. */
  get onIndexChanged(): Event<NarrativeIndexChangedEvent> {
    return this.onIndexChangedEmitter.event;
  }

  /**
   * The `configure` handler, ONE PER PROCESS.
   *
   * Not per workspace, and that is tech_spec ОВ-9б tooth 6 in structural form: a
   * patch may arrive BEFORE the first store is ever opened — the first store
   * open happens on the first RPC call carrying a `rootUri`, not at boot — and a
   * handler owned by a store could not exist to receive it.
   *
   * Built lazily so it composes with the INJECTED resolver rather than a second
   * one; a field initializer would run before `@inject` had filled it in.
   */
  private configuratorInstance: NarrativeMemoryConfigurator | undefined;

  /**
   * The watcher factory.
   *
   * A SEAM, not a design flourish: the production implementation needs Theia's
   * `FileSystemWatcherService` and its dispatcher, which the backend module
   * supplies. Left unset the index still works — every write path goes through
   * the maintainer either way — it simply has no live events and depends on the
   * fallback sweep, which is exactly the behaviour a headless test wants.
   */
  createWatcher: ((rootPath: string) => NarrativeFileWatcher) | undefined;

  protected get configurator(): NarrativeMemoryConfigurator {
    if (this.configuratorInstance === undefined) {
      this.configuratorInstance = new NarrativeMemoryConfigurator(this.resolver);
    }
    return this.configuratorInstance;
  }

  async getIndexStatus(rootUri?: string): Promise<IndexState> {
    if (rootUri === undefined) {
      // The WP-0 round-trip probe's case: no workspace in hand. `not-built` is
      // the only honest answer — this service has built nothing for a workspace
      // nobody named.
      return NOT_BUILT_INDEX_STATE;
    }
    return this.session(rootUri).state();
  }

  async rebuild(rootUri: string): Promise<Envelope<NarrativeRebuildReport>> {
    const rootPath = canonicalWorkspaceKey(rootUri);
    const session = this.session(rootUri);
    if (!hasManuscriptManifest(rootPath)) {
      // Not a manuscript: nothing to build, and no database to build it into.
      // The session reports `absent`/`no-manuscript` on its own, so this is a
      // truthful zero rather than a fabricated success.
      return envelope(session.state(), emptyRebuildReport());
    }
    // THROUGH THE MAINTAINER'S OWN GUARD, NOT `session.rebuild()` DIRECTLY
    // (ISS-359 follow-through). `rebuildNow()` exists precisely because "the
    // command is a THIRD writer" (see `NarrativeIndexMaintainer`'s class
    // doc) — a call that bypassed it was harmless only while the watcher
    // could never be live to race it. Now that `maintainer(rootPath)` starts
    // a real watcher the moment this workspace's store opens, an explicit
    // Rebuild and an in-flight watcher pass are reachable at once, and only
    // the shared queue keeps them from writing over each other. `rebuildNow`
    // reads the same file set through the same `readAll()` ->
    // `scanWorkspaceFiles()` call `NodeNarrativeWorkspaceSource` already
    // wraps, so this changes NOTHING about what a rebuild indexes — only
    // that it now waits its turn.
    return this.maintainer(rootPath).rebuildNow();
  }

  async getEntity(rootUri: string, entityId: string): Promise<Envelope<NarrativeEntity | undefined>> {
    return this.session(rootUri).getEntity(entityId);
  }

  async findEntities(rootUri: string, query?: EntityQuery): Promise<Envelope<NarrativeEntity[]>> {
    return this.session(rootUri).findEntities(query);
  }

  async getMentions(rootUri: string, query?: MentionQuery): Promise<Envelope<NarrativeMention[]>> {
    return this.session(rootUri).getMentions(query);
  }

  async getRelations(rootUri: string, query?: RelationQuery): Promise<Envelope<NarrativeRelation[]>> {
    return this.session(rootUri).getRelations(query);
  }

  async listEvents(rootUri: string, query: EventQuery): Promise<Envelope<IndexedEvent[]>> {
    return this.session(rootUri).listEvents(query);
  }

  async getEvent(rootUri: string, eventId: string): Promise<Envelope<IndexedEvent | undefined>> {
    return this.session(rootUri).getEvent(eventId);
  }

  /**
   * Where an entity appears, in manuscript order, optionally quoted (gh#47).
   *
   * NOT A PLAIN DELEGATION like its neighbours above, and this is the only read
   * method here that is not — because it is the seam where two concerns meet
   * that live in different layers. The ORDER is the store's (`MentionQuery`
   * ordering, which joins the document's `chapter_order` where the rows are),
   * and the QUOTATION is this layer's, because `common/` has no filesystem.
   *
   * ONE READ PER DOCUMENT, NOT PER APPEARANCE. Several appearances routinely
   * share a chapter, and the hash check needs the whole file anyway; reading it
   * once per appearance would multiply the cost by the very number a card is
   * most likely to ask for. The cache is per call rather than held: a longer
   * life would mean serving a quotation from bytes read before the caller's
   * question, which is the staleness this whole rule exists to refuse.
   */
  async getEntityAppearances(
    rootUri: string,
    entityId: string,
    query: EntityAppearanceQuery = {}
  ): Promise<Envelope<EntityAppearanceResult>> {
    const session = this.session(rootUri);
    const answer = session.getMentions({
      entityId,
      orderBy: 'chapter',
      direction: query.direction ?? 'asc',
      ...(query.limit === undefined ? {} : { limit: query.limit })
    });
    const rootPath = canonicalWorkspaceKey(rootUri);
    const documents = new Map<string, NarrativeDocumentSummary | undefined>();
    const texts = new Map<string, VerifiedDocument>();
    const appearances: EntityAppearance[] = [];
    for (const mention of answer.data) {
      appearances.push(
        await this.toAppearance(mention, session, rootPath, query.withExcerpt === true, texts, documents)
      );
    }
    // The spread is read from the SAME session, inside the same call, so it
    // cannot straddle a rebuild the way two RPC round trips could — see
    // `EntityAppearanceResult`.
    const spread = query.withSpread === true ? session.countMentionsByDocument({ entityId }) : undefined;
    // The first appearance is read from the SAME session in the SAME call, so
    // the card's two headline facts cannot come from two generations. Asked for
    // explicitly, because a caller listing recent appearances does not need it.
    const firstMention =
      query.withFirst === true
        ? session.getMentions({ entityId, orderBy: 'chapter', direction: 'asc', limit: 1 }).data[0]
        : undefined;
    const first =
      firstMention === undefined
        ? undefined
        : await this.toAppearance(firstMention, session, rootPath, query.withExcerpt === true, texts, documents);
    // The envelope of the ORIGINAL read: state and generation describe the index
    // the mentions came from. Rebuilding one here would report the state at the
    // end of the file reads instead, which is a different and later claim.
    return {
      ...answer,
      data: {
        appearances,
        ...(first === undefined ? {} : { first }),
        ...(spread === undefined ? {} : { spread })
      }
    };
  }

  /**
   * One mention, projected into an appearance.
   *
   * SHARED BY THE LIST AND BY `EntityAppearanceResult.first`, on purpose: the
   * first appearance is not a different kind of thing, and two projections
   * would be two chances for the excerpt rule or the exclusion reason to differ
   * between the value a card puts in its headline and the ones it lists below.
   *
   * The caches are passed IN rather than owned here, so a first appearance that
   * repeats a chapter already read costs no second read.
   */
  protected async toAppearance(
    mention: NarrativeMention,
    session: NarrativeIndexSession,
    rootPath: string,
    withExcerpt: boolean,
    texts: Map<string, VerifiedDocument>,
    documents: Map<string, NarrativeDocumentSummary | undefined>
  ): Promise<EntityAppearance> {
    const relPath = mention.evidence.path;
    if (!documents.has(relPath)) {
      documents.set(relPath, session.getDocument(relPath));
    }
    const document = documents.get(relPath);
    const orderExclusion =
      document === undefined
        ? 'no-chapter-order'
        : mentionOrderExclusion(mention, {
            ...(document.chapterOrder === undefined ? {} : { chapterOrder: document.chapterOrder }),
            buildIncluded: document.buildIncluded
          });
    const appearance: EntityAppearance = {
      mention,
      ...(document?.title === undefined ? {} : { chapterTitle: document.title }),
      ...(document?.chapterOrder === undefined ? {} : { chapterOrder: document.chapterOrder }),
      ...(orderExclusion === undefined ? {} : { orderExclusion })
    };
    if (!withExcerpt) {
      return appearance;
    }
    if (document === undefined) {
      appearance.excerptUnavailable = 'unreadable';
      return appearance;
    }
    // The TEXT is cached, never the finished excerpt: two appearances in one
    // chapter have different ranges, so caching the quotation would serve the
    // second one the first one's passage. Keyed by path AND hash, so a document
    // re-indexed mid-call is a different document for quoting purposes rather
    // than a cache hit the new hash never vouched for.
    const key = `${relPath}::${document.contentHash}`;
    let verified = texts.get(key);
    if (verified === undefined) {
      verified = await readVerifiedDocument(rootPath, relPath, document.contentHash);
      texts.set(key, verified);
    }
    if (verified.text === undefined) {
      appearance.excerptUnavailable = verified.unavailable ?? 'unreadable';
      return appearance;
    }
    const excerpt = sliceExcerpt(verified.text, mention.evidence);
    if (excerpt.text === undefined) {
      appearance.excerptUnavailable = excerpt.unavailable ?? 'unreadable';
    } else {
      appearance.excerpt = excerpt.text;
    }
    return appearance;
  }

  /**
   * Every duplicated entity id, read directly from the store (TASK-022 WP-5,
   * ISS-353). See the protocol doc — this is a plain delegation, exactly like
   * {@link getMentions} and {@link getRelations} above it, and no cheaper
   * shape is possible: the session already holds the method.
   */
  async getDuplicateEntities(rootUri: string): Promise<Envelope<DuplicateEntityRecord[]>> {
    return this.session(rootUri).getDuplicateEntities();
  }

  /**
   * Every document the index holds, `docId`/`generation` stripped (TASK-022
   * WP-7). See the protocol doc for why those two fields never cross RPC.
   */
  async listDocuments(rootUri: string): Promise<Envelope<NarrativeDocumentSummary[]>> {
    const session = this.session(rootUri);
    return envelope(session.state(), session.documents().map(stripInternalDocumentFields));
  }

  /**
   * The effective entity-type registry, read directly and without a rebuild
   * (TASK-022 WP-7, tech_spec TECH_SPEC WP-7 §2).
   *
   * An unreadable `entities/types.yaml` (missing, or a workspace that is not a
   * manuscript at all) is not an error here: `resolveEffectiveEntityTypes`
   * already treats an absent file as "no author types", the same rule the
   * extraction pipeline applies during a rebuild.
   */
  async getEntityTypeRegistry(
    rootUri: string
  ): Promise<Envelope<{ types: EffectiveEntityType[]; problems: EntityTypeProblem[] }>> {
    const session = this.session(rootUri);
    const rootPath = canonicalWorkspaceKey(rootUri);
    let text: string | undefined;
    try {
      text = await fs.readFile(join(rootPath, 'entities/types.yaml'), 'utf8');
    } catch {
      text = undefined;
    }
    return envelope(session.state(), resolveEffectiveEntityTypes(text));
  }

  /**
   * `manifest.yaml`, read directly and without a rebuild (TASK-022 WP-7 §7).
   *
   * Same shape of cheapness as {@link getEntityTypeRegistry}: `extractManifestChapters`
   * is the pure text-in/structure-out function the rebuild path already runs,
   * called here with no effect on the store.
   */
  async getManifestChapters(rootUri: string): Promise<Envelope<ManuscriptManifest>> {
    const session = this.session(rootUri);
    const rootPath = canonicalWorkspaceKey(rootUri);
    let text: string | undefined;
    try {
      text = await fs.readFile(join(rootPath, 'manifest.yaml'), 'utf8');
    } catch {
      text = undefined;
    }
    return envelope(session.state(), extractManifestChapters(text));
  }

  /**
   * Context for one passage (tech_spec ОВ-2).
   *
   * THE SIGNATURE CARRIES NO `rootUri`, because ОВ-2 pins it to
   * `(uri, options?)`. The workspace is found by walking UP from the document
   * to the nearest ancestor holding a `manifest.yaml` — deterministic, and it
   * needs no second parameter a caller could get wrong. A document with no such
   * ancestor is in no manuscript, and the answer is an envelope with no data
   * rather than an invented context.
   */
  async getContextForDocument(
    uri: string,
    options?: NarrativeContextOptions
  ): Promise<Envelope<NarrativeDocumentContext | undefined>> {
    const documentPath = toFsPath(uri);
    const rootPath = findManuscriptRoot(documentPath);
    if (rootPath === undefined) {
      return envelope(NOT_BUILT_INDEX_STATE, undefined);
    }
    return this.session(rootPath).getContextForDocument({
      documentUri: uri,
      relPath: relative(rootPath, documentPath).split(sep).join('/'),
      ...(options !== undefined ? { options } : {})
    });
  }

  /**
   * Re-index one document (TASK-022 WP-4b).
   *
   * The root is found by walking UP to the nearest `manifest.yaml`, exactly as
   * {@link getContextForDocument} does — one rule, one failure mode.
   */
  async updateDocument(uri: string): Promise<Envelope<NarrativeUpdateReport>> {
    const documentPath = toFsPath(uri);
    const rootPath = findManuscriptRoot(documentPath);
    if (rootPath === undefined) {
      return envelope(NOT_BUILT_INDEX_STATE, emptyUpdateReport());
    }
    return this.maintainer(rootPath).updateDocument(
      relative(rootPath, documentPath).split(sep).join('/')
    );
  }

  /**
   * "Check for Changes Now" (TASK-022 UR-036 part 1). A cheap on-demand sweep,
   * NOT a rebuild — see the protocol doc for why the two are not the same
   * command under two names.
   *
   * `this.session(rootUri)` IS CALLED FIRST, exactly as {@link rebuild} does it
   * and for the identical reason: `session()` is the ONLY place that decides
   * whether this root is a manuscript at all, and it is what starts the
   * maintainer for one (ISS-359's fix). Calling `this.maintainer(rootPath)`
   * directly, skipping this, would build a maintainer — a live watcher, a
   * debounce timer, a sweep timer — for a workspace `session()` would have
   * refused one to, because it holds no `manifest.yaml`. That is precisely the
   * "a photo folder gets neither a database nor a live filesystem watcher"
   * invariant `session()`'s own doc comment states; a naive one-line delegation
   * straight to `this.maintainer()` would silently break it for every
   * non-manuscript root this method is ever called on.
   */
  async checkForChanges(rootUri: string): Promise<Envelope<NarrativeUpdateReport>> {
    const rootPath = canonicalWorkspaceKey(rootUri);
    const session = this.session(rootUri);
    if (!hasManuscriptManifest(rootPath)) {
      return envelope(session.state(), emptyUpdateReport());
    }
    return this.maintainer(rootPath).sweep('prefiltered', 'explicit');
  }

  /**
   * Change the live configuration (tech_spec ОВ-9б).
   *
   * THE ROOT IS CANONICALIZED FIRST, and skipping that would break the feature
   * in a way no unit test of the handler would see: the registry keys everything
   * by `realpath`, so on macOS a patch scoped to `/var/folders/...` would land
   * under a key the store for `/private/var/folders/...` never reads, and the
   * setting would be accepted, reported as applied, and quietly ignored.
   */
  async configure(patch: NarrativeMemoryConfigPatch, rootUri?: string): Promise<ConfigureResult> {
    return this.configurator.configure(
      patch,
      rootUri === undefined ? undefined : canonicalWorkspaceKey(rootUri)
    );
  }

  /**
   * Whether a manual Rebuild would be refused right now (WP-5, ОВ-4).
   *
   * NO STORE IS OPENED TO ANSWER IT. Opening one would be the wrong thing in
   * the exact situation the question is asked in — the user pressing Rebuild
   * under an error in the status bar — because opening claims the writer lock,
   * and claiming a lock is the write we are trying to establish is forbidden.
   * The registry reads the lock rows out of the file directly.
   *
   * A WORKSPACE WITHOUT A MANIFEST ANSWERS "available". Not because a rebuild
   * would do anything there, but because THIS question is only about ownership;
   * `absent`/`no-manuscript` is already in `IndexState`, and the frontend hides
   * both commands on it. Answering "unavailable" here would give one condition
   * two homes and let them disagree.
   */
  async getRebuildAvailability(rootUri: string): Promise<RebuildAvailability> {
    const rootPath = canonicalWorkspaceKey(rootUri);
    if (!hasManuscriptManifest(rootPath)) {
      return { available: true };
    }
    return this.registry.rebuildBlockedByForeignWriter(rootPath)
      ? { available: false, reason: 'foreign-writer' }
      : { available: true };
  }

  /**
   * Close everything: watchers, timers, sessions and stores.
   *
   * WHO CALLS IT IS THE POINT. WP-4a left this method with no caller, so a
   * writer lock outlived the process that took it and was recovered only by the
   * 30-second stale-lock takeover — survivable, because that takeover exists.
   * WP-4b makes it not survivable: a maintainer holds a live watcher
   * subscription and a self-re-arming fallback timer, and neither is reclaimed
   * by any expiry. So the backend module now binds this to
   * `BackendApplicationContribution.onStop`, and the lock release comes along
   * with it.
   */
  dispose(): void {
    for (const maintainer of this.maintainers.values()) {
      maintainer.stop();
    }
    this.maintainers.clear();
    this.sessions.clear();
    this.originalRootUriByPath.clear();
    this.onIndexChangedEmitter.dispose();
    this.registry.closeAll();
  }

  /**
   * The maintainer for a workspace root, started on first use.
   *
   * ONE PER ROOT, because the guard it owns is a SINGLE-WRITER guard and there
   * is one writer per database. A process-wide maintainer would serialize two
   * unrelated manuscripts against each other for no reason; a per-call one would
   * not serialize anything at all.
   *
   * "FIRST USE" IS NOW `session()`'s, NOT A CALLER NOBODY HAS (ISS-359). This
   * method itself has had a caller since WP-4b (`updateDocument`), but nothing
   * in a running application ever CALLED `updateDocument` — so the watcher, the
   * debounce window and the fallback sweep this class owns never existed
   * outside a test. `session()` calling this the moment a manuscript's store
   * opens is what makes "first use" mean "the workspace is open" instead of
   * "a method nobody wires ran".
   */
  protected maintainer(rootUriOrPath: string): NarrativeIndexMaintainer {
    const rootPath = canonicalWorkspaceKey(rootUriOrPath);
    const existing = this.maintainers.get(rootPath);
    if (existing !== undefined) {
      return existing;
    }
    const maintainer = new NarrativeIndexMaintainer({
      session: this.session(rootPath),
      source: new NodeNarrativeWorkspaceSource(rootPath),
      config: () => this.resolver.resolve(rootPath),
      configurator: this.configurator,
      rootPath,
      // UR-043. The maintainer already debounces/coalesces; this callback
      // only has to fan the ALREADY-SETTLED generation out to every RPC
      // connection. Falling back to `rootPath` itself (rather than dropping
      // the event) covers the theoretical case of a maintainer started before
      // any `file:`-shaped call ever reached `session()` — it cannot happen
      // through this class's own call graph (see `session`'s doc), but a
      // silently swallowed push would be a worse failure than one no
      // frontend's cached URI happens to match.
      onIndexChanged: generation => this.onIndexChangedEmitter.fire({
        rootUri: this.originalRootUriByPath.get(rootPath) ?? rootPath,
        generation
      }),
      ...(this.createWatcher !== undefined ? { watcher: this.createWatcher(rootPath) } : {}),
      probeWatcherTouch: () => this.touchWatcherProbeFile(rootPath)
    });
    this.maintainers.set(rootPath, maintainer);
    maintainer.start();
    return maintainer;
  }

  /**
   * Write the liveness probe's own file (ISS-374, gh#69).
   *
   * `.afe/` AND EMPHATICALLY NOT `.theia/`. The first version of this wrote into
   * `.theia/` on the reasoning that the directory is excluded from the index
   * walk — true, and exactly backwards. `TheiaNarrativeFileWatcher` passes that
   * SAME skip list to `watchFileChanges` as `ignored`, so a write there is one
   * the watcher is contractually forbidden to report. The probe listens on that
   * very stream, so it could never hear its own write: every healthy session
   * would have answered `silent` and shown the author a permanent, false
   * "file change notifications stopped". A probe that cannot pass on a working
   * system is worse than no probe.
   *
   * `.afe/` SATISFIES BOTH HALVES, and both were checked rather than assumed:
   * it is NOT in {@link NARRATIVE_SCAN_SKIPPED_DIRECTORIES}, so events from it
   * ARE delivered; and `.tmp` is not in `NARRATIVE_SCAN_EXTENSIONS`, so
   * `isIndexablePath` rejects the file and no re-index results from it.
   *
   * ONE NO-OP PASS PER SESSION IS THE PRICE, KNOWINGLY PAID. `onFileChanges`
   * re-arms the debounce window before anything filters for indexability, so
   * this single write does cost one empty maintenance pass — "пустой проход
   * бесплатен" by ОВ-4, and once per session at that. The alternative, a
   * watcher-deaf probe, costs a false alarm on every session.
   *
   * NOT DELETED AFTERWARDS. Removing it in the same breath would put a create
   * and a delete in one watcher window, and a watcher that coalesces the pair
   * into nothing would hand back a FALSE `silent` — the one verdict this must
   * never invent, because a human is shown it as "your edits are not being
   * seen". One tiny hidden file, overwritten once per session, is the cheaper
   * trade.
   */
  protected async touchWatcherProbeFile(rootPath: string): Promise<void> {
    const directory = join(rootPath, '.afe');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, 'watcher-probe.tmp'), String(Date.now()), 'utf8');
  }

  /**
   * The session for a workspace root, opening its store on first use.
   *
   * A NON-MANUSCRIPT ROOT STILL GETS A SESSION, but never a database: the
   * manifest check runs first, and `registry.acquire` — the only thing that
   * creates a file — is not called at all. THE SAME GUARD KEEPS THE MAINTAINER
   * OFF A NON-MANUSCRIPT ROOT TOO (ISS-359 trap 1) — a photo folder gets
   * neither a database nor a live filesystem watcher.
   *
   * STARTING THE MAINTAINER HERE, RATHER THAN LEAVING IT TO WHOEVER FIRST CALLS
   * `maintainer()`, IS WHAT MAKES THE INDEX SELF-UPDATE AT ALL (ISS-359). Every
   * RPC method that reads or reports the index already funnels through this
   * method — `getIndexStatus` first among them, polled by the frontend every
   * five seconds from the moment a workspace opens — so hooking the maintainer
   * to the SAME cache-miss branch that opens the store means the watcher goes
   * live at the exact instant something first asks about this workspace, with
   * no second entry point to forget.
   *
   * LOCK TIMING IS UNCHANGED. `registry.acquire(rootPath)` already claims the
   * writer lock (or falls back to read-only) synchronously, right here, exactly
   * as it always has — starting the maintainer AFTER that call adds a
   * watcher subscription and a sweep timer, not an earlier or reordered lock
   * claim (ISS-357 stays load-bearing: nothing here touches when or how often
   * the writer role is (re)claimed).
   */
  protected session(rootUriOrPath: string): NarrativeIndexSession {
    const rootPath = canonicalWorkspaceKey(rootUriOrPath);
    // See `originalRootUriByPath`'s own doc for why ONLY a `file:` URI is
    // recorded here, never the canonical path some callers already pass.
    if (rootUriOrPath.startsWith('file:')) {
      this.originalRootUriByPath.set(rootPath, rootUriOrPath);
    }
    const existing = this.sessions.get(rootPath);
    if (existing !== undefined) {
      return existing;
    }
    const manuscript = hasManuscriptManifest(rootPath);
    const store = manuscript ? this.registry.acquire(rootPath) : absentStore();
    if (manuscript) {
      // `registry.acquire()` above may just have evicted an older root's store
      // to stay within `maxOpenWorkspaces` (ОВ-4 Б, ISS-359 trap 3) — drop this
      // service's OWN cache for whatever it evicted before it caches anything
      // new, or a maintainer built on that root would go on watching files and
      // arming sweeps against a store that already closed underneath it.
      this.reconcileMaintainers();
    }
    const session = new NarrativeIndexSession({
      store,
      schemaVersion: NARRATIVE_INDEX_SCHEMA_VERSION,
      ...(manuscript ? {} : { absentCause: 'no-manuscript' as const })
    });
    this.sessions.set(rootPath, session);
    if (manuscript) {
      this.maintainer(rootPath);
    }
    return session;
  }

  /**
   * Stop and drop the maintainer (and cached session) for any root the
   * registry's LRU no longer holds open (ISS-359 trap 3).
   *
   * ONLY ROOTS WITH A MAINTAINER ARE CHECKED, deliberately: a non-manuscript
   * root's session is never in `registry.openRoots()` at all (it was never
   * acquired from the registry — see `absentStore()`), so checking every
   * cached session against that list would evict every non-manuscript entry on
   * its very next touch. Restricting the check to `this.maintainers.keys()`
   * — which holds ONLY manuscript roots the registry actually opened — avoids
   * that false positive by construction.
   *
   * SAFE AGAINST SELF-EVICTION. This runs right after `registry.acquire()`
   * returns, and the LRU never evicts the entry it just inserted (`evictBeyond`
   * enforces `limit >= 1`), so the root this call is servicing is never the one
   * dropped here.
   */
  protected reconcileMaintainers(): void {
    const openRoots = new Set(this.registry.openRoots());
    for (const rootPath of [...this.maintainers.keys()]) {
      if (openRoots.has(rootPath)) {
        continue;
      }
      this.maintainers.get(rootPath)?.stop();
      this.maintainers.delete(rootPath);
      this.sessions.delete(rootPath);
    }
  }
}

/** A report for an update against a document in no manuscript. Real zeros, for
 *  the same reason `emptyRebuildReport` gives. */
function emptyUpdateReport(): NarrativeUpdateReport {
  return {
    mode: 'incremental',
    documentsReindexed: [],
    documentsRemoved: [],
    documentsMoved: [],
    unchangedDocuments: [],
    mentionsWritten: 0,
    eventsWritten: 0,
    derivedRelations: 0,
    unreadableDocuments: []
  };
}

/** A report for a rebuild that had nothing to build. Every field is a real
 *  zero, not a placeholder: the workspace genuinely holds no manuscript. */
function emptyRebuildReport(): NarrativeRebuildReport {
  return {
    documentsIndexed: 0,
    documentsRemoved: 0,
    unchangedDocuments: [],
    entities: 0,
    duplicateEntities: 0,
    mentions: 0,
    extractedRelations: 0,
    events: 0,
    derivedRelations: 0,
    manifestPresent: false,
    problems: { types: [], cards: [], manifest: [], events: [] }
  };
}

/**
 * The store handed to a session for a workspace that is not a manuscript.
 *
 * IT IS THE IN-MEMORY ADAPTER, AND SAYING SO IS BETTER THAN A BESPOKE NULL
 * OBJECT: it satisfies the port honestly, it creates no file, and every read
 * against it returns an empty result under an `absent`/`no-manuscript`
 * envelope. It is opened READ-ONLY so that a rebuild attempted against it fails
 * loudly instead of appearing to succeed into a void. A hand-written null store
 * would be a third implementation of the port that the contract core never runs
 * against — the drift the two-adapter scheme exists to prevent.
 */
function absentStore(): NarrativeIndexStore {
  return new InMemoryNarrativeIndexStore({ readOnly: true });
}

/** Drop the two store-internal fields before a document row crosses RPC
 *  (TASK-022 WP-7) — see {@link NarrativeDocumentSummary}. */
function stripInternalDocumentFields(document: IndexedDocument): NarrativeDocumentSummary {
  const { docId: _docId, generation: _generation, ...summary } = document;
  return summary;
}

/** `file:` URI or plain path to an absolute filesystem path. */
function toFsPath(uriOrPath: string): string {
  if (uriOrPath.startsWith('file:')) {
    return FileUri.fsPath(uriOrPath);
  }
  return isAbsolute(uriOrPath) ? uriOrPath : resolvePath(process.cwd(), uriOrPath);
}

/**
 * The nearest ancestor directory of `documentPath` holding a `manifest.yaml`.
 *
 * NEAREST, NOT OUTERMOST: a manuscript nested inside another folder that also
 * has a manifest belongs to the inner one — the same rule a `.git` lookup uses,
 * and the one a reader expects.
 */
export function findManuscriptRoot(documentPath: string): string | undefined {
  let directory = dirname(resolvePath(documentPath));
  for (;;) {
    if (existsSync(join(directory, 'manifest.yaml'))) {
      return canonicalWorkspaceKey(directory);
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}
