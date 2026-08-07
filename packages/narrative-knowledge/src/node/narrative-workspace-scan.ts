/**
 * Reading a manuscript off the disk (TASK-022 WP-4a).
 *
 * THIS IS THE ONLY THING WP-4a NEEDED A FILESYSTEM FOR. Everything else — what
 * state to report, what a query returns, what a rebuild writes — is
 * `NarrativeIndexSession` in `src/common`, so it runs under both `bun` and
 * `node` against both adapters. What genuinely cannot: `stat`, `readFile`,
 * SHA-256, and directory traversal.
 *
 * THE WALK IS LIBERAL AND THE CLASSIFICATION IS NOT, and that split is
 * deliberate. This module gathers every plausibly-narrative file; deciding
 * which ones the index reads is `classifyDocument`'s job, and it lives in
 * `src/common` where a test can reach it. If the walk pre-filtered by the same
 * rules, tech_spec ОВ-1's tooth B12 — "a fixture with non-empty
 * `sources/citations.yaml` and `sources/excerpts.jsonl` yields NOT ONE relation
 * row" — would be green because the files never arrived, not because the
 * pipeline refused them. A tooth that cannot tell those apart is not a tooth.
 *
 * `knowledge/**` IS THE ONE EXEMPTION FROM THAT LIBERALITY (gh#48 WP-3, F-12),
 * and it is narrow on purpose: `sources/**` still arrives and is still refused,
 * so tooth B12 keeps meaning what it meant. What changed is that gh#50 and gh#52
 * put APPEND-ONLY JOURNALS under `knowledge/`, whose `mtime` moves on every
 * write — so the `(size, mtime)` prefilter misses them by construction and each
 * sweep pays a full read and SHA-256 to reach a foregone conclusion. The skip
 * rule is NOT written here: it is
 * {@link narrativeIndexMayReadUnder}, exported by the classification module, so
 * that one boundary has one spelling. Two independent statements of "everything
 * under `knowledge/` except the timeline" would be two things to keep in step,
 * and this package has already paid for that once.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { narrativeIndexMayReadUnder, type IndexableFile } from '../common';

/**
 * Directories the walk never descends into.
 *
 * `.theia` is on the list for a reason worth stating: the index database lives
 * there by default, so walking it would make the index an input to itself.
 */
export const NARRATIVE_SCAN_SKIPPED_DIRECTORIES: readonly string[] = [
  '.git',
  '.theia',
  'node_modules',
  'lib',
  'dist',
  'out',
  'build'
];

/** Extensions the walk reads. Everything the four document kinds can be, plus
 *  the two `sources/**` shapes that must ARRIVE in order to be REFUSED. */
export const NARRATIVE_SCAN_EXTENSIONS: readonly string[] = ['.md', '.mdx', '.yaml', '.yml', '.jsonl'];

/** SHA-256 of a string's UTF-8 bytes, lowercase hex — `document.content_hash`. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A workspace-relative POSIX path, which is the index's document identity. */
function toRelPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/** One candidate file, measured but NOT opened. */
export interface NarrativeScanEntry {
  /** Absolute path, for whoever wants to read it. */
  absolute: string;
  /** Workspace-relative POSIX path — the index's document identity. */
  relPath: string;
  sizeBytes: number;
  /**
   * `mtimeMs`, TRUNCATED to whole milliseconds.
   *
   * Truncated HERE, once, because it is the prefilter's key: a `stat` carrying
   * sub-millisecond precision the stored row does not would miss the prefilter
   * on every file of every sweep — the prefilter would be present and useless,
   * and nothing would say so.
   */
  mtimeMs: number;
}

/**
 * THE walk. Both callers use this one, which is what makes "a file the rebuild
 * sees and a file a sweep sees are the same set" true by construction rather
 * than by two implementations somebody keeps in step.
 *
 * It applies, in order: the directory skip list, the extension filter, and the
 * `knowledge/**` exemption ({@link narrativeIndexMayReadUnder}, owned by the
 * classification module and asked about FILES only). Unreadable directories and
 * unstattable entries are skipped rather than fatal — a permission error on one
 * file must not cost the author the whole index.
 */
export function walkNarrativeFiles(root: string, visit: (entry: NarrativeScanEntry) => void): void {
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
      const relPath = toRelPath(root, absolute);
      if (stats.isDirectory()) {
        // DIRECTORIES ARE NOT PRUNED BY THE `knowledge/**` RULE — only files
        // are. See `narrativeIndexMayReadUnder`: pruning here would make a
        // mutated classification invisible end to end, which is exactly the
        // failure mode this package keeps paying for.
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
      if (!narrativeIndexMayReadUnder(relPath)) {
        continue;
      }
      visit({ absolute, relPath, sizeBytes: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) });
    }
  };
  walk(root);
}

/** Code-point order, so a pass's document order does not depend on the order
 *  the filesystem happened to return entries in — the same rule the store
 *  promises for `listDocuments`. */
export function byScanPath<T extends { path: string }>(left: T, right: T): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/**
 * Read every plausibly-narrative file under `root`.
 *
 * AN UNREADABLE FILE IS SKIPPED, NOT FATAL. A rebuild that dies on one
 * permission error leaves the author with no index at all; the file simply does
 * not contribute, and WP-4b's `partial-update-failed` is where a single
 * document's failure becomes visible as staleness. A directory that cannot be
 * listed is skipped for the same reason.
 */
export function scanWorkspaceFiles(root: string): IndexableFile[] {
  const files: IndexableFile[] = [];
  walkNarrativeFiles(root, entry => {
    let text: string;
    try {
      text = readFileSync(entry.absolute, 'utf8');
    } catch {
      return;
    }
    files.push({
      path: entry.relPath,
      // Theia's own `FileUri`, not a hand-rolled `file://` string: these
      // URIs end up in stored entity payloads and are what the frontend
      // navigates by, so a second encoding convention would make the same
      // card look different depending on which layer wrote it. Only entity
      // cards carry a URI into the index, but building one for every file is
      // cheaper than deciding here which ones will need it — that decision
      // belongs to classification, one layer up and in another package
      // directory.
      uri: FileUri.create(entry.absolute).toString(),
      text,
      sizeBytes: entry.sizeBytes,
      mtimeMs: entry.mtimeMs,
      contentHash: hashContent(text)
    });
  });
  return files.sort(byScanPath);
}
