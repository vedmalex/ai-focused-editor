/**
 * RPC protocol of the media-transcription BACKEND pipeline (Phase 2) — the
 * Theia-native port of the owner's local toolchain (converter CLI +
 * process_videos_unified.sh + whisper.cpp). Extends the Phase-1 type surface in
 * `audio-transcription-protocol.ts` with the full convert → transcribe →
 * normalize → merge pipeline, per-segment re-recognition (the Phase-5 hook),
 * a `doctor()` environment report, and job-based progress/cancellation.
 *
 * The frontend proxies this over `AudioConversionServicePath` (bound in
 * `node/manuscript-workspace-backend-module.ts` via `RpcConnectionHandler`,
 * mirroring `book-build-protocol.ts`). Progress is POLL-based (start → poll →
 * cancel) — the existing backend services in this package expose no
 * client-callback proxy, so the job model keeps the wire surface plain
 * request/response.
 *
 * SCOPE v1 (deliberate): convert + transcribe(local|groq) + normalize +
 * raw.md + doctor + per-segment transcribeSegmentFile + progress/cancel.
 * DEFERRED (out of scope, tracked as TODO): speaker-turn detection (whisper
 * tinydiarize `-tdrz`), pyannote diarization, automatic ggml model download.
 */

import type { NormalizedTranscription } from './media-transcription-model';

export const AudioConversionService = Symbol('AudioConversionService');
export const AudioConversionServicePath = '/services/ai-focused-editor/audio-conversion';

/** STAGE-1 options (converter.ts `convert`). All paths are ABSOLUTE. */
export interface AudioConversionOptions {
  /** Directory that receives one `<media-base>/` folder per input file. */
  outputDirectory: string;
  /** Silence-bucket length in seconds (converter `--segment`). Default 600. */
  segmentSeconds?: number;
  /** Output segment format (converter `--audio-format`). Default `mp3`. */
  audioFormat?: 'mp3' | 'wav';
  /** Skip inputs whose segment folder already holds output. Default true. */
  skipExisting?: boolean;
  /** Absolute ffmpeg binary; empty/omitted = `ffmpeg` on PATH. */
  ffmpegPath?: string;
  /** Absolute ffprobe binary; empty/omitted = `ffprobe` on PATH. */
  ffprobePath?: string;
  /** silencedetect tuning (`silencedetect=noise=<noiseDb>dB:d=<minDurationSec>`). */
  silence?: {
    /** Default -30 (dB). */
    noiseDb?: number;
    /** Default 1 (second). */
    minDurationSec?: number;
  };
}

export type TranscriptionBackend = 'local' | 'groq';

/** STAGE-2 options (whisper.cpp local CLI or the Groq API). */
export interface TranscriptionOptions {
  backend: TranscriptionBackend;
  /** Absolute path to `whisper.cpp/build/bin/whisper-cli` (backend `local`). */
  whisperCliPath?: string;
  /** Absolute path to the ggml model `.bin` (backend `local`). */
  modelPath?: string;
  /** whisper `-l` / language hint. Default `auto`. */
  language?: string;
  /** whisper `-t`. Default 8. */
  threads?: number;
  /**
   * Groq API keys (backend `groq`) — either explicit entries or comma-separated
   * within one entry (the `GROQ_API_KEY` list convention). Shuffled per batch,
   * rotated on quota errors. NEVER logged or echoed into progress events.
   */
  groqApiKeys?: string[];
  /** Groq transcription model. Default `whisper-large-v3-turbo`. */
  groqModel?: string;
  /** Skip segments that already have a non-empty `<base>.json`. Default true. */
  skipExisting?: boolean;
}

/** One produced audio segment. */
export interface SegmentInfo {
  /** Absolute path of the produced file (`.mp3`, or `.wav` after fallback). */
  path: string;
  /** Base name without extension (`full` or `time[HH:MM:SS][SEC]`). */
  baseName: string;
  /** Seconds within the source media. */
  startSec: number;
  endSec: number;
  /** True when the mp3 encode failed and the segment was kept as WAV. */
  wavFallback: boolean;
}

/** Full pipeline request: convert, then optionally transcribe + merge. */
export interface MediaPipelineRequest {
  /** Absolute paths of the input media files (audio and/or video). */
  inputFiles: string[];
  conversion: AudioConversionOptions;
  /** Omit to stop after STAGE 1 (convert only). */
  transcription?: TranscriptionOptions;
  /** Write the merged `raw.md` per segment folder. Default true when transcribing. */
  generateRawMd?: boolean;
}

export type MediaPipelineStage = 'convert' | 'transcribe' | 'normalize' | 'merge';

export type MediaPipelineEventKind =
  | 'file-start'
  | 'file-end'
  | 'stage-start'
  | 'stage-end'
  | 'segment-start'
  | 'segment-end'
  | 'warning'
  | 'error';

/** One progress event (per-stage + per-segment), monotonically sequenced per job. */
export interface MediaPipelineProgressEvent {
  seq: number;
  /** Epoch ms. */
  timestamp: number;
  kind: MediaPipelineEventKind;
  stage?: MediaPipelineStage;
  /** Absolute input media path the event belongs to. */
  file?: string;
  /** Absolute segment path (per-segment events). */
  segment?: string;
  /** 1-based segment index / total within the current stage. */
  index?: number;
  total?: number;
  message?: string;
}

export type MediaPipelineJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Per-input-file outcome. */
export interface MediaPipelineFileResult {
  inputFile: string;
  /** Absolute segment folder (`<outputDirectory>/<media-base>/`). */
  outputDir: string;
  segments: SegmentInfo[];
  /** Absolute paths of the normalized `<base>.json` transcripts. */
  transcripts: string[];
  /** Absolute `raw.md` path when the merge ran. */
  rawMdPath?: string;
  /** True when skip-existing short-circuited the conversion. */
  skippedExisting: boolean;
  /** Failure message; the pipeline continues with the next file (as the CLI did). */
  error?: string;
}

/** Poll snapshot of a pipeline job. */
export interface MediaPipelineJobState {
  jobId: string;
  status: MediaPipelineJobStatus;
  /** Events with `seq > sinceSeq` (all when `sinceSeq` omitted). */
  events: MediaPipelineProgressEvent[];
  /** Pass as the next poll's `sinceSeq`. */
  nextSeq: number;
  /** Present once the job left `running`. */
  results?: MediaPipelineFileResult[];
  /** Job-fatal error (per-file errors live in `results[].error`). */
  error?: string;
}

/**
 * Per-segment re-recognition (Phase 5): one WAV/MP3 slice → normalized text.
 * EXACTLY ONE audio source must be provided:
 *  - `segmentPath` — an absolute path already on the backend machine, or
 *  - `audioBase64` — the slice bytes themselves (base64), used by the browser
 *    frontend which has no filesystem path for an in-memory WAV slice. The
 *    backend writes them to a temp file, transcribes, and deletes it.
 */
export interface TranscribeSegmentFileRequest {
  /** Absolute path to the audio segment (wav/mp3). Omit when sending `audioBase64`. */
  segmentPath?: string;
  /** Base64-encoded audio bytes (a complete WAV/MP3 file, NOT raw PCM). */
  audioBase64?: string;
  /**
   * File name hint for `audioBase64` (its extension picks the temp-file
   * suffix, e.g. `segment.wav`). Default `segment.wav`.
   */
  audioFileName?: string;
  transcription: TranscriptionOptions;
}

export interface TranscribeSegmentFileResult {
  ok: boolean;
  /** The recognized full text (normalized `text` field). */
  text?: string;
  /** The full normalized transcription (segments etc.). */
  transcription?: NormalizedTranscription;
  error?: string;
}

/** Doctor request: the frontend passes the resolved `mediaTranscription.*` preferences. */
export interface MediaTranscriptionDoctorRequest {
  backend?: TranscriptionBackend;
  ffmpegPath?: string;
  ffprobePath?: string;
  whisperCliPath?: string;
  modelPath?: string;
  groqApiKeys?: string[];
}

export type MediaTranscriptionDoctorCheckId = 'ffmpeg' | 'ffprobe' | 'whisper-cli' | 'model' | 'groq-api-key';

export interface MediaTranscriptionDoctorCheck {
  id: MediaTranscriptionDoctorCheckId;
  label: string;
  ok: boolean;
  /** What was probed (path / PATH lookup). Never contains secrets. */
  detail: string;
  /** How to fix it, when `ok` is false. */
  advice?: string;
}

export interface MediaTranscriptionDoctorReport {
  /** True when every RELEVANT check passed (irrelevant checks are omitted). */
  ok: boolean;
  checks: MediaTranscriptionDoctorCheck[];
}

export interface AudioConversionService {
  /** Start the convert(+transcribe+merge) pipeline; returns immediately. */
  startPipeline(request: MediaPipelineRequest): Promise<{ jobId: string }>;
  /** Poll a job's status + progress events after `sinceSeq`. */
  pollJob(jobId: string, sinceSeq?: number): Promise<MediaPipelineJobState>;
  /** Cancel a running job (SIGTERM → SIGKILL on the active child process). */
  cancelJob(jobId: string): Promise<boolean>;
  /** Re-recognize ONE existing audio segment file (Phase 5 hook). */
  transcribeSegmentFile(request: TranscribeSegmentFileRequest): Promise<TranscribeSegmentFileResult>;
  /** Check the machine's toolchain (ffmpeg/ffprobe/whisper-cli/model/keys). */
  doctor(request?: MediaTranscriptionDoctorRequest): Promise<MediaTranscriptionDoctorReport>;
}
