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
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import type { IndexableFile } from '../common';

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
      let text: string;
      try {
        text = readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      const relPath = toRelPath(root, absolute);
      files.push({
        path: relPath,
        // Theia's own `FileUri`, not a hand-rolled `file://` string: these
        // URIs end up in stored entity payloads and are what the frontend
        // navigates by, so a second encoding convention would make the same
        // card look different depending on which layer wrote it. Only entity
        // cards carry a URI into the index, but building one for every file is
        // cheaper than deciding here which ones will need it — that decision
        // belongs to classification, one layer up and in another package
        // directory.
        uri: FileUri.create(absolute).toString(),
        text,
        sizeBytes: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
        contentHash: hashContent(text)
      });
    }
  };
  walk(root);
  // Sorted by code point so a rebuild's document order does not depend on the
  // order the filesystem happened to return entries in — the same order rule
  // the store promises for `listDocuments`.
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
