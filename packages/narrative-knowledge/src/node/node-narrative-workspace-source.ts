/**
 * The filesystem behind {@link NarrativeWorkspaceSource} (TASK-022 WP-4b).
 *
 * IT IS THE SECOND HALF OF `narrative-workspace-scan.ts`, NOT A REPLACEMENT.
 * WP-4a needed one operation — "read the whole workspace" — because a full
 * rebuild needs every file. WP-4b needs two more, and the split is the one
 * tech_spec ОВ-1's freshness key describes: a `stat` that costs nothing and a
 * read that costs a hash. Both go through {@link walkNarrativeFiles} — one
 * function, not two using one list of constants — so a file the rebuild sees and
 * a file a sweep sees are the same set by construction. That was written here
 * before it was true: until gh#48 WP-3 these were two hand-copied walks agreeing
 * by inspection, and adding the `knowledge/**` exemption to only one of them
 * would have made a sweep and a rebuild disagree about which files exist.
 *
 * WHY IT RETURNS PROMISES OVER SYNCHRONOUS CALLS. Not to make the filesystem
 * async — `readFileSync` stays. Because the port is async, and the port is async
 * because a guard that never suspends is not a guard: WP-4b's single-writer
 * serialization can only be observed, and therefore only be tested, at an
 * `await`. Wrapping a synchronous read in a resolved promise is the honest cost
 * of that, and it is one microtask.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import type { IndexableFile, NarrativeWorkspaceSource, WorkspaceFileStat } from '../common';
import { byScanPath, hashContent, scanWorkspaceFiles, walkNarrativeFiles } from './narrative-workspace-scan';

export class NodeNarrativeWorkspaceSource implements NarrativeWorkspaceSource {
  constructor(private readonly root: string) {}

  /**
   * Every candidate file, WITHOUT opening any of them.
   *
   * This is what makes the routine TTL sweep cheap enough to run every five
   * minutes on a 200-chapter manuscript, and it is the only reason ОВ-1's
   * prefilter is worth having at all.
   */
  async stat(): Promise<readonly WorkspaceFileStat[]> {
    const found: WorkspaceFileStat[] = [];
    walkNarrativeFiles(this.root, entry => {
      found.push({ path: entry.relPath, sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs });
    });
    return found.sort(byScanPath);
  }

  /**
   * Read and hash one file.
   *
   * `undefined` for gone OR unreadable, which is the port's contract and the
   * same tolerance `scanWorkspaceFiles` already has: a permission error on one
   * file must not cost the author the whole index. The caller is what turns a
   * file that SHOULD have been readable into `stale/partial-update-failed`.
   */
  async read(path: string): Promise<IndexableFile | undefined> {
    const absolute = join(this.root, path);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      return undefined;
    }
    if (!stats.isFile()) {
      return undefined;
    }
    let text: string;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch {
      return undefined;
    }
    return {
      path: toRelPath(this.root, absolute),
      uri: FileUri.create(absolute).toString(),
      text,
      sizeBytes: stats.size,
      mtimeMs: Math.trunc(stats.mtimeMs),
      contentHash: hashContent(text)
    };
  }

  /** The whole workspace — `scanWorkspaceFiles`, unchanged. */
  async readAll(): Promise<readonly IndexableFile[]> {
    return scanWorkspaceFiles(this.root);
  }
}

/** A workspace-relative POSIX path, which is the index's document identity. */
function toRelPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}
