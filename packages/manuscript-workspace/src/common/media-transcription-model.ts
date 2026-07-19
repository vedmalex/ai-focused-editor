/**
 * Pure logic of the media-transcription pipeline — the bun-testable half of the
 * Phase-2 backend port of the owner's local toolchain:
 *
 *  - `/Users/vedmalex/work/AI/converter/lib/converter.ts` (silence-aligned MP3
 *    segmentation: naming, silence parsing, cut-point selection);
 *  - `/Users/vedmalex/work/AI/whisper.cpp/processing/process_videos_unified.sh`
 *    (`normalize_json_to_segments_format`, the jq at ~lines 312-373, ported
 *    verbatim into {@link normalizeWhisperJson});
 *  - `/Users/vedmalex/work/AI/converter/lib/parse.ts` (the `parse --dir
 *    --merge` step that produced the toolchain's `raw.md`).
 *
 * Everything here is Theia/Node/DOM-free (same conventions as
 * `transcript-set-model.ts`); the child-process orchestration lives in
 * `node/node-audio-conversion-service.ts`.
 *
 * NOTE on `raw.md`: the toolchain's `raw.md` (`converter parse --dir --merge`)
 * is NOT the same text as the editor's `raw-md.ts` `generateRawMd` — the
 * toolchain stamps each line with the segment START time (continuity carried by
 * the previous file's last segment END), appends a final end-time line per
 * file, and joins file blocks with a blank line, while `generateRawMd` stamps
 * absolute END times and supports speaker labels. This module ports the
 * TOOLCHAIN format faithfully ({@link mergeTranscriptionsToRawMd}) so the
 * pipeline's `raw.md` is byte-compatible with the unified.sh output; the editor
 * keeps regenerating its own projection from segments via `raw-md.ts`.
 */

/* ------------------------------------------------------------------------- *
 * Segment naming (converter.ts `secondsToHHMMSS`)
 * ------------------------------------------------------------------------- */

/**
 * Segment base name for a cut ENDING at `endTimeSeconds` — exact port of
 * converter.ts `secondsToHHMMSS`: `time[HH:MM:SS][<endTimeSeconds>]` where the
 * bracketed offset is the UNPADDED integer seconds (e.g. 623 →
 * `time[00:10:23][623]`). Interops with the editor's
 * `parseOffsetFromFilename` (`transcript-set-model.ts`), which reads the
 * explicit `[SECONDS]` bracket back as ms. Callers pass integer seconds (the
 * converter always did — `Math.ceil` cut points and `Math.ceil` durations);
 * fractional input is floored into the clock AND the bracket to preserve the
 * name↔offset round-trip.
 */
export function segmentBaseNameForEndTime(endTimeSeconds: number): string {
  const duration = Math.floor(endTimeSeconds);
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = Math.floor(duration % 60);

  const paddedHours = String(hours).padStart(2, '0');
  const paddedMinutes = String(minutes).padStart(2, '0');
  const paddedSeconds = String(seconds).padStart(2, '0');

  return `time[${paddedHours}:${paddedMinutes}:${paddedSeconds}][${duration}]`;
}

/**
 * Output folder base for one input media file — port of converter.ts
 * `getFilename`: the basename with spaces replaced by underscores and the
 * (single, final) extension stripped.
 */
export function mediaOutputFolderName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const baseName = (normalized.split('/').pop() ?? normalized).replace(/ /g, '_');
  const dotIndex = baseName.lastIndexOf('.');
  return dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
}

/* ------------------------------------------------------------------------- *
 * Silence parsing + cut-point selection (converter.ts `parseSilenceInfo`)
 * ------------------------------------------------------------------------- */

/** One silence interval reconstructed from ffmpeg `silencedetect` stderr. */
interface SilenceInfo {
  type?: 'start' | 'end';
  start?: number;
  end?: number;
  duration?: number;
}

/**
 * Port of converter.ts `parseSilenceInfo`: take the ffmpeg `silencedetect`
 * stderr lines and pick ONE cut point per `segmentSeconds` bucket — the
 * `Math.ceil` of the LAST silence START in each `floor(start / segmentSeconds)`
 * bucket — sorted ascending, zeros dropped. Faithful quirks preserved:
 *  - a trailing `silence_start` without a matching `silence_end` still
 *    participates (the source pushed the bare start entry);
 *  - an `end` line only pairs when the preceding entry carried a `start`;
 *  - `filter(Boolean)` drops a 0 cut point.
 */
export function selectSilenceCutPoints(lines: readonly string[], segmentSeconds: number): number[] {
  const startRe = /silence_start: (\d+(\.\d+)?)/i;
  const endRe = /silence_end: (\d+(\.\d+)?)/i;
  const durationRe = /silence_duration: (\d+(\.\d+)?)/i;

  const parsed = lines.map((line): SilenceInfo => {
    const isStart = line.match(startRe);
    const isEnd = line.match(endRe);
    const durationMatch = line.match(durationRe);

    if (isStart?.[1]) {
      return { type: 'start', start: parseFloat(isStart[1]) };
    }
    if (isEnd?.[1] && durationMatch?.[1]) {
      return { type: 'end', end: parseFloat(isEnd[1]), duration: parseFloat(durationMatch[1]) };
    }
    return {};
  });

  const silenceInfo: SilenceInfo[] = [];
  for (const cur of parsed) {
    if (cur.type === 'start') {
      silenceInfo.push(cur);
    } else if (cur.type === 'end' && cur.end && cur.duration) {
      const last = silenceInfo.pop();
      if (last?.start !== undefined) {
        silenceInfo.push({ start: last.start, duration: cur.duration, end: cur.end });
      }
    }
  }

  const groups = new Map<number, SilenceInfo[]>();
  for (const item of silenceInfo) {
    const key = Math.floor((item.start || 0) / segmentSeconds);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  const cutPoints: number[] = [];
  for (const bucket of groups.values()) {
    const lastItem = bucket[bucket.length - 1];
    cutPoints.push(lastItem?.start ? Math.ceil(lastItem.start) : 0);
  }

  return cutPoints.filter(Boolean).sort((a, b) => a - b);
}

/** One planned segment interval (seconds within the source media). */
export interface PlannedSegment {
  startSec: number;
  endSec: number;
  /** Base name without extension (`time[HH:MM:SS][SEC]`). */
  baseName: string;
}

/**
 * Turn cut points + total duration into the segment plan — the loop logic of
 * converter.ts `processFiles` for long files: ensure at least one cut (the full
 * duration), append the duration when the last cut falls short of it, and skip
 * inverted/empty intervals.
 */
export function planSegments(durationSeconds: number, cutPoints: readonly number[]): PlannedSegment[] {
  const cuts = [...cutPoints];
  if (cuts.length === 0) {
    cuts.push(durationSeconds);
  }
  if (cuts[cuts.length - 1] < durationSeconds) {
    cuts.push(durationSeconds);
  }

  const segments: PlannedSegment[] = [];
  let startTime = 0;
  for (const endTime of cuts) {
    if (endTime <= startTime) {
      continue;
    }
    segments.push({ startSec: startTime, endSec: endTime, baseName: segmentBaseNameForEndTime(endTime) });
    startTime = endTime;
  }
  return segments;
}

/* ------------------------------------------------------------------------- *
 * Whisper-JSON normalization (unified.sh `normalize_json_to_segments_format`)
 * ------------------------------------------------------------------------- */

/** One segment of the normalized transcription (the on-disk `<base>.json` shape). */
export interface NormalizedTranscriptionSegment {
  id: number;
  /** whisper.cpp keeps the segment offset here in MILLISECONDS (the jq did not divide). */
  seek: number;
  /** Seconds. */
  start: number;
  /** Seconds. */
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
}

/** The normalized transcription JSON the whole pipeline converges on. */
export interface NormalizedTranscription {
  text: string;
  language: string;
  segments: NormalizedTranscriptionSegment[];
}

/** jq `//` alternative: right side when the left is `null` (or jq `false`). */
function jqAlt<T>(value: unknown, fallback: T): T | unknown {
  return value === null || value === undefined || value === false ? fallback : value;
}

/** jq `tonumber? // 0`: numbers pass, fully-numeric strings parse, anything else → 0. */
function toNumberOrZero(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * jq `toks`: numbers pass through, `{id}` objects contribute their numeric id
 * (dropped when the id is not numeric), everything else is dropped.
 */
function coerceTokens(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tokens: number[] = [];
  for (const entry of value) {
    if (typeof entry === 'number') {
      tokens.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === 'object' && 'id' in (entry as Record<string, unknown>)) {
      const id = (entry as Record<string, unknown>)['id'];
      const numeric =
        typeof id === 'number'
          ? id
          : typeof id === 'string' && id.trim() !== ''
            ? Number(id)
            : NaN;
      if (Number.isFinite(numeric)) {
        tokens.push(numeric);
      }
    }
  }
  return tokens;
}

/** jq `gsub("^ +| +$"; "")` — trims SPACES only (not all whitespace). */
function trimSpaces(value: string): string {
  return value.replace(/^ +| +$/g, '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function languageOf(root: Record<string, unknown>): string {
  const result = asRecord(root['result']);
  const params = asRecord(root['params']);
  return String(jqAlt(root['language'], jqAlt(result['language'], jqAlt(params['language'], 'auto'))));
}

/**
 * Normalize a whisper.cpp / Groq / already-normalized transcription JSON into
 * the `{text, language, segments[]}` shape — a faithful TS port of the jq
 * program in unified.sh `normalize_json_to_segments_format` (~lines 312-373):
 *
 *  - `transcription` present (whisper.cpp `-oj` output): segments come from
 *    `transcription[]`; `offsets.{from,to}` are MILLISECONDS — `start`/`end`
 *    divide by 1000, `seek` keeps the raw ms value (as the jq did); text is
 *    the space-joined segment texts, space-trimmed; language from
 *    `.result.language // .params.language // "auto"`.
 *  - `segments` present (Groq `verbose_json` OR an already-normalized file):
 *    values pass through with `tonumber? // 0` coercion and per-index id
 *    fallback — running the normalizer twice is a no-op (idempotent).
 *  - neither: text/language pass through, `segments: []`.
 */
export function normalizeWhisperJson(input: unknown): NormalizedTranscription {
  const root = asRecord(input);

  if ('transcription' in root) {
    const entries = Array.isArray(root['transcription']) ? (root['transcription'] as unknown[]) : [];
    const result = asRecord(root['result']);
    const params = asRecord(root['params']);
    const segments = entries.map((entry, index): NormalizedTranscriptionSegment => {
      const segment = asRecord(entry);
      const offsets = asRecord(segment['offsets']);
      const fromMs = toNumberOrZero(jqAlt(offsets['from'], 0));
      const toMs = toNumberOrZero(jqAlt(offsets['to'], 0));
      return {
        id: index,
        seek: fromMs,
        start: fromMs / 1000,
        end: toMs / 1000,
        text: String(jqAlt(segment['text'], '')),
        tokens: coerceTokens(segment['tokens']),
        temperature: 0,
        avg_logprob: 0,
        compression_ratio: 0,
        no_speech_prob: 0
      };
    });
    return {
      text: trimSpaces(entries.map(entry => String(jqAlt(asRecord(entry)['text'], ''))).join(' ')),
      language: String(jqAlt(result['language'], jqAlt(params['language'], 'auto'))),
      segments
    };
  }

  if ('segments' in root) {
    const entries = Array.isArray(root['segments']) ? (root['segments'] as unknown[]) : [];
    const joinedText = trimSpaces(entries.map(entry => String(jqAlt(asRecord(entry)['text'], ''))).join(' '));
    const segments = entries.map((entry, index): NormalizedTranscriptionSegment => {
      const segment = asRecord(entry);
      const idValue = jqAlt(segment['id'], index);
      return {
        id: typeof idValue === 'number' && Number.isFinite(idValue) ? idValue : toNumberOrZero(idValue),
        seek: toNumberOrZero(jqAlt(segment['seek'], 0)),
        start: toNumberOrZero(jqAlt(segment['start'], 0)),
        end: toNumberOrZero(jqAlt(segment['end'], 0)),
        text: String(jqAlt(segment['text'], '')),
        tokens: coerceTokens(segment['tokens']),
        temperature: toNumberOrZero(jqAlt(segment['temperature'], 0)),
        avg_logprob: toNumberOrZero(jqAlt(segment['avg_logprob'], 0)),
        compression_ratio: toNumberOrZero(jqAlt(segment['compression_ratio'], 0)),
        no_speech_prob: toNumberOrZero(jqAlt(segment['no_speech_prob'], 0))
      };
    });
    return {
      text: String(jqAlt(root['text'], joinedText)),
      language: languageOf(root),
      segments
    };
  }

  return {
    text: String(jqAlt(root['text'], '')),
    language: String(jqAlt(root['language'], 'auto')),
    segments: []
  };
}

/* ------------------------------------------------------------------------- *
 * raw.md merge (parse.ts `convertFile`/`convertDirectory` + cli `--merge`)
 * ------------------------------------------------------------------------- */

/** Format seconds as `HH:MM:SS.mmm` — port of parse.ts `formatTime` (floors the ms). */
export function formatRawMdTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millisecs = Math.floor((seconds % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millisecs).padStart(3, '0')}`;
}

/**
 * Port of parse.ts `extractStartTime`: the sort key the merge orders files by.
 * Matches `time[HH:MM:SS]` first (clock → seconds), then a bare
 * `time[<seconds>]`; null when the name carries neither.
 */
export function extractStartTimeFromName(filename: string): number | null {
  const timeMatch = filename.match(/time\[(\d{2}):(\d{2}):(\d{2})\]/);
  if (timeMatch) {
    return parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseInt(timeMatch[3], 10);
  }
  const secondsMatch = filename.match(/time\[(\d+(?:\.\d+)?)\]/);
  if (secondsMatch?.[1]) {
    return parseFloat(secondsMatch[1]);
  }
  return null;
}

/** One transcription feeding {@link mergeTranscriptionsToRawMd}. */
export interface RawMdMergeSource {
  /** The transcript file name (its `time[...]` prefix orders the merge). */
  name: string;
  /** The (normalized) transcription — only `segments[].{start,end,text}` are read. */
  data: Pick<NormalizedTranscription, 'segments'> | { segments?: readonly { start: number; end: number; text: string }[] };
}

/**
 * Port of parse.ts `convertFile` with the filesystem lifted out: render one
 * transcription into its text block, threading the running `lastEndTime`
 * continuity offset. Line format `HH:MM:SS.mmm: <trimmed text>` (timestamps
 * are segment STARTS shifted by `lastEndTime`), plus a final line holding the
 * shifted END time of the last segment. An empty/segment-less transcription
 * renders to an empty block and leaves `lastEndTime` unchanged (as the source
 * wrote an empty file).
 */
export function renderRawMdBlock(
  data: RawMdMergeSource['data'],
  lastEndTime: number
): { text: string; lastEndTime: number } {
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  if (segments.length === 0) {
    return { text: '', lastEndTime };
  }
  const lines = segments.map(segment => {
    const adjustedStart = (typeof segment.start === 'number' ? segment.start : 0) + lastEndTime;
    return `${formatRawMdTime(adjustedStart)}: ${String(segment.text ?? '').trim()}`;
  });
  const lastSegment = segments[segments.length - 1];
  const adjustedEndTime = (typeof lastSegment.end === 'number' ? lastSegment.end : 0) + lastEndTime;
  return {
    text: `${lines.join('\n')}\n${formatRawMdTime(adjustedEndTime)}`,
    lastEndTime: adjustedEndTime
  };
}

/**
 * Port of the toolchain's `parse --dir --merge` (`raw.md` step): order the
 * transcript files by {@link extractStartTimeFromName} (unknown-offset names
 * last, as the source's `?? Infinity`), render each with continuity via
 * {@link renderRawMdBlock}, and join the blocks with a blank line (the cli's
 * `allContent.join('\n\n')` — no trailing newline).
 *
 * DEVIATION (documented): the source cli re-sorted the intermediate `.txt`
 * files LEXICOGRAPHICALLY when joining; for the canonical `time[HH:MM:SS][S]`
 * names the lexicographic and chronological orders coincide, so this port uses
 * the chronological order for both continuity and joining.
 */
export function mergeTranscriptionsToRawMd(files: readonly RawMdMergeSource[]): string {
  const sorted = [...files].sort((a, b) => {
    const timeA = extractStartTimeFromName(a.name) ?? Infinity;
    const timeB = extractStartTimeFromName(b.name) ?? Infinity;
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    return a.name.localeCompare(b.name);
  });

  const blocks: string[] = [];
  let lastEndTime = 0;
  for (const file of sorted) {
    const rendered = renderRawMdBlock(file.data, lastEndTime);
    blocks.push(rendered.text);
    lastEndTime = rendered.lastEndTime;
  }
  return blocks.join('\n\n');
}
