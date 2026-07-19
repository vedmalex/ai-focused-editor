/**
 * The Transcript Check domain model — a strict-TS port of audio_transcript_check's
 * `src/lib/transcriptMetadata.js` (the whole file) plus `ensureSegmentIds`
 * (`src/App.jsx:301-311`) and the legacy speaker-field migration
 * (`src/App.jsx:160-223`).
 *
 * ON-DISK COMPATIBILITY: field names/shapes are kept EXACTLY as the source app
 * writes them (`segments[]` with `_id`/`start`/`end`/`text`/`speakerId`, and the
 * `_transcriber` metadata block with `version: 2`, `segmentHistory`,
 * `segmentProofreads`, `segmentTranscriptions`) so a `<base>.json` produced by
 * either app opens in the other unchanged.
 *
 * DIVERGENCE from the source (owner decision): per-segment edit history is
 * CAPPED at {@link SEGMENT_HISTORY_CAP} entries — the cap applies wherever a new
 * entry is APPENDED ({@link recordSegmentTextChange}, {@link withSegmentCollection});
 * already-persisted longer histories are NOT truncated on load
 * ({@link ensureTranscriptMetadata} never drops data), so opening a legacy file
 * is loss-free and the cap only bites as new edits arrive. The PRIMARY
 * guarantee is full-text ↔ segments SYNC (see `raw-md.ts`), not unbounded undo.
 *
 * Pure and Theia/DOM-free — runs directly under `bun test`, mirroring
 * `proofreading-model.ts` conventions.
 */

import {
  TranscriptSpeaker,
  createSpeakerId,
  ensureSpeakerByName,
  getLegacySegmentSpeakerLabel,
  getSegmentSpeakerId,
  normalizeSpeakerRegistry
} from './transcript-speakers';

/**
 * One transcript segment as stored on disk. Extra keys from the recognizer
 * (whisper's `id`, `tokens`, `avg_logprob`, …) ride along via the index
 * signature and are never dropped by the pure update helpers.
 */
export interface TranscriptSegment {
  /** Stable segment id — assigned by {@link ensureSegmentIds} when absent on disk. */
  _id?: string;
  /** Segment start, seconds from the start of the media file. */
  start: number;
  /** Segment end, seconds from the start of the media file. */
  end: number;
  text: string;
  /** Registry speaker id (see `transcript-speakers.ts`); absent = carry-forward. */
  speakerId?: string;
  /** True when this segment explicitly starts a new speaker turn. */
  speakerTurn?: boolean;
  [key: string]: unknown;
}

/** The known history-entry sources (open-ended: on-disk data may carry others). */
export type SegmentHistorySource =
  | 'initial'
  | 'manual'
  | 'sync'
  | 'split'
  | 'merge'
  | 'proofread'
  | 'retranscribe'
  | 'history-restore'
  | 'unknown'
  | (string & {});

/** One entry of a segment's edit history. */
export interface SegmentHistoryEntry {
  id: string;
  text: string;
  source: SegmentHistorySource;
  /** Strict ISO 8601. */
  createdAt: string;
  note: string;
}

/** One issue reported by an AI proofread pass. */
export interface SegmentProofreadIssue {
  id: string;
  type: string;
  severity: string;
  message: string;
  excerpt: string;
  suggestion: string;
}

/** The stored result of an AI proofread pass over one segment. */
export interface SegmentProofreadResult {
  provider: string;
  model: string;
  summary: string;
  correctedText: string;
  /** The segment text the proofread ran against. */
  sourceText: string;
  /** Strict ISO 8601. */
  updatedAt: string;
  issues: SegmentProofreadIssue[];
}

/** The stored result of an AI re-recognition (STT) pass over one segment. */
export interface SegmentTranscriptionResult {
  provider: string;
  model: string;
  suggestedText: string;
  /** The segment text at the time of the re-recognition. */
  sourceText: string;
  /** Strict ISO 8601. */
  updatedAt: string;
  /** The raw provider payload, kept verbatim for debugging. */
  raw: unknown;
}

/** The transcript-side metadata version this model reads and writes. */
export const TRANSCRIBER_METADATA_VERSION = 2;

/**
 * Maximum history entries kept PER SEGMENT (owner decision: capped/short).
 * Applied on append — see the module doc for the exact semantics.
 */
export const SEGMENT_HISTORY_CAP = 20;

/** The `_transcriber` metadata block (version 2), keyed by segment `_id`. */
export interface TranscriberMetadata {
  version: number;
  segmentHistory: Record<string, SegmentHistoryEntry[]>;
  segmentProofreads: Record<string, SegmentProofreadResult>;
  segmentTranscriptions: Record<string, SegmentTranscriptionResult>;
}

/**
 * A whole transcript document (`<base>.json`). Recognizer-level extra keys
 * (`language`, `duration`, whisper's `text`, …) ride along untouched.
 */
export interface TranscriptDocument {
  segments: TranscriptSegment[];
  _transcriber?: TranscriberMetadata;
  [key: string]: unknown;
}

/** Options for {@link recordSegmentTextChange} / {@link createHistoryEntry}. */
export interface HistoryEntryExtras {
  note?: string;
}

function createEntryId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `entry_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Build one history entry (id + ISO timestamp assigned here). */
export function createHistoryEntry(
  text: string,
  source: SegmentHistorySource = 'manual',
  extras: HistoryEntryExtras = {}
): SegmentHistoryEntry {
  return {
    id: createEntryId(),
    text: typeof text === 'string' ? text : '',
    source,
    createdAt: new Date().toISOString(),
    note: typeof extras.note === 'string' ? extras.note : ''
  };
}

function normalizeHistoryEntry(entry: unknown, fallbackText = ''): SegmentHistoryEntry {
  if (!entry || typeof entry !== 'object') {
    return createHistoryEntry(fallbackText, 'unknown');
  }
  const record = entry as Partial<SegmentHistoryEntry> & { [key: string]: unknown };
  // IDEMPOTENCE FIX over the source (`transcriptMetadata.js:12-26` always
  // allocated a new object, so `ensureTranscriptMetadata` reported `changed`
  // forever): an already-well-formed entry is returned AS-IS, keeping object
  // identity so a normalized transcript normalizes to itself.
  if (
    typeof record.id === 'string' &&
    record.id &&
    typeof record.text === 'string' &&
    typeof record.source === 'string' &&
    typeof record.createdAt === 'string' &&
    record.createdAt.trim() !== '' &&
    typeof record.note === 'string'
  ) {
    return record as SegmentHistoryEntry;
  }
  return {
    id: String(record.id || createEntryId()),
    text: typeof record.text === 'string' ? record.text : fallbackText,
    source: typeof record.source === 'string' ? record.source : 'unknown',
    createdAt:
      typeof record.createdAt === 'string' && record.createdAt.trim() ? record.createdAt : new Date().toISOString(),
    note: typeof record.note === 'string' ? record.note : ''
  };
}

/** Keep only the LAST {@link SEGMENT_HISTORY_CAP} entries (oldest dropped first). */
export function capSegmentHistory(entries: readonly SegmentHistoryEntry[]): SegmentHistoryEntry[] {
  return entries.length > SEGMENT_HISTORY_CAP ? entries.slice(entries.length - SEGMENT_HISTORY_CAP) : [...entries];
}

function normalizeMetadata(rawMetadata: unknown): TranscriberMetadata {
  const metadata = rawMetadata && typeof rawMetadata === 'object' ? { ...(rawMetadata as Record<string, unknown>) } : {};
  const asRecordMap = <T>(value: unknown): Record<string, T> =>
    value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, T>) } : {};
  return {
    version: TRANSCRIBER_METADATA_VERSION,
    segmentHistory: asRecordMap<SegmentHistoryEntry[]>(metadata.segmentHistory),
    segmentProofreads: asRecordMap<SegmentProofreadResult>(metadata.segmentProofreads),
    segmentTranscriptions: asRecordMap<SegmentTranscriptionResult>(metadata.segmentTranscriptions)
  };
}

/**
 * Normalize a (possibly foreign/partial) transcript into the version-2 shape:
 * `_transcriber` filled, every segment with an `_id` given an `initial` history
 * entry, and a `sync` entry appended when the stored text drifted past the last
 * history entry. Returns the SAME object when nothing changed. Loss-free: never
 * truncates persisted histories (see module doc on the cap).
 */
export function ensureTranscriptMetadata(transcript: unknown): { transcript: TranscriptDocument; changed: boolean } {
  if (!transcript || typeof transcript !== 'object') {
    return { transcript: { segments: [], _transcriber: normalizeMetadata(null) }, changed: true };
  }

  const document = transcript as TranscriptDocument;
  const segments = Array.isArray(document.segments) ? document.segments : [];
  const metadata = normalizeMetadata(document._transcriber);
  const nextHistory: Record<string, SegmentHistoryEntry[]> = { ...metadata.segmentHistory };
  let changed = metadata.version !== (document._transcriber as TranscriberMetadata | undefined)?.version;

  for (const segment of segments) {
    if (!segment || typeof segment !== 'object' || !segment._id) {
      continue;
    }
    const text = typeof segment.text === 'string' ? segment.text : '';
    const rawEntries = Array.isArray(nextHistory[segment._id]) ? nextHistory[segment._id] : [];
    const entries = rawEntries.map(entry => normalizeHistoryEntry(entry, text));
    if (entries.length === 0) {
      nextHistory[segment._id] = [createHistoryEntry(text, 'initial')];
      changed = true;
      continue;
    }
    const lastEntry = entries[entries.length - 1];
    if (lastEntry.text !== text) {
      entries.push(createHistoryEntry(text, 'sync'));
      changed = true;
    }
    if (entries.length !== rawEntries.length || entries.some((entry, index) => entry !== rawEntries[index])) {
      changed = true;
    }
    nextHistory[segment._id] = entries;
  }

  const nextTranscript = changed
    ? {
        ...document,
        segments,
        _transcriber: {
          ...metadata,
          segmentHistory: nextHistory
        }
      }
    : document;
  return { transcript: nextTranscript, changed };
}

/**
 * Assign a stable `_id` to every segment lacking one. Returns the SAME array
 * when nothing changed (`App.jsx:301-311`). `createId` is injectable for
 * deterministic tests.
 */
export function ensureSegmentIds(
  segments: TranscriptSegment[],
  createId: () => string = createEntryId
): TranscriptSegment[] {
  if (!Array.isArray(segments)) {
    return segments;
  }
  let changed = false;
  const result = segments.map(segment => {
    if (segment._id) {
      return segment;
    }
    changed = true;
    return { ...segment, _id: createId() };
  });
  return changed ? result : segments;
}

/** The stored edit history for a segment (empty when unknown). */
export function getSegmentHistory(transcript: TranscriptDocument | undefined, segmentId: string | undefined): SegmentHistoryEntry[] {
  if (!segmentId) {
    return [];
  }
  const history = transcript?._transcriber?.segmentHistory?.[segmentId];
  return Array.isArray(history) ? history : [];
}

/** The stored proofread result for a segment, or undefined. */
export function getSegmentProofread(
  transcript: TranscriptDocument | undefined,
  segmentId: string | undefined
): SegmentProofreadResult | undefined {
  if (!segmentId) {
    return undefined;
  }
  const proofread = transcript?._transcriber?.segmentProofreads?.[segmentId];
  return proofread && typeof proofread === 'object' ? proofread : undefined;
}

/** The stored re-recognition result for a segment, or undefined. */
export function getSegmentTranscription(
  transcript: TranscriptDocument | undefined,
  segmentId: string | undefined
): SegmentTranscriptionResult | undefined {
  if (!segmentId) {
    return undefined;
  }
  const transcription = transcript?._transcriber?.segmentTranscriptions?.[segmentId];
  return transcription && typeof transcription === 'object' ? transcription : undefined;
}

/** Options for {@link recordSegmentTextChange}. */
export interface RecordTextChangeOptions extends HistoryEntryExtras {
  source?: SegmentHistorySource;
}

/**
 * Set a segment's text (by index) and append a CAPPED history entry. No-op
 * history-wise when the text equals the last entry (returns the normalized
 * transcript unchanged in that case, exactly like the source). The append is
 * where {@link SEGMENT_HISTORY_CAP} bites: the oldest entries beyond the cap
 * are dropped.
 */
export function recordSegmentTextChange(
  transcript: TranscriptDocument | undefined,
  segmentIndex: number,
  nextText: string,
  options: RecordTextChangeOptions = {}
): TranscriptDocument | undefined {
  if (!transcript?.segments?.[segmentIndex]) {
    return transcript;
  }
  const { transcript: normalizedTranscript } = ensureTranscriptMetadata(transcript);
  const currentSegment = normalizedTranscript.segments[segmentIndex];
  const normalizedText = typeof nextText === 'string' ? nextText : '';
  const nextSegments = [...normalizedTranscript.segments];
  nextSegments[segmentIndex] = { ...currentSegment, text: normalizedText };

  const nextHistory = { ...normalizedTranscript._transcriber!.segmentHistory };
  const existingEntries = getSegmentHistory(normalizedTranscript, currentSegment._id);
  const lastEntry = existingEntries[existingEntries.length - 1];
  if (!lastEntry || lastEntry.text !== normalizedText) {
    nextHistory[currentSegment._id!] = capSegmentHistory([
      ...existingEntries,
      createHistoryEntry(normalizedText, options.source || 'manual', { note: options.note || '' })
    ]);
  } else if (nextSegments[segmentIndex] === currentSegment) {
    return normalizedTranscript;
  }

  return {
    ...normalizedTranscript,
    segments: nextSegments,
    _transcriber: {
      ...normalizedTranscript._transcriber!,
      segmentHistory: nextHistory
    }
  };
}

/**
 * Restore a segment's text from a history entry — a {@link recordSegmentTextChange}
 * with source `history-restore` (the restore itself becomes the newest capped
 * entry, so redo is possible; `App.jsx:2296-2305`).
 */
export function restoreSegmentHistoryEntry(
  transcript: TranscriptDocument | undefined,
  segmentIndex: number,
  historyEntry: Pick<SegmentHistoryEntry, 'text'> & Partial<Pick<SegmentHistoryEntry, 'createdAt'>>
): TranscriptDocument | undefined {
  if (!historyEntry || typeof historyEntry.text !== 'string') {
    return transcript;
  }
  return recordSegmentTextChange(transcript, segmentIndex, historyEntry.text, {
    source: 'history-restore',
    note: `Restored version from ${historyEntry.createdAt || 'history'}`
  });
}

function normalizeIssues(rawIssues: unknown): SegmentProofreadIssue[] {
  if (!Array.isArray(rawIssues)) {
    return [];
  }
  return rawIssues
    .filter((issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === 'object')
    .map(issue => ({
      id: String(issue.id || createEntryId()),
      type: typeof issue.type === 'string' ? issue.type : 'issue',
      severity: typeof issue.severity === 'string' ? issue.severity : 'info',
      message: typeof issue.message === 'string' ? issue.message : '',
      excerpt: typeof issue.excerpt === 'string' ? issue.excerpt : '',
      suggestion: typeof issue.suggestion === 'string' ? issue.suggestion : ''
    }))
    .filter(issue => issue.message);
}

/**
 * Store an AI proofread result for a segment (normalized field-by-field so a
 * partial/foreign payload cannot corrupt the on-disk shape).
 */
export function setSegmentProofreadResult(
  transcript: TranscriptDocument | undefined,
  segmentId: string,
  result: Partial<SegmentProofreadResult> & { issues?: unknown } | undefined
): TranscriptDocument | undefined {
  if (!segmentId || !transcript) {
    return transcript;
  }
  const { transcript: normalizedTranscript } = ensureTranscriptMetadata(transcript);
  const nextProofreads: Record<string, SegmentProofreadResult> = {
    ...normalizedTranscript._transcriber!.segmentProofreads,
    [segmentId]: {
      provider: typeof result?.provider === 'string' ? result.provider : '',
      model: typeof result?.model === 'string' ? result.model : '',
      summary: typeof result?.summary === 'string' ? result.summary : '',
      correctedText: typeof result?.correctedText === 'string' ? result.correctedText : '',
      sourceText: typeof result?.sourceText === 'string' ? result.sourceText : '',
      updatedAt: typeof result?.updatedAt === 'string' ? result.updatedAt : new Date().toISOString(),
      issues: normalizeIssues(result?.issues)
    }
  };
  return {
    ...normalizedTranscript,
    _transcriber: {
      ...normalizedTranscript._transcriber!,
      segmentProofreads: nextProofreads
    }
  };
}

/**
 * Store an AI re-recognition (STT) result for a segment. NOTE the on-disk field
 * is `suggestedText` while the incoming payload carries `text` — kept exactly
 * as the source app maps it (`transcriptMetadata.js:209-235`).
 */
export function setSegmentTranscriptionResult(
  transcript: TranscriptDocument | undefined,
  segmentId: string,
  result: { provider?: string; model?: string; text?: string; sourceText?: string; updatedAt?: string; raw?: unknown } | undefined
): TranscriptDocument | undefined {
  if (!segmentId || !transcript) {
    return transcript;
  }
  const { transcript: normalizedTranscript } = ensureTranscriptMetadata(transcript);
  const nextTranscriptions: Record<string, SegmentTranscriptionResult> = {
    ...normalizedTranscript._transcriber!.segmentTranscriptions,
    [segmentId]: {
      provider: typeof result?.provider === 'string' ? result.provider : '',
      model: typeof result?.model === 'string' ? result.model : '',
      suggestedText: typeof result?.text === 'string' ? result.text : '',
      sourceText: typeof result?.sourceText === 'string' ? result.sourceText : '',
      updatedAt: typeof result?.updatedAt === 'string' ? result.updatedAt : new Date().toISOString(),
      raw: result?.raw && typeof result.raw === 'object' ? result.raw : null
    }
  };
  return {
    ...normalizedTranscript,
    _transcriber: {
      ...normalizedTranscript._transcriber!,
      segmentTranscriptions: nextTranscriptions
    }
  };
}

/** Options for {@link withSegmentCollection}. */
export interface WithSegmentCollectionOptions {
  /**
   * Explicit replacement histories for (new) segment ids — how split/merge
   * seeds both children with the parent's history plus a `split`/`merge` entry.
   */
  historyEntriesBySegmentId?: Record<string, SegmentHistoryEntry[]>;
}

/**
 * Replace the whole segment collection (split/merge/reorder) while keeping the
 * `_transcriber` metadata consistent: explicit histories win (normalized and
 * CAPPED), otherwise a segment keeps its history — with an `initial` entry when
 * it has none and a `sync` entry (capped append) when its text drifted.
 */
export function withSegmentCollection(
  transcript: TranscriptDocument | undefined,
  nextSegments: TranscriptSegment[],
  options: WithSegmentCollectionOptions = {}
): TranscriptDocument {
  const baseTranscript: TranscriptDocument =
    transcript && typeof transcript === 'object' ? { ...transcript, segments: nextSegments } : { segments: nextSegments };
  const { transcript: normalizedTranscript } = ensureTranscriptMetadata(baseTranscript);
  const historyEntriesBySegmentId =
    options.historyEntriesBySegmentId && typeof options.historyEntriesBySegmentId === 'object'
      ? options.historyEntriesBySegmentId
      : {};
  const nextHistory = { ...normalizedTranscript._transcriber!.segmentHistory };

  for (const segment of nextSegments) {
    if (!segment?._id) {
      continue;
    }
    const explicitEntries = historyEntriesBySegmentId[segment._id];
    if (Array.isArray(explicitEntries) && explicitEntries.length > 0) {
      nextHistory[segment._id] = capSegmentHistory(
        explicitEntries.map(entry => normalizeHistoryEntry(entry, segment.text || ''))
      );
      continue;
    }

    const existingEntries = getSegmentHistory(normalizedTranscript, segment._id);
    if (existingEntries.length === 0) {
      nextHistory[segment._id] = [createHistoryEntry(segment.text || '', 'initial')];
      continue;
    }

    const lastEntry = existingEntries[existingEntries.length - 1];
    if (lastEntry.text !== (segment.text || '')) {
      nextHistory[segment._id] = capSegmentHistory([...existingEntries, createHistoryEntry(segment.text || '', 'sync')]);
    }
  }

  return {
    ...normalizedTranscript,
    segments: nextSegments,
    _transcriber: {
      ...normalizedTranscript._transcriber!,
      segmentHistory: nextHistory
    }
  };
}

/** Result of {@link migrateLegacySpeakerFields}. */
export interface LegacySpeakerMigrationResult {
  segments: TranscriptSegment[];
  speakers: TranscriptSpeaker[];
  segmentsChanged: boolean;
  speakersChanged: boolean;
}

/**
 * Migrate legacy free-text speaker fields (`speaker` / `speakerLabel` /
 * `author`) to registry `speakerId`s, creating registry entries by name as
 * needed. A segment with an explicit `speakerId` is left untouched; migrated
 * segments have the legacy fields REMOVED. Port of `App.jsx:160-191`
 * (`migrateSegmentsToSpeakerIds`). `createId` is injectable for deterministic
 * tests.
 */
export function migrateLegacySpeakerFields(
  segments: TranscriptSegment[],
  speakers: unknown,
  createId: () => string = createSpeakerId
): LegacySpeakerMigrationResult {
  if (!Array.isArray(segments)) {
    return { segments: [], speakers: normalizeSpeakerRegistry(speakers), segmentsChanged: false, speakersChanged: false };
  }

  let nextSpeakers = normalizeSpeakerRegistry(speakers);
  let speakersChanged = nextSpeakers.length !== (Array.isArray(speakers) ? speakers.length : 0);
  let segmentsChanged = false;

  const nextSegments = segments.map(segment => {
    if (!segment || typeof segment !== 'object') {
      return segment;
    }
    const explicitSpeakerId = getSegmentSpeakerId(segment);
    if (explicitSpeakerId) {
      return segment;
    }

    const legacySpeakerName = getLegacySegmentSpeakerLabel(segment);
    if (!legacySpeakerName) {
      return segment;
    }

    const ensured = ensureSpeakerByName(nextSpeakers, legacySpeakerName, createId);
    nextSpeakers = ensured.speakers;
    if (ensured.changed) {
      speakersChanged = true;
    }
    if (!ensured.speaker) {
      return segment;
    }

    segmentsChanged = true;
    const nextSegment: TranscriptSegment = { ...segment, speakerId: ensured.speaker.id };
    delete nextSegment.speaker;
    delete nextSegment.speakerLabel;
    return nextSegment;
  });

  return { segments: nextSegments, speakers: nextSpeakers, segmentsChanged, speakersChanged };
}
