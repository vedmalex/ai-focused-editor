import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileUri } from '@theia/core/lib/common/file-uri';
import {
  InMemoryNarrativeIndexStore,
  NarrativeIndexMaintainer,
  NarrativeIndexSession,
  NarrativeMemoryConfigurator,
  NOT_BUILT_INDEX_STATE,
  envelope,
  type ConfigureResult,
  type EntityQuery,
  type Envelope,
  type IndexState,
  type MentionQuery,
  type NarrativeContextOptions,
  type NarrativeDocumentContext,
  type NarrativeEntity,
  type NarrativeFileWatcher,
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
import { NarrativeMemoryConfigResolver } from './narrative-memory-config-resolver';
import { NodeNarrativeWorkspaceSource } from './node-narrative-workspace-source';
import {
  NarrativeIndexStoreRegistry,
  canonicalWorkspaceKey,
  hasManuscriptManifest
} from './narrative-index-store-registry';
import { scanWorkspaceFiles } from './narrative-workspace-scan';

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
    return session.rebuild(scanWorkspaceFiles(rootPath));
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
    this.registry.closeAll();
  }

  /**
   * The maintainer for a workspace root, started on first use.
   *
   * ONE PER ROOT, because the guard it owns is a SINGLE-WRITER guard and there
   * is one writer per database. A process-wide maintainer would serialize two
   * unrelated manuscripts against each other for no reason; a per-call one would
   * not serialize anything at all.
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
      ...(this.createWatcher !== undefined ? { watcher: this.createWatcher(rootPath) } : {})
    });
    this.maintainers.set(rootPath, maintainer);
    maintainer.start();
    return maintainer;
  }

  /**
   * The session for a workspace root, opening its store on first use.
   *
   * A NON-MANUSCRIPT ROOT STILL GETS A SESSION, but never a database: the
   * manifest check runs first, and `registry.acquire` — the only thing that
   * creates a file — is not called at all.
   */
  protected session(rootUriOrPath: string): NarrativeIndexSession {
    const rootPath = canonicalWorkspaceKey(rootUriOrPath);
    const existing = this.sessions.get(rootPath);
    if (existing !== undefined) {
      return existing;
    }
    const manuscript = hasManuscriptManifest(rootPath);
    const session = new NarrativeIndexSession({
      store: manuscript ? this.registry.acquire(rootPath) : absentStore(),
      schemaVersion: NARRATIVE_INDEX_SCHEMA_VERSION,
      ...(manuscript ? {} : { absentCause: 'no-manuscript' as const })
    });
    this.sessions.set(rootPath, session);
    return session;
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
    derivedRelations: 0,
    manifestPresent: false,
    problems: { types: [], cards: [], manifest: [] }
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
