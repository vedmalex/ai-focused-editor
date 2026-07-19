/**
 * RPC protocol for the LATER Transcript Check backend service (speech-to-text
 * + media conversion). TYPES ONLY in this phase — no implementation, no
 * binding; the node service and frontend proxy arrive in a later wave
 * (mirroring how `git-status-protocol.ts` declares its service surface).
 *
 * Two lanes:
 *  - PER-SEGMENT re-recognition: the widget slices a `[startSec, endSec]`
 *    range (see `audio-segment-wav.ts`) or asks the backend to slice, the STT
 *    result lands in `setSegmentTranscriptionResult`.
 *  - WHOLE-MEDIA transcription + conversion (STUBBED type surface): transcribe
 *    a full media file into segments, or convert/extract audio (e.g. a video's
 *    audio track → wav) so video files pair into transcript sets too.
 */

export const AudioTranscriptionService = Symbol('AudioTranscriptionService');
export const AudioTranscriptionServicePath = '/services/ai-focused-editor/audio-transcription';

/** Request to re-recognize ONE segment's audio range. */
export interface TranscribeSegmentRequest {
  /** Workspace root the relative paths resolve against. */
  workspaceRootUri?: string;
  /** Workspace-relative path to the media (audio or video) file. */
  mediaRelPath: string;
  /** Segment range, seconds within the media file. */
  startSec: number;
  endSec: number;
  /** Language hint (e.g. `ru`); omitted = auto-detect. */
  language?: string;
  /** Provider/model routing hints (resolved by the service's settings when omitted). */
  providerId?: string;
  model?: string;
}

/** Result of a per-segment re-recognition. */
export interface TranscribeSegmentResponse {
  ok: boolean;
  /** The recognized text — feeds `setSegmentTranscriptionResult({text})`. */
  text?: string;
  /** Provider/model that actually served the request. */
  provider?: string;
  model?: string;
  /** The raw provider payload, kept verbatim for debugging. */
  raw?: unknown;
  /** Human-readable failure message when `ok` is false. */
  error?: string;
}

/** One segment produced by a whole-media transcription. */
export interface TranscribedMediaSegment {
  /** Seconds within the media file. */
  start: number;
  end: number;
  text: string;
}

/** STUB (later wave): request to transcribe a WHOLE media file into segments. */
export interface TranscribeMediaRequest {
  workspaceRootUri?: string;
  /** Workspace-relative path to the media (audio or video) file. */
  mediaRelPath: string;
  language?: string;
  providerId?: string;
  model?: string;
}

/** STUB (later wave): result of a whole-media transcription. */
export interface TranscribeMediaResponse {
  ok: boolean;
  segments?: TranscribedMediaSegment[];
  provider?: string;
  model?: string;
  raw?: unknown;
  error?: string;
}

/** STUB (later wave): request to convert media / extract its audio track. */
export interface ConvertMediaRequest {
  workspaceRootUri?: string;
  /** Workspace-relative path to the source media (audio or video) file. */
  mediaRelPath: string;
  /** Target container/codec extension (lowercase, dot-prefixed, e.g. `.wav`, `.mp3`). */
  targetExtension: string;
  /** Workspace-relative output path; derived from the source base when omitted. */
  outputRelPath?: string;
}

/** STUB (later wave): result of a media conversion. */
export interface ConvertMediaResponse {
  ok: boolean;
  /** Workspace-relative path of the produced file. */
  outputRelPath?: string;
  error?: string;
}

/**
 * The backend STT/conversion service surface. Declared now so the phase-1
 * common model compiles against the final contract; implemented (node) and
 * proxied (browser) in a later wave.
 */
export interface AudioTranscriptionService {
  /** Re-recognize one segment's audio range. */
  transcribeSegment(request: TranscribeSegmentRequest): Promise<TranscribeSegmentResponse>;
  /** STUB (later wave): transcribe a whole media file into segments. */
  transcribeMedia(request: TranscribeMediaRequest): Promise<TranscribeMediaResponse>;
  /** STUB (later wave): convert media / extract an audio track. */
  convertMedia(request: ConvertMediaRequest): Promise<ConvertMediaResponse>;
}
