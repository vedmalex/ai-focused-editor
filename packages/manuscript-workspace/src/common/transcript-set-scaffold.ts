/**
 * Pure (Theia-free) scaffolding logic for CREATING a transcript set — the
 * transcript analogue of `proofreading-scaffold.ts`: deriving the book-native
 * folder layout from a slug and building a fresh {@link TranscriptSet}
 * skeleton (optionally seeding `files[]` from media names already dropped into
 * the audio folder).
 *
 * FOLDER CONVENTION (owner decision):
 *  - media (audio/video) lives under `sources/audio/<slug>/` (fits the
 *    `sources/` scaffold, like proofreading scans under `sources/scans/`);
 *  - the working copy lives under a dedicated `transcription/<slug>/` area:
 *    `transcripts/` (the `<base>.json` files), `transcriptset.yaml` (sidecar),
 *    `speakers.yaml` (speaker registry), `raw.md` (the flattened full text).
 */

import { getBaseName } from './proofreading-model';
import { SPEAKERS_FILE_NAME } from './transcript-speakers';
import {
  DEFAULT_MEDIA_EXTENSIONS,
  TRANSCRIPTSET_FILE_NAME,
  TranscriptFileState,
  TranscriptSet,
  parseOffsetFromFilename
} from './transcript-set-model';

/** The book-native area holding transcript working copies + sidecars. */
export const TRANSCRIPTION_AREA = 'transcription';

/** The book-native area holding the source media (under `sources/`). */
export const AUDIO_SOURCES_AREA = 'sources/audio';

/** Fixed basename of the per-set flattened full-text file. */
export const RAW_MD_FILE_NAME = 'raw.md';

/** The two workspace-relative folders a transcript set is built from. */
export interface TranscriptSetLayout {
  /** Where the audio/video files live: `sources/audio/<slug>`. */
  audioFolder: string;
  /** Where the `<base>.json` transcripts live: `transcription/<slug>/transcripts`. */
  transcriptFolder: string;
}

/** Derive the workspace-relative folder layout for a set from its slug. */
export function transcriptSetFolders(slug: string): TranscriptSetLayout {
  return {
    audioFolder: `${AUDIO_SOURCES_AREA}/${slug}`,
    transcriptFolder: `${TRANSCRIPTION_AREA}/${slug}/transcripts`
  };
}

/** The set's working-copy folder: `transcription/<slug>`. */
export function transcriptSetFolder(slug: string): string {
  return `${TRANSCRIPTION_AREA}/${slug}`;
}

/** The set's sidecar path: `transcription/<slug>/transcriptset.yaml`. */
export function transcriptsetRelPath(slug: string): string {
  return `${TRANSCRIPTION_AREA}/${slug}/${TRANSCRIPTSET_FILE_NAME}`;
}

/** The set's speaker registry path: `transcription/<slug>/speakers.yaml`. */
export function speakersRelPath(slug: string): string {
  return `${TRANSCRIPTION_AREA}/${slug}/${SPEAKERS_FILE_NAME}`;
}

/** The set's flattened full-text path: `transcription/<slug>/raw.md`. */
export function rawMdRelPath(slug: string): string {
  return `${TRANSCRIPTION_AREA}/${slug}/${RAW_MD_FILE_NAME}`;
}

/**
 * Case-insensitive "does this filename end with one of these extensions" —
 * duplicated locally (like `proofreading-scaffold.ts`) so this module stays a
 * self-contained contract.
 */
function hasExtension(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some(ext => lower.endsWith(ext.toLowerCase()));
}

/**
 * Seed `files[]` from media file names: one entry per media basename (via
 * {@link getBaseName}), `verified`/`needsRework` both false, de-duplicated on
 * base (first wins) and sorted by chunk offset (known offsets ascending,
 * offset-less names last by numeric-aware base compare — the raw.md ordering).
 * Non-media names are ignored. When no media has been dropped yet the result
 * is `[]` and the widget populates on next open.
 */
export function seedFilesFromMediaNames(
  mediaNames: readonly string[],
  mediaExtensions: readonly string[] = DEFAULT_MEDIA_EXTENSIONS
): TranscriptFileState[] {
  const seen = new Set<string>();
  const files: TranscriptFileState[] = [];
  for (const name of mediaNames) {
    if (!hasExtension(name, mediaExtensions)) {
      continue;
    }
    const base = getBaseName(name);
    if (seen.has(base)) {
      continue;
    }
    seen.add(base);
    files.push({ base, verified: false, needsRework: false });
  }
  files.sort((a, b) => {
    const aOffset = parseOffsetFromFilename(a.base);
    const bOffset = parseOffsetFromFilename(b.base);
    if (aOffset === null && bOffset === null) {
      return a.base.localeCompare(b.base, undefined, { numeric: true });
    }
    if (aOffset === null) {
      return 1;
    }
    if (bOffset === null) {
      return -1;
    }
    if (aOffset !== bOffset) {
      return aOffset - bOffset;
    }
    return a.base.localeCompare(b.base, undefined, { numeric: true });
  });
  return files;
}

/** Inputs for {@link buildTranscriptsetSkeleton}. */
export interface BuildTranscriptSetInput {
  /** The set slug (folder name) — drives all derived paths. */
  slug: string;
  /** Media file names already present in the audio folder, to seed `files[]`. */
  mediaNames?: readonly string[];
  /** Override the default media extensions (defaults to {@link DEFAULT_MEDIA_EXTENSIONS}). */
  mediaExtensions?: string[];
  /** STT language hint (e.g. `ru`); omitted = auto-detect. */
  language?: string;
}

/**
 * Build a fresh {@link TranscriptSet} for a new set: the derived folders, the
 * default (or overridden) media extensions, and `files[]` seeded from any media
 * already dropped into the audio folder. The result serializes straight through
 * `writeTranscriptsetYaml` into `transcription/<slug>/transcriptset.yaml`.
 */
export function buildTranscriptsetSkeleton(input: BuildTranscriptSetInput): TranscriptSet {
  const mediaExtensions =
    input.mediaExtensions && input.mediaExtensions.length > 0 ? input.mediaExtensions.slice() : [...DEFAULT_MEDIA_EXTENSIONS];
  const folders = transcriptSetFolders(input.slug);
  const language = input.language?.trim();
  return {
    audioFolder: folders.audioFolder,
    transcriptFolder: folders.transcriptFolder,
    mediaExtensions,
    ...(language ? { language } : {}),
    files: seedFilesFromMediaNames(input.mediaNames ?? [], mediaExtensions)
  };
}
