/**
 * `raw.md` generation — the full-text ↔ segments SYNC surface of the
 * Transcript Check feature. Pure port of audio_transcript_check's
 * `generateRawMd` (`electron/main.cjs:122-223`), with the filesystem walk
 * lifted out: the caller supplies the set's files (each with its segments and
 * name-derived offset) and the speaker registry; this module DETERMINISTICALLY
 * flattens them into the `raw.md` text.
 *
 * LINE FORMAT (one line per segment):
 *   `HH:MM:SS.mmm: text`                — same speaker as the previous line;
 *   `HH:MM:SS.mmm [Speaker]: text`      — the speaker CHANGED on this line.
 * The timestamp is the segment's ABSOLUTE end time within the whole recording
 * (chunk offsets are END times — `fileStart = offset − chunkDuration`), and
 * the speaker label carries forward ACROSS files.
 *
 * SYNC GUARANTEE / RECONCILIATION: generation is a pure deterministic function
 * of (files, speakers), so `raw.md` can be regenerated at any time and two
 * runs over the same data are byte-identical. To reconcile a user's edits to
 * `raw.md` back into segments, {@link parseRawMdLines} splits the text back
 * into `{time, speakerLabel?, text}` lines: each parsed line maps positionally
 * (and by its unique absolute timestamp) to one segment, so an edited line's
 * `text` is written back to its segment via `recordSegmentTextChange` (which
 * records a capped history entry) and `raw.md` is regenerated — segments stay
 * the single source of truth; `raw.md` is a projection.
 */

import { TranscriptSegment } from './transcript-metadata';
import { TranscriptSpeaker, resolveSegmentSpeakerLabel, speakerNameById } from './transcript-speakers';

/** One transcript file feeding {@link generateRawMd}. */
export interface RawMdSourceFile {
  /** The file's base or file name — the deterministic tiebreaker for ordering. */
  name: string;
  /**
   * Absolute chunk offset in ms (`parseOffsetFromFilename`), or null when the
   * name carries none. Source-app convention: the offset is the chunk's END
   * time within the whole recording.
   */
  offsetMs: number | null;
  segments: readonly TranscriptSegment[];
}

/** Format seconds as `HH:MM:SS.mmm` (port of `main.cjs` `formatTimeAbsolute`). */
export function formatTimeAbsolute(totalSeconds: number): string {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const wholeSecs = Math.floor(secs);
  const ms = Math.round((secs - wholeSecs) * 1000);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${wholeSecs
    .toString()
    .padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

/** Coerce a possibly-string `start`/`end` to a finite number (0 fallback). */
function toSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Order files the way `generateRawMd` walks them: known offsets first
 * (ascending), offset-less files last sorted by name. Returns a new array.
 */
export function sortRawMdFiles<T extends Pick<RawMdSourceFile, 'name' | 'offsetMs'>>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => {
    if (a.offsetMs === null && b.offsetMs === null) {
      return a.name.localeCompare(b.name);
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
    return a.name.localeCompare(b.name);
  });
}

/**
 * Flatten a set's transcript files into the `raw.md` text (see the module doc
 * for the line format). Deterministic in its inputs:
 *  - files are ordered via {@link sortRawMdFiles};
 *  - per file, `fileStart = offsetSec − lastSegmentEnd` (offsets are chunk END
 *    times; an offset-less file is treated as offset 0, like the source);
 *  - each segment renders at `fileStart + segment.end` (absolute end time);
 *  - the speaker label resolves via the registry (explicit `speakerId` wins,
 *    legacy free-text fields as fallback) and CARRIES FORWARD across segments
 *    AND files — the `[Speaker]` marker is emitted only when the effective
 *    label CHANGES.
 *
 * Returns '' when no file contributes a segment; otherwise the joined lines
 * with a trailing newline (the on-disk `raw.md` shape).
 */
export function generateRawMd(files: readonly RawMdSourceFile[], speakers: readonly TranscriptSpeaker[]): string {
  const speakerById = speakerNameById(speakers);
  const lines: string[] = [];
  let lastSpeakerLabel = '';

  for (const file of sortRawMdFiles(files)) {
    const segments = Array.isArray(file.segments as unknown[]) ? file.segments : [];
    if (segments.length === 0) {
      continue;
    }
    // Chunk duration from the last segment's end; offset is the chunk's END
    // time, so the chunk STARTS at offset − duration.
    const lastSegment = segments[segments.length - 1];
    const fileDuration = lastSegment ? toSeconds(lastSegment.end) : 0;
    const offsetSeconds = (file.offsetMs ?? 0) / 1000;
    // DEVIATION from the source (`main.cjs:193`): a zero/unknown offset anchors
    // the file at 0 instead of `0 − duration` — the source's formula produced
    // NEGATIVE timestamps for `full.json` (a whole recording starts at 0; only
    // a positive chunk-END offset places the chunk later in the recording).
    const fileStartTime = offsetSeconds > 0 ? offsetSeconds - fileDuration : 0;

    for (const segment of segments) {
      const segmentEnd = toSeconds(segment.end);
      const absoluteTime = fileStartTime + segmentEnd;
      const timeStr = formatTimeAbsolute(absoluteTime);
      const text = typeof segment.text === 'string' ? segment.text : '';

      const explicitSpeakerLabel = resolveSegmentSpeakerLabel(segment, speakerById);
      const effectiveSpeakerLabel = explicitSpeakerLabel || lastSpeakerLabel;
      const speakerChanged = !!effectiveSpeakerLabel && effectiveSpeakerLabel !== lastSpeakerLabel;
      const speakerPrefix = speakerChanged ? ` [${effectiveSpeakerLabel}]` : '';

      lines.push(`${timeStr}${speakerPrefix}: ${text}`);
      if (effectiveSpeakerLabel) {
        lastSpeakerLabel = effectiveSpeakerLabel;
      }
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/** One parsed `raw.md` line — the reconcile surface back to segments. */
export interface RawMdParsedLine {
  /** The line verbatim. */
  raw: string;
  /** `HH:MM:SS.mmm` when the line matches the generated shape. */
  time?: string;
  /** The `[Speaker]` label when this line marked a speaker change. */
  speakerLabel?: string;
  /** The segment text (for a non-matching line, the whole line). */
  text: string;
}

const RAW_MD_LINE = /^(\d{2}:\d{2}:\d{2}\.\d{3})(?: \[([^\]]+)\])?: (.*)$/;

/**
 * Split `raw.md` text back into parsed lines. Every non-empty line yields one
 * entry: lines matching the generated `HH:MM:SS.mmm [Speaker]: text` shape
 * carry `time` (+ `speakerLabel` on speaker-change lines); a foreign/edited
 * line that lost its timestamp still surfaces with just `raw`/`text` so a
 * reconciler can flag it. Parsed lines map positionally (and by their unique
 * timestamps) onto the segment sequence {@link generateRawMd} flattened —
 * write an edited `text` back via `recordSegmentTextChange` and regenerate.
 */
export function parseRawMdLines(text: string): RawMdParsedLine[] {
  const parsed: RawMdParsedLine[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim().length === 0) {
      continue;
    }
    const match = raw.match(RAW_MD_LINE);
    if (!match) {
      parsed.push({ raw, text: raw });
      continue;
    }
    const entry: RawMdParsedLine = { raw, time: match[1], text: match[3] };
    if (match[2] !== undefined) {
      entry.speakerLabel = match[2];
    }
    parsed.push(entry);
  }
  return parsed;
}
