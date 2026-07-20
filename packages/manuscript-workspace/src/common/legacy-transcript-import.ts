/**
 * Pure (Theia-free) legacy-transcription DETECTION + IMPORT PLANNING — the
 * contract half of the "Transcribe… → Import existing transcriptions" wizard.
 *
 * THE LEGACY LAYOUT (the owner's historical toolchain output — converter CLI +
 * process_videos_unified.sh):
 *
 *   <dir>/
 *     Академия Шраванам 2026-02-25 19_00.mp4          ← source media (optional)
 *     Академия_Шраванам_2026-02-25_19_00/             ← chunk dir: media name,
 *       time[00:09:22][562].mp3                          spaces→underscores,
 *       time[00:09:22][562].json                         extension dropped
 *       …more time[…] media/json pairs…                  (mediaOutputFolderName)
 *       raw.md                                        ← toolchain full text
 *     transcripts/<Media_Name>.md, list.txt, temp_*   ← ignored leftovers
 *
 * DETECTION RULES (see {@link detectLegacyTranscriptSets}):
 *  1. a media file (per `mediaExtensions`) whose SIBLING DIRECTORY is named
 *     `mediaOutputFolderName(mediaName)` and holds ≥1 complete `time[…]`
 *     media+json pair → a legacy set WITH source media;
 *  2. a directory holding ≥1 complete pair but claimed by no media file →
 *     a "chunk dir only" legacy set (source media unknown);
 *  3. the SCAN ROOT itself holding ≥1 complete pair → the user picked the
 *     chunk dir directly — one set for the root.
 * Scanning covers ONE directory (non-recursive); `scanChildDirectories`
 * additionally applies rules 1+2 one level down. Plans are de-duplicated by
 * chunk-dir path (a source-claimed plan wins over an unclaimed one).
 *
 * Everything here is pure data-in/data-out (the browser wizard supplies the
 * {@link ScannedDirectory} listing via FileService) so the whole detector is
 * bun-testable, incl. Cyrillic names + spaces from the real example.
 */

import { getBaseName } from './proofreading-model';
import { mediaOutputFolderName } from './media-transcription-model';
import { DEFAULT_MEDIA_EXTENSIONS, TRANSCRIPT_EXTENSION, parseOffsetFromFilename } from './transcript-set-model';
import {
  RAW_MD_FILE_NAME,
  rawMdRelPath,
  transcriptSetFolder,
  transcriptSetFolders,
  transcriptsetRelPath
} from './transcript-set-scaffold';

/* ------------------------------------------------------------------------- *
 * Input listing
 * ------------------------------------------------------------------------- */

/** One scanned directory: plain file names + (optionally) its subdirectories. */
export interface ScannedDirectory {
  /** Absolute path of this directory (POSIX or `file://`-path form). */
  path: string;
  /** The directory's own base name (for slug derivation of chunk-dir-only sets). */
  name: string;
  /** Non-directory child names. */
  files: string[];
  /**
   * Immediate subdirectories WITH their own file listings. Their nested
   * `directories` may be empty/omitted — detection only descends one level
   * below the directory it is applied to.
   */
  directories: ScannedDirectory[];
}

/* ------------------------------------------------------------------------- *
 * Plan output
 * ------------------------------------------------------------------------- */

/** One legacy chunk pairing, keyed by the `time[…]` base name. */
export interface LegacyChunkPair {
  /** Base name shared by the chunk media and its json (e.g. `time[00:09:22][562]`). */
  base: string;
  /** Chunk media file name (absent → the json is an orphan). */
  mediaName?: string;
  /** Transcript json file name (absent → the chunk has no transcription yet). */
  jsonName?: string;
  /** Absolute chunk-END offset (ms) parsed from the base name; null when none. */
  offsetMs: number | null;
}

export type LegacyImportWarningCode =
  /** A chunk media file has no matching `.json`. */
  | 'missing-json'
  /** A `.json` has no matching chunk media file. */
  | 'orphan-json'
  /** The chunk dir carries no legacy `raw.md`. */
  | 'no-raw-md'
  /** No source media file was found next to the chunk dir. */
  | 'no-source-media';

/** One non-fatal problem discovered while planning an import. */
export interface LegacyImportWarning {
  code: LegacyImportWarningCode;
  /** English message (i18n happens at the presentation layer). */
  message: string;
  /** The affected pair base, for per-chunk warnings. */
  base?: string;
}

/** Workspace-relative target paths of one planned set (our book-native layout). */
export interface LegacyImportTargets {
  /** `transcription/<slug>`. */
  setFolder: string;
  /** `sources/audio/<slug>`. */
  audioFolder: string;
  /** `transcription/<slug>/transcripts`. */
  transcriptFolder: string;
  /** `transcription/<slug>/transcriptset.yaml`. */
  sidecarPath: string;
  /** `transcription/<slug>/raw.md`. */
  rawMdPath: string;
}

/** One detected legacy set, ready for the wizard to execute. */
export interface LegacyImportPlan {
  /** Absolute path of the chunk directory holding the `time[…]` pairs. */
  chunkDir: string;
  /** The chunk directory's base name. */
  chunkDirName: string;
  /** Absolute path of the source media file, when found next to the chunk dir. */
  sourceMediaPath?: string;
  /** The source media file's name (labels; slug derivation). */
  sourceMediaName?: string;
  /** Human label for pickers: the source media name, or the chunk dir name. */
  displayName: string;
  /** Derived set slug (spaces→underscores; Cyrillic preserved; path-safe). */
  slug: string;
  /** Target paths in our layout, derived from {@link slug}. */
  targets: LegacyImportTargets;
  /** All pair bases (union of chunk media and jsons), sorted by offset. */
  pairs: LegacyChunkPair[];
  /** Complete pairs (both media AND json present). */
  completePairs: number;
  /** True when the chunk dir carries a legacy `raw.md`. */
  hasLegacyRawMd: boolean;
  /** Absolute path of the legacy `raw.md`, when present. */
  legacyRawMdPath?: string;
  warnings: LegacyImportWarning[];
}

/** Options for {@link detectLegacyTranscriptSets}. */
export interface DetectLegacySetsOptions {
  /** Also apply the detection rules one level down (each subdirectory). Default false. */
  scanChildDirectories?: boolean;
  /** Media extensions for source files AND chunks. Default {@link DEFAULT_MEDIA_EXTENSIONS}. */
  mediaExtensions?: readonly string[];
}

/* ------------------------------------------------------------------------- *
 * Detection
 * ------------------------------------------------------------------------- */

/** Case-insensitive extension test (same convention as `transcript-set-model.ts`). */
function hasExtension(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some(ext => lower.endsWith(ext.toLowerCase()));
}

/** POSIX-join that tolerates a trailing slash on the directory path. */
function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/**
 * Derive a path-safe set slug from a legacy name: spaces→underscores (the
 * legacy chunk-dir convention), path separators and control characters→`_`,
 * Cyrillic and other letters PRESERVED (the real example is Russian). Media
 * names go through {@link mediaOutputFolderName} first (extension dropped).
 */
export function legacySetSlug(name: string): string {
  const slug = name
    .replace(/ /g, '_')
    .replace(/[\\/:\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_');
  return slug || 'imported-set';
}

/**
 * Pair a directory's `time[…]` chunk media files against its `time[…]` jsons
 * (union of bases, first name per base wins). `full.<ext>` counts too
 * (offset 0 — a single-file legacy recording). Returns the pairs sorted by
 * offset (nulls last, then name) — the raw.md ordering.
 */
export function pairLegacyChunks(
  fileNames: readonly string[],
  mediaExtensions: readonly string[] = DEFAULT_MEDIA_EXTENSIONS
): LegacyChunkPair[] {
  const mediaByBase = new Map<string, string>();
  const jsonByBase = new Map<string, string>();
  for (const name of fileNames) {
    const base = getBaseName(name);
    if (parseOffsetFromFilename(base) === null) {
      continue; // not a `time[…]` / `full` chunk name (raw.md, list.txt, …)
    }
    if (hasExtension(name, mediaExtensions)) {
      if (!mediaByBase.has(base)) {
        mediaByBase.set(base, name);
      }
    } else if (hasExtension(name, [TRANSCRIPT_EXTENSION])) {
      if (!jsonByBase.has(base)) {
        jsonByBase.set(base, name);
      }
    }
  }

  const bases = new Set<string>([...mediaByBase.keys(), ...jsonByBase.keys()]);
  const pairs: LegacyChunkPair[] = [];
  for (const base of bases) {
    const pair: LegacyChunkPair = { base, offsetMs: parseOffsetFromFilename(base) };
    const mediaName = mediaByBase.get(base);
    if (mediaName !== undefined) {
      pair.mediaName = mediaName;
    }
    const jsonName = jsonByBase.get(base);
    if (jsonName !== undefined) {
      pair.jsonName = jsonName;
    }
    pairs.push(pair);
  }
  pairs.sort((a, b) => {
    if (a.offsetMs === null && b.offsetMs === null) {
      return a.base.localeCompare(b.base, undefined, { numeric: true });
    }
    if (a.offsetMs === null) {
      return 1;
    }
    if (b.offsetMs === null) {
      return -1;
    }
    if (a.offsetMs !== b.offsetMs) {
      return a.offsetMs - b.offsetMs;
    }
    return a.base.localeCompare(b.base, undefined, { numeric: true });
  });
  return pairs;
}

/** True when the pairing has at least one COMPLETE (media + json) pair. */
function isChunkListing(pairs: readonly LegacyChunkPair[]): boolean {
  return pairs.some(pair => pair.mediaName !== undefined && pair.jsonName !== undefined);
}

/** Build the plan for one chunk dir (+ optional source media next to it). */
function buildPlan(
  chunkDir: ScannedDirectory,
  pairs: LegacyChunkPair[],
  source?: { path: string; name: string }
): LegacyImportPlan {
  const warnings: LegacyImportWarning[] = [];
  for (const pair of pairs) {
    if (pair.jsonName === undefined) {
      warnings.push({
        code: 'missing-json',
        base: pair.base,
        message: `Chunk "${pair.base}" has no transcript json — it will import as not-yet-transcribed.`
      });
    } else if (pair.mediaName === undefined) {
      warnings.push({
        code: 'orphan-json',
        base: pair.base,
        message: `Transcript "${pair.base}.json" has no matching audio chunk — its text imports without audio.`
      });
    }
  }
  const hasLegacyRawMd = chunkDir.files.includes(RAW_MD_FILE_NAME);
  if (!hasLegacyRawMd) {
    warnings.push({
      code: 'no-raw-md',
      message: 'The legacy folder has no raw.md — one will be generated from the imported segments.'
    });
  }
  if (!source) {
    warnings.push({
      code: 'no-source-media',
      message: 'No source media file was found next to the chunk folder — the set imports without a source reference.'
    });
  }

  const displayName = source?.name ?? chunkDir.name;
  const slug = legacySetSlug(source ? mediaOutputFolderName(source.name) : chunkDir.name);
  const folders = transcriptSetFolders(slug);
  const plan: LegacyImportPlan = {
    chunkDir: chunkDir.path,
    chunkDirName: chunkDir.name,
    displayName,
    slug,
    targets: {
      setFolder: transcriptSetFolder(slug),
      audioFolder: folders.audioFolder,
      transcriptFolder: folders.transcriptFolder,
      sidecarPath: transcriptsetRelPath(slug),
      rawMdPath: rawMdRelPath(slug)
    },
    pairs,
    completePairs: pairs.filter(pair => pair.mediaName !== undefined && pair.jsonName !== undefined).length,
    hasLegacyRawMd,
    warnings
  };
  if (source) {
    plan.sourceMediaPath = source.path;
    plan.sourceMediaName = source.name;
  }
  if (hasLegacyRawMd) {
    plan.legacyRawMdPath = joinPath(chunkDir.path, RAW_MD_FILE_NAME);
  }
  return plan;
}

/**
 * Apply detection rules 1 (media + sibling chunk dir) and 2 (unclaimed chunk
 * dir) WITHIN one directory. Rule 3 (root-is-chunk-dir) is handled by
 * {@link detectLegacyTranscriptSets}.
 */
function detectWithin(dir: ScannedDirectory, mediaExtensions: readonly string[]): LegacyImportPlan[] {
  const plans: LegacyImportPlan[] = [];
  const claimed = new Set<string>();
  const subdirByName = new Map<string, ScannedDirectory>();
  for (const sub of dir.directories) {
    if (!subdirByName.has(sub.name)) {
      subdirByName.set(sub.name, sub);
    }
  }

  // Rule 1 — source media + sibling chunk dir named mediaOutputFolderName(media).
  const mediaFiles = dir.files
    .filter(name => hasExtension(name, mediaExtensions) && parseOffsetFromFilename(getBaseName(name)) === null)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const mediaName of mediaFiles) {
    const chunkDir = subdirByName.get(mediaOutputFolderName(mediaName));
    if (!chunkDir || claimed.has(chunkDir.path)) {
      continue;
    }
    const pairs = pairLegacyChunks(chunkDir.files, mediaExtensions);
    if (!isChunkListing(pairs)) {
      continue;
    }
    claimed.add(chunkDir.path);
    plans.push(buildPlan(chunkDir, pairs, { path: joinPath(dir.path, mediaName), name: mediaName }));
  }

  // Rule 2 — chunk dirs claimed by no media file.
  for (const sub of dir.directories) {
    if (claimed.has(sub.path)) {
      continue;
    }
    const pairs = pairLegacyChunks(sub.files, mediaExtensions);
    if (!isChunkListing(pairs)) {
      continue;
    }
    claimed.add(sub.path);
    plans.push(buildPlan(sub, pairs));
  }

  return plans;
}

/**
 * Detect the legacy transcript sets reachable from `root` (see the module doc
 * for the rules). Non-recursive by default; `scanChildDirectories` also applies
 * the rules one level down. Plans are de-duplicated by chunk-dir path; a set
 * detected at the root level (rules 1–3 on `root`) wins over the same chunk
 * dir re-detected inside a child scan.
 */
export function detectLegacyTranscriptSets(
  root: ScannedDirectory,
  options: DetectLegacySetsOptions = {}
): LegacyImportPlan[] {
  const mediaExtensions = options.mediaExtensions ?? DEFAULT_MEDIA_EXTENSIONS;
  const plans: LegacyImportPlan[] = [];
  const seen = new Set<string>();
  const push = (candidates: LegacyImportPlan[]): void => {
    for (const plan of candidates) {
      if (!seen.has(plan.chunkDir)) {
        seen.add(plan.chunkDir);
        plans.push(plan);
      }
    }
  };

  // Rule 3 — the user picked the chunk dir itself.
  const rootPairs = pairLegacyChunks(root.files, mediaExtensions);
  if (isChunkListing(rootPairs)) {
    push([buildPlan(root, rootPairs)]);
  }

  push(detectWithin(root, mediaExtensions));

  if (options.scanChildDirectories) {
    for (const sub of root.directories) {
      push(detectWithin(sub, mediaExtensions));
    }
  }

  return plans;
}
