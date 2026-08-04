/**
 * `NarrativeWorkspaceSource` — the port the index reads files through
 * (TASK-022 WP-4b).
 *
 * WHY THE TWO METHODS ARE SPLIT THE WAY THEY ARE, AND WHY IT IS NOT A DETAIL.
 * tech_spec ОВ-1's freshness key is TWO-STEP: `(sizeBytes, mtimeMs)` is a
 * prefilter costing one `stat`, and `contentHash` is the authority consulted
 * only when the prefilter misses. ОВ-6 then requires the sweep that LEAVES
 * `watcher-lost` to skip the prefilter entirely and hash every file, while the
 * routine TTL sweep keeps it. Those two sweeps differ in exactly one observable:
 * WHICH FILES GET READ. Splitting `stat()` from `read()` is what turns that
 * difference into something a test can count, and ОВ-1's teeth C1 and C2 are a
 * matched pair whose whole content is that count:
 *
 *   - C1: a file with CHANGED content and RESTORED `mtime`/`size` MUST be
 *     re-indexed by the hash-authoritative sweep. An implementation with no
 *     `content_hash` cannot, and fails.
 *   - C2: the SAME file must NOT be re-indexed by the routine TTL sweep. That is
 *     the residual false-negative window of the prefilter, deliberately made
 *     OBSERVABLE rather than papered over — without C2, C1 would read as "always
 *     hash", which is the thing the budget cannot afford.
 *
 * A single `list(): IndexableFile[]` would have collapsed both into one code
 * path with nothing to distinguish, and the pair of teeth would have been two
 * spellings of one assertion.
 *
 * WHY IT IS ASYNC. Not because a filesystem is: `scanWorkspaceFiles` in
 * `src/node` is synchronous and stays so. Because the SINGLE GUARD is only a
 * guard if there is a moment at which a second request can arrive, and in a
 * single-threaded runtime that moment is an `await`. A synchronous source would
 * make the concurrency readiness case (plan WP-4b, case 1) unfalsifiable — it
 * would pass against an implementation with no guard at all.
 */

import type { IndexableFile } from './narrative-index-session';

/** What a `stat` knows: enough for the prefilter, and not one byte more. */
export interface WorkspaceFileStat {
  /** Workspace-relative POSIX path. */
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface NarrativeWorkspaceSource {
  /**
   * Every plausibly-narrative file, WITHOUT reading any of them.
   *
   * Ordered by path, code point ascending — the same order everything else in
   * this package promises, so a sweep's document order does not depend on what
   * the filesystem happened to return.
   */
  stat(): Promise<readonly WorkspaceFileStat[]>;
  /**
   * Read and hash ONE file.
   *
   * `undefined` means the file is GONE OR UNREADABLE, and the caller must treat
   * those two the same way it treats them today in `scanWorkspaceFiles`: a
   * permission error on one file must not cost the author the whole index. What
   * the caller adds on top is that a file which was SUPPOSED to be readable and
   * was not becomes `stale/partial-update-failed` (ОВ-6) rather than a silent
   * omission.
   */
  read(path: string): Promise<IndexableFile | undefined>;
  /**
   * Read every file. The input a FULL rebuild needs.
   *
   * Named separately rather than composed from `stat` + `read` by the caller,
   * because the node implementation already walks and reads in one pass and
   * splitting it would double the directory traversal.
   */
  readAll(): Promise<readonly IndexableFile[]>;
}

/**
 * A workspace held in memory.
 *
 * SHIPS IN `lib`, like the in-memory store adapter and the test watcher, so the
 * one body of contract assertions can use it in BOTH lanes.
 *
 * `reads` IS PUBLIC AND IS THE INSTRUMENT, not a debugging aid: it is how C1 and
 * C2 tell a hash-authoritative sweep from a prefiltered one.
 */
export class InMemoryWorkspaceSource implements NarrativeWorkspaceSource {
  private readonly files = new Map<string, IndexableFile>();
  /** Paths handed to {@link read}, in call order, including misses. */
  readonly reads: string[] = [];
  /**
   * Awaited before every `read` and `readAll` resolves.
   *
   * The seam the concurrency case needs: a test sets it to a promise it controls
   * and can then hold a pass open at a known instant while it issues a second
   * request. Left `undefined` the source behaves like any other async one.
   */
  gate: Promise<void> | undefined;

  constructor(files: readonly IndexableFile[] = []) {
    this.replaceAll(files);
  }

  /** Replace the whole workspace, as a `git checkout` would. */
  replaceAll(files: readonly IndexableFile[]): void {
    this.files.clear();
    for (const file of files) {
      this.files.set(file.path, { ...file });
    }
  }

  /** Write one file, creating it if absent. */
  put(file: IndexableFile): void {
    this.files.set(file.path, { ...file });
  }

  /** Remove one file. */
  remove(path: string): void {
    this.files.delete(path);
  }

  /** Rename one file, byte for byte — the move ОВ-3 has to infer. */
  move(from: string, to: string): void {
    const file = this.files.get(from);
    if (file === undefined) {
      throw new Error(`InMemoryWorkspaceSource.move: '${from}' does not exist`);
    }
    this.files.delete(from);
    this.files.set(to, { ...file, path: to, uri: `file:///workspace/${to}` });
  }

  /** Forget the read log, so a later assertion counts one sweep and not two. */
  resetReads(): void {
    this.reads.length = 0;
  }

  async stat(): Promise<readonly WorkspaceFileStat[]> {
    return [...this.files.values()]
      .map(file => ({ path: file.path, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  async read(path: string): Promise<IndexableFile | undefined> {
    this.reads.push(path);
    if (this.gate !== undefined) {
      await this.gate;
    }
    const file = this.files.get(path);
    return file === undefined ? undefined : { ...file };
  }

  async readAll(): Promise<readonly IndexableFile[]> {
    for (const path of this.files.keys()) {
      this.reads.push(path);
    }
    if (this.gate !== undefined) {
      await this.gate;
    }
    return [...this.files.values()]
      .map(file => ({ ...file }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }
}
