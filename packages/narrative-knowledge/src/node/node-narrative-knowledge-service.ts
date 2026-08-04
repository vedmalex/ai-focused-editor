import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FileUri } from '@theia/core/lib/common/file-uri';
import {
  InMemoryNarrativeIndexStore,
  NarrativeIndexSession,
  NOT_BUILT_INDEX_STATE,
  envelope,
  type EntityQuery,
  type Envelope,
  type IndexState,
  type MentionQuery,
  type NarrativeContextOptions,
  type NarrativeDocumentContext,
  type NarrativeEntity,
  type NarrativeIndexStore,
  type NarrativeKnowledgeService,
  type NarrativeMention,
  type NarrativeRebuildReport,
  type NarrativeRelation,
  type RelationQuery
} from '../common';
import { NARRATIVE_INDEX_SCHEMA_VERSION } from './narrative-index-schema';
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

  /** One session per canonical workspace root, alongside the registry's store.
   *  The session holds what the store cannot: whether a rebuild is in flight,
   *  the last hard failure, and when this instance first became read-only. */
  protected readonly sessions = new Map<string, NarrativeIndexSession>();

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

  /** Close everything. The backend calls this on shutdown; without it a leaked
   *  writer lock outlives the process that made it. */
  dispose(): void {
    this.sessions.clear();
    this.registry.closeAll();
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
