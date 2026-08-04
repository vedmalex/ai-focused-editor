/**
 * One database per workspace root, bounded by an LRU (TASK-022 WP-3, tech_spec
 * ОВ-4 Б).
 *
 * THIS IS NOT A HYPOTHETICAL CASE. Every existing narrative backend method
 * already takes `rootUri` as a PARAMETER and resolves it per call, while the
 * service itself is a process singleton — so several workspaces on one backend
 * is the situation the code is already in, not one this work package invents.
 *
 * WHY NOT ONE SHARED DATABASE WITH A `root_id` COLUMN. Three reasons, and the
 * third is the decisive one:
 *   1. the database is a derivative cache OF THAT workspace — delete the folder
 *      and the cache should go with it, whereas a shared file keeps orphan rows
 *      forever;
 *   2. `.gitignore` already covers `.theia/`, so a per-workspace file needs no
 *      new ignore entry to stay out of git;
 *   3. a shared database recreates precisely the "hidden cross-project memory"
 *      that gh#51 forbids in as many words.
 *
 * THE KEY IS A REAL PATH, AND THAT IS NOT A DETAIL. Without canonicalization
 * `/a/b`, `/a/b/` and a symlink to the same directory would open ONE FILE TWICE
 * IN ONE PROCESS — the in-process guard bypassed by its own owner. The writer
 * lock would catch it, but at the cost of a bogus `stale` in normal operation:
 * the backend would be reporting a foreign writer that is itself.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectable } from '@theia/core/shared/inversify';
import type { NarrativeIndexStore } from '../common';
import { NarrativeMemoryConfigResolver } from './narrative-memory-config-resolver';
import {
  SqliteNarrativeIndexStore,
  isRebuildBlockedByForeignWriter,
  type NarrativeIndexStoreLogger,
  type SqliteNarrativeIndexStoreOptions
} from './sqlite-narrative-index-store';

/** How a store gets built. Injectable so a test can count opens and closes, and
 *  so a future adapter swap does not have to edit this file. */
export type NarrativeIndexStoreFactory = (options: SqliteNarrativeIndexStoreOptions) => NarrativeIndexStore;

export interface NarrativeIndexStoreRegistryOptions {
  resolver?: NarrativeMemoryConfigResolver;
  createStore?: NarrativeIndexStoreFactory;
  log?: NarrativeIndexStoreLogger;
  now?: () => number;
  bootId?: string;
  heartbeatIntervalMs?: number;
  lockStaleAfterMs?: number;
}

interface Entry {
  rootPath: string;
  databaseFile: string;
  store: NarrativeIndexStore;
  /**
   * The boot id THIS registry handed that store.
   *
   * Recorded rather than left to the store to invent, because the ownership
   * question of ОВ-4 has to be answerable ABOUT a store from OUTSIDE it — a
   * lock written by our own instance is not foreign, and without the id here
   * every check would call it foreign and refuse a rebuild the user is
   * entitled to.
   */
  bootId: string;
}

/**
 * Canonical key for a workspace root.
 *
 * Accepts a `file:` URI or a plain path, because the RPC layer speaks URIs and
 * the backend internals speak paths, and forcing one of them to convert at
 * every call site is how the two end up disagreeing.
 *
 * `realpath` is attempted and its FAILURE IS TOLERATED: a root that does not
 * exist yet still deserves a stable key, and refusing here would turn a missing
 * directory into a crash instead of an `absent` index.
 */
export function canonicalWorkspaceKey(rootUriOrPath: string): string {
  let path = rootUriOrPath;
  if (path.startsWith('file:')) {
    path = fileURLToPath(path);
  }
  path = resolvePath(path);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

@injectable()
export class NarrativeIndexStoreRegistry {
  private readonly resolver: NarrativeMemoryConfigResolver;
  private readonly createStore: NarrativeIndexStoreFactory;
  private readonly options: NarrativeIndexStoreRegistryOptions;
  /** Insertion order IS the LRU order: a hit deletes and re-inserts. */
  private readonly open = new Map<string, Entry>();

  constructor(options: NarrativeIndexStoreRegistryOptions = {}) {
    this.options = options;
    this.resolver = options.resolver ?? new NarrativeMemoryConfigResolver();
    this.createStore = options.createStore ?? (opts => new SqliteNarrativeIndexStore(opts));
  }

  /** The database file this registry would use for `rootUriOrPath`, without
   *  opening anything — the seam the "opens the file the config names" test
   *  needs in order to be about the CONFIG rather than about the store. */
  databaseFileFor(rootUriOrPath: string): string {
    const rootPath = canonicalWorkspaceKey(rootUriOrPath);
    const configured = this.resolver.resolve(rootPath).databasePath;
    // An absolute configured path is honoured as given: an operator pointing the
    // index at a scratch volume means that volume, not one inside the workspace.
    return isAbsolute(configured) ? configured : join(rootPath, configured);
  }

  /** Open (or reuse) the store for a workspace root. */
  acquire(rootUriOrPath: string): NarrativeIndexStore {
    const rootPath = canonicalWorkspaceKey(rootUriOrPath);
    const existing = this.open.get(rootPath);
    if (existing !== undefined) {
      this.open.delete(rootPath);
      this.open.set(rootPath, existing);
      return existing.store;
    }
    const config = this.resolver.resolve(rootPath);
    const databaseFile = this.databaseFileFor(rootPath);
    // Decided HERE rather than inside the store's constructor default, so the
    // registry knows which lock rows are its own — see `Entry.bootId`.
    const bootId = this.options.bootId ?? randomUUID();
    const store = this.createStore({
      databaseFile,
      workspaceRoot: rootPath,
      log: this.options.log,
      now: this.options.now,
      bootId,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      lockStaleAfterMs: this.options.lockStaleAfterMs
    });
    this.open.set(rootPath, { rootPath, databaseFile, store, bootId });
    this.evictBeyond(Math.max(1, config.maxOpenWorkspaces));
    return store;
  }

  /**
   * Whether a manual Rebuild of `rootUriOrPath` must be refused RIGHT NOW
   * because another live process owns the database (tech_spec ОВ-4, ISS-321).
   *
   * ASKED OF THE FILE, NOT OF A STORE, and that is the hard case: the user is
   * most likely to press Rebuild exactly when opening failed and the status bar
   * shows an error, i.e. when there is no store instance to ask. `existsSync`
   * on a database that was never created answers "not owned", which is correct
   * — nothing to protect.
   *
   * NOT CACHED. A lock expires 30 seconds after its last heartbeat, and that
   * can happen while the user is looking at the status bar. Caching would turn
   * a temporary refusal into a permanent one until something else moved.
   */
  rebuildBlockedByForeignWriter(rootUriOrPath: string): boolean {
    const rootPath = canonicalWorkspaceKey(rootUriOrPath);
    const entry = this.open.get(rootPath);
    // With no open store, ANY lock in the file is foreign by definition — a
    // fresh id can never collide with one already written. With an open store,
    // its own id is what stops us calling our own lock foreign.
    const bootId = entry?.bootId ?? this.options.bootId ?? randomUUID();
    const databaseFile = entry?.databaseFile ?? this.databaseFileFor(rootPath);
    return isRebuildBlockedByForeignWriter(databaseFile, {
      now: (this.options.now ?? Date.now)(),
      bootId,
      ...(this.options.lockStaleAfterMs !== undefined
        ? { staleAfterMs: this.options.lockStaleAfterMs }
        : {})
    });
  }

  /** Whether a root currently has an open store. */
  isOpen(rootUriOrPath: string): boolean {
    return this.open.has(canonicalWorkspaceKey(rootUriOrPath));
  }

  /** Roots currently open, least recently used first. */
  openRoots(): string[] {
    return [...this.open.keys()];
  }

  /** Close one root's store, if open. */
  release(rootUriOrPath: string): void {
    const key = canonicalWorkspaceKey(rootUriOrPath);
    const entry = this.open.get(key);
    if (entry === undefined) {
      return;
    }
    this.open.delete(key);
    entry.store.close();
  }

  /** Close everything. The backend calls this on shutdown; a test calls it in
   *  teardown, and without it a leaked writer lock outlives the test that made
   *  it and poisons the next one. */
  closeAll(): void {
    for (const key of [...this.open.keys()]) {
      this.release(key);
    }
  }

  /**
   * Evict least-recently-used stores down to `limit`.
   *
   * Eviction CLOSES the store, which releases its writer-lock row — otherwise a
   * workspace pushed out of the LRU would keep a lock nobody is refreshing, and
   * the next process to open it would sit read-only until the lock expired.
   */
  private evictBeyond(limit: number): void {
    while (this.open.size > limit) {
      const oldest = this.open.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.release(oldest.value);
    }
  }
}

/** True when `rootPath` looks like a manuscript workspace at all.
 *
 *  Checked BEFORE a store is opened, because a workspace with no manifest must
 *  produce no database file whatsoever — `{state:'absent', cause:'no-manuscript'}`
 *  is an answer, not a failure, and creating an empty database to say it would
 *  litter every non-manuscript folder the user ever opens. */
export function hasManuscriptManifest(rootPath: string): boolean {
  return existsSync(join(canonicalWorkspaceKey(rootPath), 'manifest.yaml'));
}
