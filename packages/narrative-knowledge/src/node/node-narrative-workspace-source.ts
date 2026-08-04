/**
 * The filesystem behind {@link NarrativeWorkspaceSource} (TASK-022 WP-4b).
 *
 * IT IS THE SECOND HALF OF `narrative-workspace-scan.ts`, NOT A REPLACEMENT.
 * WP-4a needed one operation — "read the whole workspace" — because a full
 * rebuild needs every file. WP-4b needs two more, and the split is the one
 * tech_spec ОВ-1's freshness key describes: a `stat` that costs nothing and a
 * read that costs a hash. Both go through the same walk, the same skip list and
 * the same extension filter, so a file the rebuild sees and a file a sweep sees
 * are the same set by construction rather than by two lists somebody keeps in
 * step.
 *
 * WHY IT RETURNS PROMISES OVER SYNCHRONOUS CALLS. Not to make the filesystem
 * async — `readFileSync` stays. Because the port is async, and the port is async
 * because a guard that never suspends is not a guard: WP-4b's single-writer
 * serialization can only be observed, and therefore only be tested, at an
 * `await`. Wrapping a synchronous read in a resolved promise is the honest cost
 * of that, and it is one microtask.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import type { IndexableFile, NarrativeWorkspaceSource, WorkspaceFileStat } from '../common';
import {
  hashContent,
  scanWorkspaceFiles,
  NARRATIVE_SCAN_EXTENSIONS,
  NARRATIVE_SCAN_SKIPPED_DIRECTORIES
} from './narrative-workspace-scan';

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
    const walk = (directory: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(directory);
      } catch {
        return;
      }
      for (const entry of entries) {
        const absolute = join(directory, entry);
        let stats;
        try {
          stats = statSync(absolute);
        } catch {
          continue;
        }
        if (stats.isDirectory()) {
          if (!NARRATIVE_SCAN_SKIPPED_DIRECTORIES.includes(entry)) {
            walk(absolute);
          }
          continue;
        }
        if (!stats.isFile()) {
          continue;
        }
        const lower = entry.toLowerCase();
        if (!NARRATIVE_SCAN_EXTENSIONS.some(extension => lower.endsWith(extension))) {
          continue;
        }
        found.push({
          path: toRelPath(this.root, absolute),
          sizeBytes: stats.size,
          // TRUNCATED, exactly as `scanWorkspaceFiles` truncates it. A `stat`
          // whose `mtimeMs` carried sub-millisecond precision the stored row
          // does not would miss the prefilter on every file, every sweep — the
          // prefilter would be present and useless, and nothing would say so.
          mtimeMs: Math.trunc(stats.mtimeMs)
        });
      }
    };
    walk(this.root);
    return found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
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
