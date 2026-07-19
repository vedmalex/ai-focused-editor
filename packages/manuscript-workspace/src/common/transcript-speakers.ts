/**
 * Speaker registry model for the Transcript Check feature.
 *
 * Port of audio_transcript_check's speaker handling (`src/App.jsx:87-246` —
 * `normalizeSpeakerLabel`, `createSpeakerId`, `getSegmentSpeaker*`,
 * `normalizeSpeakerRegistry`, `ensureSpeakerByName`,
 * `resolveSegmentSpeakerTimeline`; and `electron/main.cjs:96-121`
 * `getSegmentSpeakerLabel`). The on-disk store moves from the source app's
 * `.transcriber-speakers.json` to a book-native, comment-preserving
 * `speakers.yaml` (`{version, updatedAt, speakers: [{id, name}]}`), serialized
 * through the `yaml` `Document` API exactly like `proofreading-sidecar.ts`.
 *
 * Everything here is pure and Theia/DOM-free so it runs under `bun test`.
 * Segment parameters are typed STRUCTURALLY (a minimal speaker-bearing shape)
 * so this module has no import from `transcript-metadata.ts` — the metadata
 * module imports from here instead (one-way dependency).
 */

import { Document, parse, parseDocument } from 'yaml';

/** One registered speaker: a stable id and a display name. */
export interface TranscriptSpeaker {
  id: string;
  name: string;
}

/** Current `speakers.yaml` shape version. */
export const SPEAKERS_REGISTRY_VERSION = 1;

/** Fixed basename of the per-set speakers registry file. */
export const SPEAKERS_FILE_NAME = 'speakers.yaml';

/**
 * The on-disk `speakers.yaml` shape. Replaces the source app's
 * `.transcriber-speakers.json` (`electron/main.cjs:156-176` accepted either a
 * bare array or `{speakers: [...]}` — {@link parseSpeakersYaml} keeps that
 * tolerance for migrated content).
 */
export interface SpeakersRegistry {
  version: number;
  /** Strict ISO 8601 timestamp of the last registry write. */
  updatedAt: string;
  speakers: TranscriptSpeaker[];
}

/**
 * Minimal speaker-bearing segment shape (structural typing keeps this module
 * independent of `transcript-metadata.ts`). Legacy fields (`speaker`,
 * `speakerLabel`, `author`, `speaker_id`) appear on pre-migration segments.
 */
export interface SpeakerSourceSegment {
  speakerId?: unknown;
  speaker_id?: unknown;
  speaker?: unknown;
  speakerLabel?: unknown;
  author?: unknown;
}

/** Trim + collapse inner whitespace — the canonical speaker-name normalization. */
export function normalizeSpeakerLabel(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** New stable speaker id (`crypto.randomUUID` with a time+random fallback). */
export function createSpeakerId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `spk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** The segment's EXPLICIT speaker id (`speakerId` preferred, legacy `speaker_id` accepted). */
export function getSegmentSpeakerId(segment: SpeakerSourceSegment | undefined): string {
  if (!segment || typeof segment !== 'object') {
    return '';
  }
  if (typeof segment.speakerId === 'string') {
    return segment.speakerId.trim();
  }
  if (typeof segment.speaker_id === 'string') {
    return segment.speaker_id.trim();
  }
  return '';
}

/** The segment's LEGACY free-text speaker label (`speaker` / `speakerLabel` / `author`). */
export function getLegacySegmentSpeakerLabel(segment: SpeakerSourceSegment | undefined): string {
  if (!segment || typeof segment !== 'object') {
    return '';
  }
  const raw =
    typeof segment.speaker === 'string'
      ? segment.speaker
      : typeof segment.speakerLabel === 'string'
        ? segment.speakerLabel
        : typeof segment.author === 'string'
          ? segment.author
          : '';
  return normalizeSpeakerLabel(raw);
}

/**
 * Normalize a raw speakers list: keep only objects with a non-empty id AND
 * name, de-duplicating on id and (case-insensitive) name — first entry wins.
 * Port of `App.jsx` `normalizeSpeakerRegistry`.
 */
export function normalizeSpeakerRegistry(rawSpeakers: unknown): TranscriptSpeaker[] {
  if (!Array.isArray(rawSpeakers)) {
    return [];
  }
  const byId = new Map<string, TranscriptSpeaker>();
  const byName = new Set<string>();
  for (const rawSpeaker of rawSpeakers) {
    if (!rawSpeaker || typeof rawSpeaker !== 'object') {
      continue;
    }
    const record = rawSpeaker as { id?: unknown; name?: unknown };
    const id = String(record.id ?? '').trim();
    const name = normalizeSpeakerLabel(record.name);
    if (!id || !name) {
      continue;
    }
    const nameKey = name.toLowerCase();
    if (byId.has(id) || byName.has(nameKey)) {
      continue;
    }
    byId.set(id, { id, name });
    byName.add(nameKey);
  }
  return Array.from(byId.values());
}

/**
 * Find a speaker by (case-insensitive, normalized) name, creating one when
 * absent. Returns the possibly-extended list plus the resolved speaker;
 * `speaker` is undefined only for a blank name. Port of `App.jsx`
 * `ensureSpeakerByName`. `createId` is injectable for deterministic tests.
 */
export function ensureSpeakerByName(
  speakers: readonly TranscriptSpeaker[],
  speakerName: string,
  createId: () => string = createSpeakerId
): { speakers: TranscriptSpeaker[]; speaker?: TranscriptSpeaker; changed: boolean } {
  const normalizedName = normalizeSpeakerLabel(speakerName);
  if (!normalizedName) {
    return { speakers: [...speakers], changed: false };
  }
  const existing = speakers.find(
    speaker => normalizeSpeakerLabel(speaker.name).toLowerCase() === normalizedName.toLowerCase()
  );
  if (existing) {
    return { speakers: [...speakers], speaker: existing, changed: false };
  }
  const created: TranscriptSpeaker = { id: createId(), name: normalizedName };
  return { speakers: [...speakers, created], speaker: created, changed: true };
}

/** Build the id → display-name lookup {@link resolveSegmentSpeakerLabel} consumes. */
export function speakerNameById(speakers: readonly TranscriptSpeaker[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const speaker of speakers) {
    if (!map.has(speaker.id)) {
      map.set(speaker.id, speaker.name);
    }
  }
  return map;
}

/**
 * The display label for a segment's speaker: the registry name for an explicit
 * `speakerId` when known, otherwise the legacy free-text label. Port of
 * `electron/main.cjs` `getSegmentSpeakerLabel` (raw.md generation).
 */
export function resolveSegmentSpeakerLabel(
  segment: SpeakerSourceSegment | undefined,
  speakerById: ReadonlyMap<string, string>
): string {
  const speakerId = getSegmentSpeakerId(segment);
  if (speakerId && speakerById.has(speakerId)) {
    return speakerById.get(speakerId)!;
  }
  return getLegacySegmentSpeakerLabel(segment);
}

/** One entry of the effective-speaker timeline over a segment list. */
export interface EffectiveSpeakerEntry {
  /** The segment's own speaker id ('' when the segment names none). */
  explicitSpeakerId: string;
  /** The id in effect for this segment: explicit, or carried forward from earlier. */
  effectiveSpeakerId: string;
}

/**
 * Resolve the EFFECTIVE speaker per segment: an explicit `speakerId` wins;
 * otherwise the last effective id CARRIES FORWARD (a speaker keeps talking
 * until someone else is named). Port of `App.jsx`
 * `resolveSegmentSpeakerTimeline`. `initialSpeakerId` seeds the carry (e.g. the
 * last speaker of the previous file in a multi-file set).
 */
export function resolveEffectiveSpeaker(
  segments: readonly SpeakerSourceSegment[],
  initialSpeakerId = ''
): { timeline: EffectiveSpeakerEntry[]; lastSpeakerId: string } {
  const timeline: EffectiveSpeakerEntry[] = [];
  let lastSpeakerId = String(initialSpeakerId || '').trim();

  for (const segment of segments) {
    const explicitSpeakerId = getSegmentSpeakerId(segment);
    const effectiveSpeakerId = explicitSpeakerId || lastSpeakerId;
    if (effectiveSpeakerId) {
      lastSpeakerId = effectiveSpeakerId;
    }
    timeline.push({ explicitSpeakerId, effectiveSpeakerId });
  }

  return { timeline, lastSpeakerId };
}

/** Machine-readable code for each kind of `speakers.yaml` validation problem. */
export type SpeakersRegistryProblemCode =
  /** The file was empty, unparseable, or neither a mapping nor a bare list. */
  | 'invalid-shape'
  /** A `speakers` entry was malformed (dropped from the registry). */
  | 'invalid-speaker';

/** One validation problem found while parsing `speakers.yaml`. */
export interface SpeakersRegistryProblem {
  code: SpeakersRegistryProblemCode;
  message: string;
  /** Zero-based index of the offending `speakers` entry, for `invalid-speaker`. */
  index?: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse `speakers.yaml` into a {@link SpeakersRegistry} plus coded problems.
 * Tolerant like the source app's `.transcriber-speakers.json` reader: the root
 * may be a mapping (`{version, updatedAt, speakers}`) OR a bare speaker list.
 * Malformed speaker entries are dropped and reported (`invalid-speaker`); an
 * empty/unparseable file is `invalid-shape` (blocking — no registry returned).
 */
export function parseSpeakersYaml(text: string): { registry?: SpeakersRegistry; problems: SpeakersRegistryProblem[] } {
  const problems: SpeakersRegistryProblem[] = [];

  if (typeof text !== 'string' || text.trim().length === 0) {
    problems.push({ code: 'invalid-shape', message: 'speakers.yaml is empty.' });
    return { problems };
  }

  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    problems.push({
      code: 'invalid-shape',
      message: `Invalid speakers.yaml: ${error instanceof Error ? error.message : String(error)}`
    });
    return { problems };
  }

  let version = SPEAKERS_REGISTRY_VERSION;
  let updatedAt = '';
  let rawSpeakers: unknown;
  if (Array.isArray(document)) {
    // Bare-list tolerance (the `.transcriber-speakers.json` legacy shape).
    rawSpeakers = document;
  } else if (isPlainRecord(document)) {
    if (typeof document.version === 'number' && Number.isFinite(document.version)) {
      version = document.version;
    }
    if (typeof document.updatedAt === 'string') {
      updatedAt = document.updatedAt;
    }
    rawSpeakers = document.speakers;
  } else {
    problems.push({ code: 'invalid-shape', message: 'speakers.yaml must be a mapping or a list of speakers.' });
    return { problems };
  }

  const speakersList = Array.isArray(rawSpeakers) ? rawSpeakers : [];
  if (rawSpeakers !== undefined && rawSpeakers !== null && !Array.isArray(rawSpeakers)) {
    problems.push({ code: 'invalid-speaker', message: '"speakers" must be a list.' });
  }
  const speakers = normalizeSpeakerRegistry(speakersList);
  if (speakers.length !== speakersList.length) {
    speakersList.forEach((raw, index) => {
      const record = isPlainRecord(raw) ? raw : undefined;
      const id = record ? String(record.id ?? '').trim() : '';
      const name = record ? normalizeSpeakerLabel(record.name) : '';
      if (!record || !id || !name || !speakers.some(speaker => speaker.id === id)) {
        problems.push({
          code: 'invalid-speaker',
          index,
          message: `Speaker ${index + 1}: dropped (requires a unique "id" and "name").`
        });
      }
    });
  }

  return { registry: { version, updatedAt, speakers }, problems };
}

/**
 * Serialize a {@link SpeakersRegistry} into `speakers.yaml` text, PRESERVING
 * comments and unknown keys of `existingText` via the `yaml` `Document` API
 * (the `proofreading-sidecar.ts` round-trip contract).
 */
export function writeSpeakersYaml(existingText: string | undefined, registry: SpeakersRegistry): string {
  const parsed = existingText ? parseDocument(existingText) : undefined;
  const document = parsed && parsed.contents != null ? parsed : new Document({});

  document.set('version', registry.version);
  document.set('updatedAt', registry.updatedAt);
  document.set(
    'speakers',
    registry.speakers.map(speaker => ({ id: speaker.id, name: speaker.name }))
  );

  return document.toString();
}
