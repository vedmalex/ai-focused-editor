/**
 * Pure, book-native pairing/progress logic for the Transcript Check feature —
 * the transcript analogue of `proofreading-model.ts` (same conventions:
 * workspace-relative paths, Theia/Node/DOM-free, bun-testable).
 *
 * A transcript "set" pairs one MEDIA folder (audio AND/OR video files) against
 * one transcript folder (`<base>.json` next to each `<base>.<media-ext>`).
 * Chunked recordings encode their absolute position in the media file NAME
 * (`time[HH:MM:SS][OFFSET]` — {@link parseOffsetFromFilename}, ported from
 * audio_transcript_check `electron/main.cjs:64-89`).
 */

import { getBaseName } from './proofreading-model';

/**
 * Default media extensions (owner decision: AUDIO and VIDEO). Lowercase,
 * dot-prefixed, matched case-insensitively.
 */
export const DEFAULT_MEDIA_EXTENSIONS: readonly string[] = [
  // Audio
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  // Video
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.m4v'
];

/** The transcript sidecar extension: `<base>.json` next to `<base>.<media-ext>`. */
export const TRANSCRIPT_EXTENSION = '.json';

/** Fixed basename of the per-set transcript sidecar the open handler recognizes. */
export const TRANSCRIPTSET_FILE_NAME = 'transcriptset.yaml';

/**
 * Per-file verified/rework state, keyed by media BASE name (never by index —
 * the same folder-reorder-proof keying as `ProofreadingPage`).
 */
export interface TranscriptFileState {
  /** Basename shared by the media file and its transcript json (e.g. `time[00:10:00]`). */
  base: string;
  /** The writer has confirmed this file's transcript is correct. */
  verified: boolean;
  /** The writer flagged this file as needing more work. */
  needsRework: boolean;
}

/**
 * A transcript "set": one media folder paired against one transcript folder.
 * All folder paths are workspace-relative. Serialized via
 * `transcript-sidecar.ts` into `transcription/<slug>/transcriptset.yaml`.
 */
export interface TranscriptSet {
  /** Workspace-relative folder holding the audio/video files. */
  audioFolder: string;
  /** Workspace-relative folder holding the `<base>.json` transcripts. */
  transcriptFolder: string;
  /** Accepted media file extensions (lowercase, dot-prefixed). */
  mediaExtensions: string[];
  /** BCP-47-ish language hint for STT (e.g. `ru`, `en`); empty = auto. */
  language?: string;
  /**
   * ABSOLUTE path of the original source media (or, for a referenced legacy
   * import, its external chunk directory). Informational: records where the
   * set's audio came from so a transcription can be re-run; the source itself
   * is NOT copied into the book (owner decision).
   */
  sourceMedia?: string;
  /** Per-file verified/rework state, keyed by base name. */
  files: TranscriptFileState[];
}

/**
 * One resolved media↔transcript pairing, keyed by BASE name. The driving
 * basename set is the UNION of media and transcript files (the improved
 * `matchPairs` semantics) so an orphan transcript still surfaces. All paths are
 * workspace-relative (`<folder>/<name>`).
 */
export interface TranscriptPair {
  base: string;
  /**
   * Workspace-relative path to the media file — present ONLY when a media file
   * matched this base (absent for an orphan transcript).
   */
  mediaRelPath?: string;
  /**
   * Workspace-relative path to the transcript json. When a matching transcript
   * exists it is that file's real path; when `missing`, it is the EXPECTED path
   * `<transcriptFolder>/<base>.json` where the transcript would be created.
   */
  transcriptRelPath: string;
  /** True when no transcript json matched this base (not yet transcribed). */
  missing: boolean;
  /**
   * Absolute chunk offset parsed from the base name
   * ({@link parseOffsetFromFilename}), milliseconds; null when the name carries
   * no offset. NOTE (source-app convention): the offset is the END time of the
   * chunk within the whole recording, not its start.
   */
  offsetMs: number | null;
}

/** Folder context {@link matchTranscriptPairs} threads in to build relative paths. */
export interface TranscriptSetFolders {
  audioFolder: string;
  transcriptFolder: string;
}

/**
 * True when a path points at a transcript sidecar: its basename is
 * `transcriptset.yaml` AND a `transcription/` folder appears somewhere on the
 * path (mirror of `isProofsetPath`). Pure path derivation — accepts a POSIX
 * path or a `file://` URI path string.
 */
export function isTranscriptsetPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter(segment => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  if (segments[segments.length - 1] !== TRANSCRIPTSET_FILE_NAME) {
    return false;
  }
  return segments.slice(0, -1).includes('transcription');
}

/**
 * Parse the absolute chunk offset encoded in a chunk file name. Port of
 * audio_transcript_check `electron/main.cjs:64-89` (`parseOffsetFromFilename`),
 * generalized: the source matched only `*.json`; this accepts a bare base name
 * or any single trailing extension (media or transcript). Returns
 * MILLISECONDS (the source worked in seconds; both the `HH:MM:SS` clock and
 * the explicit `[SECONDS]` bracket are converted), or null when the name
 * carries no recognizable offset. Supported shapes:
 *  - `time[HH:MM:SS][SECONDS](.ext)` → explicit seconds × 1000 (wins);
 *  - `time[HH:MM:SS](.ext)`          → clock time in ms;
 *  - `full(.ext)`                    → 0 (single-file recording).
 *
 * NOTE (source-app convention): the offset is the chunk's END time within the
 * whole recording — `raw-md.ts` subtracts the chunk duration to place segments.
 */
export function parseOffsetFromFilename(filename: string): number | null {
  const name = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  if (/^full(?:\.[^.]+)?$/i.test(name)) {
    return 0;
  }

  const timeMatch = name.match(/time\[(\d{2}):(\d{2}):(\d{2})\](?:\[(\d+)\])?(?:\.[^.\]]+)?$/);
  if (!timeMatch) {
    return null;
  }

  const hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2], 10);
  const seconds = parseInt(timeMatch[3], 10);
  const explicitOffsetSeconds = timeMatch[4] ? parseInt(timeMatch[4], 10) : null;

  if (explicitOffsetSeconds !== null) {
    return explicitOffsetSeconds * 1000;
  }

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/** Case-insensitive "does this filename end with one of these extensions". */
function hasExtension(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some(ext => lower.endsWith(ext.toLowerCase()));
}

/**
 * Pair media files against transcript jsons by BASE name (union-of-basenames,
 * the improved `matchPairs` semantics):
 *  - The DRIVING basename set is the UNION of matching media files and
 *    transcript jsons — a media file without a transcript yields a `missing`
 *    pair; an orphan transcript (media deleted/renamed) still surfaces with no
 *    `mediaRelPath`.
 *  - Each folder is indexed base→name (FIRST file per base wins, deterministic
 *    on duplicates); media filter by `mediaExts`, transcripts by `.json`.
 *  - `transcriptRelPath` is always present: the matched file's real path, or
 *    the EXPECTED `<transcriptFolder>/<base>.json` when `missing`.
 *  - Result sorted by chunk offset (known offsets first, ascending — the
 *    `generateRawMd` ordering), ties and offset-less names by numeric-aware
 *    base compare.
 */
export function matchTranscriptPairs(
  mediaNames: string[],
  transcriptNames: string[],
  folders: TranscriptSetFolders,
  mediaExts: readonly string[] = DEFAULT_MEDIA_EXTENSIONS
): TranscriptPair[] {
  const firstByBase = (names: readonly string[], exts: readonly string[]): Map<string, string> => {
    const map = new Map<string, string>();
    for (const name of names) {
      if (!hasExtension(name, exts)) {
        continue;
      }
      const base = getBaseName(name);
      if (!map.has(base)) {
        map.set(base, name);
      }
    }
    return map;
  };

  const mediaByBase = firstByBase(mediaNames, mediaExts);
  const transcriptByBase = firstByBase(transcriptNames, [TRANSCRIPT_EXTENSION]);

  const driverBases = new Set<string>();
  for (const base of mediaByBase.keys()) {
    driverBases.add(base);
  }
  for (const base of transcriptByBase.keys()) {
    driverBases.add(base);
  }

  const pairs: TranscriptPair[] = [];
  for (const base of driverBases) {
    const mediaName = mediaByBase.get(base);
    const transcriptName = transcriptByBase.get(base);
    const pair: TranscriptPair = {
      base,
      transcriptRelPath: `${folders.transcriptFolder}/${transcriptName ?? `${base}${TRANSCRIPT_EXTENSION}`}`,
      missing: transcriptName === undefined,
      offsetMs: parseOffsetFromFilename(base)
    };
    if (mediaName !== undefined) {
      pair.mediaRelPath = `${folders.audioFolder}/${mediaName}`;
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

/** Verified/rework progress over a set's files. `percent` rounds and is 0 when empty. */
export function computeTranscriptProgress(files: readonly Pick<TranscriptFileState, 'verified' | 'needsRework'>[]): {
  verified: number;
  needsRework: number;
  total: number;
  percent: number;
} {
  const total = files.length;
  let verified = 0;
  let needsRework = 0;
  for (const file of files) {
    if (file.verified) {
      verified++;
    }
    if (file.needsRework) {
      needsRework++;
    }
  }
  const percent = total === 0 ? 0 : Math.round((verified / total) * 100);
  return { verified, needsRework, total, percent };
}

/**
 * Filled-segments progress over one transcript's segments (the alternate N/M
 * the progress chip can show): a segment counts as filled when its text is
 * non-blank.
 */
export function computeSegmentFillProgress(segments: readonly { text?: unknown }[]): {
  filled: number;
  total: number;
  percent: number;
} {
  const total = segments.length;
  let filled = 0;
  for (const segment of segments) {
    if (typeof segment.text === 'string' && segment.text.trim().length > 0) {
      filled++;
    }
  }
  const percent = total === 0 ? 0 : Math.round((filled / total) * 100);
  return { filled, total, percent };
}

/**
 * Compact, locale-neutral progress chip (`N/M ✓`) — same shape as the
 * proofreading chip so the two features read identically in the tree.
 * Feed it either verified-files progress ({@link computeTranscriptProgress})
 * or filled-segments progress ({@link computeSegmentFillProgress} via
 * `{verified: filled, total}`).
 */
export function formatTranscriptProgressChip(progress: { verified: number; total: number }): string {
  return `${progress.verified}/${progress.total} ✓`;
}

/**
 * The 13 valid playback rates (audio_transcript_check `src/constants.js`):
 * step 1/8 up to 1×, 1/3 from 1× to 2×, 1/2 from 2× to 3×, then 4×.
 */
export const VALID_PLAYBACK_RATES: readonly number[] = [
  1 / 4,
  3 / 8,
  1 / 2,
  5 / 8,
  3 / 4,
  7 / 8,
  1,
  4 / 3,
  5 / 3,
  2,
  5 / 2,
  3,
  4
];
