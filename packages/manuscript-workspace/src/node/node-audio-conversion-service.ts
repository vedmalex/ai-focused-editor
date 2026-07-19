/**
 * Backend implementation of {@link AudioConversionService} — the Phase-2
 * Theia-native port of the owner's local media-transcription toolchain:
 *
 *  STAGE 1  media → silence-aligned segmented MP3
 *           (converter.ts `processFiles`/`encodeFile`, ffmpeg/ffprobe);
 *  STAGE 2  transcribe each segment — LOCAL whisper.cpp CLI
 *           (unified.sh `transcribe_local_dir`) or the GROQ API (groq.ts,
 *           incl. the comma-separated key list + shuffle/rotate semantics);
 *  STAGE 2b normalize whisper/Groq JSON → `{text, language, segments[]}`
 *           (unified.sh jq, ported in `common/media-transcription-model.ts`);
 *  STAGE 3  merge the per-segment JSONs → `raw.md`
 *           (converter `parse --dir --merge`).
 *
 * Every external process is spawned with an ARG ARRAY (never a shell string —
 * media names carry spaces/Cyrillic and the `time[...]` names carry glob
 * metacharacters). Cancellation SIGTERMs the active child and escalates to
 * SIGKILL after {@link KILL_ESCALATION_MS}. Whisper runs with concurrency 1.
 *
 * DELIBERATE DEVIATIONS from the source toolchain (each documented inline):
 *  - the full-audio WAV extracted from a VIDEO input is cached ONCE per input
 *    file instead of re-extracted for every segment (O(n) instead of O(n²));
 *  - `list.txt` is not written into the cwd (the result surface replaces it);
 *  - JSON normalization SKIPS files that already carry the editor's
 *    `_transcriber` metadata block (the jq re-normalized every file, which
 *    would strip the editor's per-segment history/speakers);
 *  - `raw.md` merging joins blocks in chronological order (identical to the
 *    source's lexicographic temp-file order for canonical `time[...]` names).
 *
 * TODO (deferred, out of Phase-2 scope): speaker-turn detection (whisper
 * tinydiarize `-tdrz` → `speaker_turns.tsv`), pyannote diarization, automatic
 * ggml model download (`models/download-ggml-model.sh`).
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs, constants as fsConstants } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { injectable, unmanaged } from '@theia/core/shared/inversify';
import {
  AudioConversionOptions,
  AudioConversionService,
  MediaPipelineEventKind,
  MediaPipelineFileResult,
  MediaPipelineJobState,
  MediaPipelineJobStatus,
  MediaPipelineProgressEvent,
  MediaPipelineRequest,
  MediaPipelineStage,
  MediaTranscriptionDoctorCheck,
  MediaTranscriptionDoctorReport,
  MediaTranscriptionDoctorRequest,
  SegmentInfo,
  TranscribeSegmentFileRequest,
  TranscribeSegmentFileResult,
  TranscriptionOptions
} from '../common/audio-conversion-protocol';
import {
  NormalizedTranscription,
  RawMdMergeSource,
  mediaOutputFolderName,
  mergeTranscriptionsToRawMd,
  normalizeWhisperJson,
  planSegments,
  segmentBaseNameForEndTime,
  selectSilenceCutPoints
} from '../common/media-transcription-model';

/* ------------------------------------------------------------------------- *
 * Command runner (spawn with arg arrays; injectable for tests)
 * ------------------------------------------------------------------------- */

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const RECOVERY_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_LOG_LINES = 12;
const KILL_ESCALATION_MS = 3000;
const MIN_DURATION_FOR_SEGMENTATION = 600;
const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo';

export interface RunCommandOptions {
  /** Cap on the collected stdout/stderr (excess is truncated, not fatal). */
  maxBufferBytes?: number;
  /** Streamed stderr lines (silencedetect parsing). */
  onStderrLine?: (line: string) => void;
  cancellation?: CancellationHandle;
}

export interface CommandOutcome {
  /** True when the process spawned AND exited with code 0. */
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be spawned at all. */
  spawnError?: string;
}

/** The spawn seam — swapped by tests for a scripted fake. ARG ARRAYS ONLY. */
export type CommandRunner = (command: string, args: string[], options?: RunCommandOptions) => Promise<CommandOutcome>;

/** Cooperative cancellation: flips a flag and kills the active child process. */
export class CancellationHandle {
  private _cancelled = false;
  private readonly killers = new Set<() => void>();

  get cancelled(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    this._cancelled = true;
    for (const kill of [...this.killers]) {
      kill();
    }
  }

  registerKiller(kill: () => void): () => void {
    if (this._cancelled) {
      kill();
      return () => undefined;
    }
    this.killers.add(kill);
    return () => this.killers.delete(kill);
  }

  throwIfCancelled(): void {
    if (this._cancelled) {
      throw new PipelineCancelledError();
    }
  }
}

export class PipelineCancelledError extends Error {
  constructor() {
    super('Pipeline cancelled');
    this.name = 'PipelineCancelledError';
  }
}

export const defaultCommandRunner: CommandRunner = (command, args, options = {}) =>
  new Promise<CommandOutcome>(resolvePromise => {
    const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let stderrRemainder = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < maxBuffer) {
        stdout += chunk.slice(0, maxBuffer - stdout.length);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < maxBuffer) {
        stderr += chunk.slice(0, maxBuffer - stderr.length);
      }
      if (options.onStderrLine) {
        stderrRemainder += chunk;
        const lines = stderrRemainder.split(/\r?\n/);
        stderrRemainder = lines.pop() || '';
        for (const line of lines) {
          options.onStderrLine(line);
        }
      }
    });

    // SIGTERM first; SIGKILL if the process is still alive after the grace period.
    const unregister = options.cancellation?.registerKiller(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const escalate = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_ESCALATION_MS) as unknown as { unref?: () => void };
      escalate.unref?.();
    });

    child.on('error', error => {
      unregister?.();
      resolvePromise({ ok: false, code: null, stdout, stderr, spawnError: error.message });
    });
    child.on('close', code => {
      unregister?.();
      if (options.onStderrLine && stderrRemainder.trim()) {
        options.onStderrLine(stderrRemainder);
      }
      resolvePromise({ ok: code === 0, code, stdout, stderr });
    });
  });

/** Port of converter.ts `summarizeOutput` (first 12 trimmed lines + counter). */
export function summarizeCommandOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return '';
  }
  if (lines.length <= MAX_LOG_LINES) {
    return lines.join('\n');
  }
  return `${lines.slice(0, MAX_LOG_LINES).join('\n')}\n… and ${lines.length - MAX_LOG_LINES} more lines`;
}

/* ------------------------------------------------------------------------- *
 * Groq key rotation (port of groq.ts `GroqKeyManager`, keys passed in — the
 * service NEVER logs them and never reads process.env directly)
 * ------------------------------------------------------------------------- */

export class GroqKeyManager {
  private readonly keys: string[];
  private currentKeyIndex = 0;

  /** Accepts explicit entries AND comma-separated lists within an entry. */
  constructor(rawKeys: readonly string[]) {
    const processed = rawKeys
      .flatMap(entry => entry.split(','))
      .map(key => key.trim())
      .filter(key => key.length > 0);
    if (processed.length === 0) {
      throw new Error('No Groq API keys configured (set mediaTranscription.groqApiKey)');
    }
    this.keys = GroqKeyManager.shuffle([...processed]);
  }

  private static shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  getCurrentKey(): string {
    return this.keys[this.currentKeyIndex];
  }

  getRandomKey(): string {
    this.currentKeyIndex = Math.floor(Math.random() * this.keys.length);
    return this.keys[this.currentKeyIndex];
  }

  rotateKey(): string {
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
    return this.getCurrentKey();
  }

  get keyCount(): number {
    return this.keys.length;
  }
}

/** The HTTPS seam for Groq — swapped by tests. Returns the parsed verbose_json. */
export type GroqTransport = (filePath: string, apiKey: string, model: string) => Promise<unknown>;

export const defaultGroqTransport: GroqTransport = async (filePath, apiKey, model) => {
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)]), basename(filePath));
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Include the status text so the quota/rate-limit classifier sees 429s.
    throw new Error(
      `Groq transcription failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`
    );
  }
  return response.json();
};

function isConnectionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('connection') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('econnrefused') ||
    // fetch() surfaces network failures as a bare 'fetch failed'.
    lower.includes('fetch failed')
  );
}

function isQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('too many requests') ||
    lower.includes(' 429 ')
  );
}

/* ------------------------------------------------------------------------- *
 * Job bookkeeping
 * ------------------------------------------------------------------------- */

interface PipelineJob {
  jobId: string;
  status: MediaPipelineJobStatus;
  events: MediaPipelineProgressEvent[];
  results: MediaPipelineFileResult[];
  error?: string;
  cancellation: CancellationHandle;
}

const MAX_RETAINED_JOBS = 20;

interface MediaTypeInfo {
  hasVideo: boolean;
  hasAudio: boolean;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    /* absent */
  }
}

/* ------------------------------------------------------------------------- *
 * The service
 * ------------------------------------------------------------------------- */

@injectable()
export class NodeAudioConversionService implements AudioConversionService {
  protected readonly jobs = new Map<string, PipelineJob>();
  protected readonly runCommand: CommandRunner;
  protected readonly groqTransport: GroqTransport;
  /** Test seam: retry backoff (ms) for Groq connection errors. */
  protected groqRetryDelayMs = 1000;

  // Both parameters are TEST seams with defaults — `@unmanaged()` tells
  // inversify NOT to resolve them (a plain `Function`/object parameter would
  // otherwise fail DI construction when the RPC connection handler gets the
  // service from the backend container).
  constructor(
    @unmanaged() runner: CommandRunner = defaultCommandRunner,
    @unmanaged() groqTransport: GroqTransport = defaultGroqTransport
  ) {
    this.runCommand = runner;
    this.groqTransport = groqTransport;
  }

  /* ------------------------------------ RPC surface ---------------------- */

  async startPipeline(request: MediaPipelineRequest): Promise<{ jobId: string }> {
    const jobId = randomUUID();
    const job: PipelineJob = {
      jobId,
      status: 'running',
      events: [],
      results: [],
      cancellation: new CancellationHandle()
    };
    this.jobs.set(jobId, job);
    this.pruneJobs();

    void this.runPipeline(job, request)
      .then(() => {
        if (job.status === 'running') {
          job.status = 'completed';
        }
      })
      .catch(error => {
        if (error instanceof PipelineCancelledError) {
          job.status = 'cancelled';
          return;
        }
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        this.emit(job, { kind: 'error', message: job.error });
      });

    return { jobId };
  }

  async pollJob(jobId: string, sinceSeq?: number): Promise<MediaPipelineJobState> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown media pipeline job: ${jobId}`);
    }
    const from = sinceSeq ?? 0;
    const events = job.events.filter(event => event.seq > from);
    const state: MediaPipelineJobState = {
      jobId,
      status: job.status,
      events,
      nextSeq: job.events.length > 0 ? job.events[job.events.length - 1].seq : from
    };
    if (job.status !== 'running') {
      state.results = job.results;
      if (job.error !== undefined) {
        state.error = job.error;
      }
    }
    return state;
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') {
      return false;
    }
    job.cancellation.cancel();
    return true;
  }

  async transcribeSegmentFile(request: TranscribeSegmentFileRequest): Promise<TranscribeSegmentFileResult> {
    // In-memory slice (browser frontend): materialize a temp file, recurse
    // through the path branch, and ALWAYS clean the temp file up.
    if (request.audioBase64) {
      const extension = /\.mp3$/i.test(request.audioFileName ?? '') ? '.mp3' : '.wav';
      const tempPath = join(tmpdir(), `ai-editor-segment-${randomUUID()}${extension}`);
      try {
        let bytes: Buffer;
        try {
          bytes = Buffer.from(request.audioBase64, 'base64');
        } catch {
          return { ok: false, error: 'audioBase64 is not valid base64 data' };
        }
        if (bytes.length === 0) {
          return { ok: false, error: 'audioBase64 decoded to zero bytes' };
        }
        await fs.writeFile(tempPath, bytes);
        return await this.transcribeSegmentFile({ segmentPath: tempPath, transcription: request.transcription });
      } finally {
        await unlinkIfExists(tempPath);
      }
    }
    try {
      if (!request.segmentPath) {
        return { ok: false, error: 'Either segmentPath or audioBase64 is required' };
      }
      if (!(await pathExists(request.segmentPath))) {
        return { ok: false, error: `Segment file does not exist: ${request.segmentPath}` };
      }
      const cancellation = new CancellationHandle();
      const normalized =
        request.transcription.backend === 'groq'
          ? await this.transcribeSegmentViaGroq(request.segmentPath, request.transcription)
          : await this.transcribeSegmentViaWhisper(request.segmentPath, request.transcription, cancellation);
      if (!normalized) {
        return { ok: false, error: 'Transcription produced no output (empty recognizer result)' };
      }
      return { ok: true, text: normalized.text, transcription: normalized };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async doctor(request: MediaTranscriptionDoctorRequest = {}): Promise<MediaTranscriptionDoctorReport> {
    const checks: MediaTranscriptionDoctorCheck[] = [];

    checks.push(await this.checkBinary('ffmpeg', 'ffmpeg', request.ffmpegPath,
      'Install ffmpeg (macOS: brew install ffmpeg; Ubuntu: sudo apt-get install ffmpeg) or set mediaTranscription.ffmpegPath to the absolute ffmpeg binary.'));
    checks.push(await this.checkBinary('ffprobe', 'ffprobe', request.ffprobePath,
      'ffprobe ships with ffmpeg — install ffmpeg (macOS: brew install ffmpeg) or set mediaTranscription.ffprobePath to the absolute ffprobe binary.'));

    const backend = request.backend ?? 'local';
    if (backend === 'local') {
      checks.push(await this.checkWhisperCli(request.whisperCliPath));
      checks.push(await this.checkModel(request.modelPath));
    } else {
      const keys = (request.groqApiKeys ?? [])
        .flatMap(entry => entry.split(','))
        .map(key => key.trim())
        .filter(key => key.length > 0);
      checks.push({
        id: 'groq-api-key',
        label: 'Groq API key',
        ok: keys.length > 0,
        detail: keys.length > 0 ? `${keys.length} key(s) configured` : 'no Groq API key configured',
        ...(keys.length > 0
          ? {}
          : { advice: 'Get an API key at https://console.groq.com and set mediaTranscription.groqApiKey (comma-separate multiple keys to enable rotation).' })
      });
    }

    return { ok: checks.every(check => check.ok), checks };
  }

  /* ------------------------------------ doctor internals ----------------- */

  protected async checkBinary(
    id: 'ffmpeg' | 'ffprobe',
    binary: string,
    configuredPath: string | undefined,
    advice: string
  ): Promise<MediaTranscriptionDoctorCheck> {
    if (configuredPath && configuredPath.trim().length > 0) {
      const path = configuredPath.trim();
      let ok = false;
      try {
        await fs.access(path, fsConstants.X_OK);
        ok = true;
      } catch {
        ok = false;
      }
      return {
        id, label: binary, ok,
        detail: ok ? `configured path is executable: ${path}` : `configured path is missing or not executable: ${path}`,
        ...(ok ? {} : { advice })
      };
    }
    const probe = await this.runCommand(binary, ['-version']);
    return {
      id, label: binary, ok: probe.ok,
      detail: probe.ok ? `${binary} found on PATH` : `${binary} not found on PATH`,
      ...(probe.ok ? {} : { advice })
    };
  }

  protected async checkWhisperCli(configuredPath: string | undefined): Promise<MediaTranscriptionDoctorCheck> {
    const advice =
      'Set mediaTranscription.whisperCliPath to <whisper.cpp>/build/bin/whisper-cli. Build it first: ' +
      "cmake -S <whisper.cpp> -B <whisper.cpp>/build && cmake --build <whisper.cpp>/build -j --config Release";
    if (!configuredPath || configuredPath.trim().length === 0) {
      return { id: 'whisper-cli', label: 'whisper-cli', ok: false, detail: 'mediaTranscription.whisperCliPath is not set', advice };
    }
    const path = configuredPath.trim();
    let ok = false;
    try {
      await fs.access(path, fsConstants.X_OK);
      ok = true;
    } catch {
      ok = false;
    }
    return {
      id: 'whisper-cli', label: 'whisper-cli', ok,
      detail: ok ? `whisper-cli is executable: ${path}` : `whisper-cli is missing or not executable: ${path}`,
      ...(ok ? {} : { advice })
    };
  }

  protected async checkModel(configuredPath: string | undefined): Promise<MediaTranscriptionDoctorCheck> {
    const advice =
      'Download a ggml model with <whisper.cpp>/models/download-ggml-model.sh (e.g. large-v3-turbo) and set mediaTranscription.modelPath to the resulting models/ggml-<name>.bin.';
    if (!configuredPath || configuredPath.trim().length === 0) {
      return { id: 'model', label: 'ggml model', ok: false, detail: 'mediaTranscription.modelPath is not set', advice };
    }
    const path = configuredPath.trim();
    const ok = await pathExists(path);
    return {
      id: 'model', label: 'ggml model', ok,
      detail: ok ? `model file exists: ${path}` : `model file does not exist: ${path}`,
      ...(ok ? {} : { advice })
    };
  }

  /* ------------------------------------ pipeline ------------------------- */

  protected emit(job: PipelineJob, event: Omit<MediaPipelineProgressEvent, 'seq' | 'timestamp'>): void {
    job.events.push({ seq: job.events.length + 1, timestamp: Date.now(), ...event });
  }

  protected pruneJobs(): void {
    while (this.jobs.size > MAX_RETAINED_JOBS) {
      const oldest = this.jobs.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      const job = this.jobs.get(oldest);
      if (job && job.status === 'running') {
        return; // never evict a live job
      }
      this.jobs.delete(oldest);
    }
  }

  protected async runPipeline(job: PipelineJob, request: MediaPipelineRequest): Promise<void> {
    const conversion = request.conversion;
    if (!conversion?.outputDirectory) {
      throw new Error('conversion.outputDirectory is required');
    }
    if (!Array.isArray(request.inputFiles) || request.inputFiles.length === 0) {
      throw new Error('inputFiles must list at least one media file');
    }

    for (const inputFilePath of request.inputFiles) {
      job.cancellation.throwIfCancelled();
      const inputFile = resolve(inputFilePath);
      this.emit(job, { kind: 'file-start', file: inputFile });

      const outputDir = join(conversion.outputDirectory, mediaOutputFolderName(inputFile));
      const result: MediaPipelineFileResult = {
        inputFile,
        outputDir,
        segments: [],
        transcripts: [],
        skippedExisting: false
      };
      job.results.push(result);

      try {
        await this.convertOneFile(job, inputFile, conversion, result);

        if (request.transcription && result.segments.length > 0) {
          this.emit(job, { kind: 'stage-start', stage: 'transcribe', file: inputFile });
          if (request.transcription.backend === 'groq') {
            await this.transcribeSegmentsGroq(job, inputFile, result, request.transcription);
          } else {
            await this.transcribeSegmentsLocal(job, inputFile, result, request.transcription);
          }
          this.emit(job, { kind: 'stage-end', stage: 'transcribe', file: inputFile });

          this.emit(job, { kind: 'stage-start', stage: 'normalize', file: inputFile });
          await this.normalizeTranscripts(job, result);
          this.emit(job, { kind: 'stage-end', stage: 'normalize', file: inputFile });

          if (request.generateRawMd !== false) {
            this.emit(job, { kind: 'stage-start', stage: 'merge', file: inputFile });
            await this.mergeRawMd(job, result);
            this.emit(job, { kind: 'stage-end', stage: 'merge', file: inputFile });
          }
        }
      } catch (error) {
        if (error instanceof PipelineCancelledError) {
          throw error;
        }
        result.error = error instanceof Error ? error.message : String(error);
        this.emit(job, { kind: 'error', file: inputFile, message: result.error });
        // Port of processFiles: drop an empty just-created segment folder.
        try {
          const entries = await fs.readdir(outputDir);
          if (entries.length === 0) {
            await fs.rmdir(outputDir);
          }
        } catch {
          /* folder absent */
        }
      }

      this.emit(job, { kind: 'file-end', file: inputFile });
    }
  }

  /* ------------------------------------ STAGE 1: convert ----------------- */

  protected ffmpegBin(options: AudioConversionOptions): string {
    return options.ffmpegPath?.trim() || 'ffmpeg';
  }

  protected ffprobeBin(options: AudioConversionOptions): string {
    return options.ffprobePath?.trim() || 'ffprobe';
  }

  /** ffprobe format=duration → Math.ceil seconds (throws on failure). */
  protected async getDuration(inputFile: string, options: AudioConversionOptions, cancellation: CancellationHandle): Promise<number> {
    const outcome = await this.runCommand(
      this.ffprobeBin(options),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputFile],
      { cancellation }
    );
    cancellation.throwIfCancelled();
    if (!outcome.ok) {
      const summary = summarizeCommandOutput(outcome.stderr || outcome.stdout || outcome.spawnError || '');
      throw new Error(`Failed to read duration of "${inputFile}"${summary ? `\n${summary}` : ''}`);
    }
    const value = parseFloat(outcome.stdout.trim());
    if (!Number.isFinite(value)) {
      throw new Error(`Failed to read duration of "${inputFile}": ffprobe returned "${outcome.stdout.trim()}"`);
    }
    return Math.ceil(value);
  }

  /** Non-throwing duration probe used by the partial-recovery acceptance check. */
  protected async getDurationSafe(filePath: string, options: AudioConversionOptions): Promise<number> {
    if (!(await pathExists(filePath))) {
      return 0;
    }
    const outcome = await this.runCommand(
      this.ffprobeBin(options),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath]
    );
    if (!outcome.ok) {
      return 0;
    }
    const value = parseFloat(outcome.stdout.trim());
    return Number.isFinite(value) ? value : 0;
  }

  protected async getMediaType(inputFile: string, options: AudioConversionOptions, cancellation: CancellationHandle): Promise<MediaTypeInfo> {
    const outcome = await this.runCommand(
      this.ffprobeBin(options),
      ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', inputFile],
      { cancellation }
    );
    cancellation.throwIfCancelled();
    if (!outcome.ok) {
      const summary = summarizeCommandOutput(outcome.stderr || outcome.stdout || outcome.spawnError || '');
      throw new Error(`Failed to detect media type of "${inputFile}"${summary ? `\n${summary}` : ''}`);
    }
    const kinds = outcome.stdout.trim().split('\n');
    return { hasVideo: kinds.includes('video'), hasAudio: kinds.includes('audio') };
  }

  /** ffmpeg silencedetect → cut points (streamed stderr, `silencedetect` lines only). */
  protected async detectSilence(
    inputFile: string,
    options: AudioConversionOptions,
    cancellation: CancellationHandle
  ): Promise<number[]> {
    const noiseDb = options.silence?.noiseDb ?? -30;
    const minDuration = options.silence?.minDurationSec ?? 1;
    const segmentSeconds = options.segmentSeconds ?? MIN_DURATION_FOR_SEGMENTATION;
    const silenceLines: string[] = [];
    const outcome = await this.runCommand(
      this.ffmpegBin(options),
      [
        '-hide_banner', '-nostdin', '-nostats', '-v', 'info',
        '-i', inputFile,
        '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
        '-f', 'null', '-'
      ],
      {
        cancellation,
        onStderrLine: line => {
          if (/silencedetect/i.test(line)) {
            silenceLines.push(line);
          }
        }
      }
    );
    cancellation.throwIfCancelled();
    if (!outcome.ok) {
      throw new Error(`Silence detection failed for "${inputFile}" (code ${outcome.code ?? 'unknown'})`);
    }
    return selectSilenceCutPoints(silenceLines, segmentSeconds);
  }

  protected async runFfmpeg(args: string[], options: AudioConversionOptions, cancellation: CancellationHandle, label: string): Promise<void> {
    const outcome = await this.runCommand(
      this.ffmpegBin(options),
      ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-xerror', ...args],
      { cancellation }
    );
    cancellation.throwIfCancelled();
    if (!outcome.ok) {
      const summary = summarizeCommandOutput(outcome.stderr || outcome.stdout || outcome.spawnError || '');
      throw new Error(`${label} (code ${outcome.code ?? 'unknown'})${summary ? `\n${summary}` : ''}`);
    }
  }

  /**
   * Port of converter.ts `runFfmpegWithPartialRecovery`: strict `-xerror` run
   * first; on failure retry WITHOUT `-xerror` (16 MiB buffer) and accept the
   * output when ffprobe reads a positive duration. Returns true when the
   * output is a partial recovery.
   */
  protected async runFfmpegWithPartialRecovery(
    args: string[],
    outputFile: string,
    options: AudioConversionOptions,
    cancellation: CancellationHandle,
    label: string
  ): Promise<boolean> {
    try {
      await this.runFfmpeg(args, options, cancellation, label);
      return false;
    } catch (error) {
      if (error instanceof PipelineCancelledError) {
        throw error;
      }
      const recovery = await this.runCommand(
        this.ffmpegBin(options),
        ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args],
        { cancellation, maxBufferBytes: RECOVERY_MAX_BUFFER }
      );
      cancellation.throwIfCancelled();
      if (recovery.spawnError) {
        throw error;
      }
      const recoveredDuration = await this.getDurationSafe(outputFile, options);
      if (recoveredDuration > 0) {
        return true;
      }
      throw error;
    }
  }

  /** Port of converter.ts `checkExistingFiles` (skip-existing probe). */
  protected async hasExistingConversion(
    inputFile: string,
    outputDir: string,
    audioFormat: 'mp3' | 'wav',
    options: AudioConversionOptions,
    cancellation: CancellationHandle
  ): Promise<boolean> {
    if (!(await pathExists(outputDir))) {
      return false;
    }
    try {
      const duration = await this.getDuration(inputFile, options, cancellation);
      if (duration <= MIN_DURATION_FOR_SEGMENTATION) {
        if (await pathExists(join(outputDir, `full.${audioFormat}`))) {
          return true;
        }
        return audioFormat === 'mp3' ? pathExists(join(outputDir, 'full.wav')) : false;
      }
      const files = (await fs.readdir(outputDir)).filter(
        file =>
          (file.endsWith(`.${audioFormat}`) || (audioFormat === 'mp3' && file.endsWith('.wav'))) &&
          file !== `full.${audioFormat}`
      );
      return files.length > 0;
    } catch (error) {
      if (error instanceof PipelineCancelledError) {
        throw error;
      }
      return false;
    }
  }

  /** Enumerate pre-existing segment files so stage 2 can run over a skipped conversion. */
  protected async enumerateExistingSegments(outputDir: string, audioFormat: 'mp3' | 'wav', durationSec: number): Promise<SegmentInfo[]> {
    const entries = (await fs.readdir(outputDir)).filter(
      file => file.endsWith(`.${audioFormat}`) || (audioFormat === 'mp3' && file.endsWith('.wav'))
    );
    const parsed = entries
      .map(name => {
        const baseName = name.replace(/\.(mp3|wav)$/i, '');
        const endMatch = baseName.match(/\[(\d+)\]$/);
        const endSec = /^full$/i.test(baseName) ? durationSec : endMatch ? parseInt(endMatch[1], 10) : 0;
        return { name, baseName, endSec };
      })
      .sort((a, b) => a.endSec - b.endSec);
    let startSec = 0;
    const segments: SegmentInfo[] = [];
    for (const entry of parsed) {
      segments.push({
        path: join(outputDir, entry.name),
        baseName: entry.baseName,
        startSec,
        endSec: entry.endSec,
        wavFallback: entry.name.toLowerCase().endsWith('.wav')
      });
      startSec = entry.endSec;
    }
    return segments;
  }

  /**
   * Port of converter.ts `encodeFile` — two-step extract (16 kHz mono WAV) then
   * encode, with partial recovery and WAV fallback. `fullWavPath` is the
   * per-input cached full-audio extraction for video inputs (DEVIATION: the
   * source re-extracted the whole audio track for EVERY segment; caching it
   * once is O(n) instead of O(n²) with byte-identical per-segment output).
   */
  protected async encodeSegment(
    inputFile: string,
    startSec: number,
    endSec: number,
    outputFile: string,
    fullWav: { path: string; recovered: boolean } | undefined,
    options: AudioConversionOptions,
    cancellation: CancellationHandle
  ): Promise<{ path: string; wavFallback: boolean }> {
    if (startSec >= endSec) {
      throw new Error(`Invalid time interval: start (${startSec}) must be before end (${endSec})`);
    }
    const tempWavFile = outputFile.replace(/\.(wav|mp3)$/i, '_temp.wav');
    const fallbackWavFile = outputFile.replace(/\.mp3$/i, '.wav');
    let recoveredPartialAudio = fullWav?.recovered ?? false;

    try {
      if (fallbackWavFile !== outputFile) {
        await unlinkIfExists(fallbackWavFile);
      }

      const cutSource = fullWav ? fullWav.path : inputFile;
      recoveredPartialAudio =
        (await this.runFfmpegWithPartialRecovery(
          [
            '-i', cutSource,
            '-ss', String(startSec),
            '-to', String(endSec),
            '-ar', '16000',
            '-ac', '1',
            '-c:a', 'pcm_s16le',
            tempWavFile
          ],
          tempWavFile,
          options,
          cancellation,
          `Failed to cut segment ${startSec}-${endSec} from "${cutSource}"`
        )) || recoveredPartialAudio;

      // A partially-recovered mp3 target stays WAV (better for diagnostics + STT).
      if (outputFile.toLowerCase().endsWith('.mp3') && recoveredPartialAudio) {
        await fs.rename(tempWavFile, fallbackWavFile);
        return { path: fallbackWavFile, wavFallback: true };
      }

      if (outputFile.toLowerCase().endsWith('.mp3')) {
        try {
          await this.runFfmpeg(
            ['-i', tempWavFile, '-codec:a', 'libmp3lame', '-qscale:a', '2', outputFile],
            options,
            cancellation,
            `Failed to encode segment MP3 "${outputFile}"`
          );
          return { path: outputFile, wavFallback: false };
        } catch (error) {
          if (error instanceof PipelineCancelledError) {
            throw error;
          }
          await fs.rename(tempWavFile, fallbackWavFile);
          return { path: fallbackWavFile, wavFallback: true };
        }
      }

      await fs.rename(tempWavFile, outputFile);
      return { path: outputFile, wavFallback: false };
    } finally {
      await unlinkIfExists(tempWavFile);
    }
  }

  /** Extract the full audio track of a VIDEO input to a cached 16 kHz mono WAV. */
  protected async extractFullAudio(
    inputFile: string,
    outputDir: string,
    options: AudioConversionOptions,
    cancellation: CancellationHandle
  ): Promise<{ path: string; recovered: boolean }> {
    const fullWavPath = join(outputDir, '__full_extract_temp.wav');
    await unlinkIfExists(fullWavPath);
    const recovered = await this.runFfmpegWithPartialRecovery(
      ['-i', inputFile, '-map', '0:a:0', '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', fullWavPath],
      fullWavPath,
      options,
      cancellation,
      `Failed to extract audio from "${inputFile}"`
    );
    return { path: fullWavPath, recovered };
  }

  protected async convertOneFile(
    job: PipelineJob,
    inputFile: string,
    options: AudioConversionOptions,
    result: MediaPipelineFileResult
  ): Promise<void> {
    const cancellation = job.cancellation;
    const audioFormat = options.audioFormat ?? 'mp3';
    const skipExisting = options.skipExisting !== false;
    const outputDir = result.outputDir;

    this.emit(job, { kind: 'stage-start', stage: 'convert', file: inputFile });

    if (!(await pathExists(inputFile))) {
      throw new Error(`Input file does not exist: ${inputFile}`);
    }

    const duration = await this.getDuration(inputFile, options, cancellation);
    const mediaType = await this.getMediaType(inputFile, options, cancellation);
    if (!mediaType.hasAudio) {
      throw new Error(`File ${inputFile} does not contain an audio stream`);
    }

    if (skipExisting && (await this.hasExistingConversion(inputFile, outputDir, audioFormat, options, cancellation))) {
      result.skippedExisting = true;
      result.segments = await this.enumerateExistingSegments(outputDir, audioFormat, duration);
      this.emit(job, {
        kind: 'stage-end',
        stage: 'convert',
        file: inputFile,
        message: `skipped — ${result.segments.length} existing segment file(s)`
      });
      return;
    }

    await fs.mkdir(outputDir, { recursive: true });

    let fullWav: { path: string; recovered: boolean } | undefined;
    try {
      if (mediaType.hasVideo) {
        fullWav = await this.extractFullAudio(inputFile, outputDir, options, cancellation);
        if (fullWav.recovered) {
          this.emit(job, { kind: 'warning', stage: 'convert', file: inputFile, message: 'audio track partially recovered (decode errors in source)' });
        }
      }

      if (duration <= MIN_DURATION_FOR_SEGMENTATION) {
        const outputFile = join(outputDir, `full.${audioFormat}`);
        await unlinkIfExists(outputFile);
        if (audioFormat === 'mp3') {
          await unlinkIfExists(join(outputDir, 'full.wav'));
        }
        this.emit(job, { kind: 'segment-start', stage: 'convert', file: inputFile, segment: outputFile, index: 1, total: 1 });
        const encoded = await this.encodeSegment(inputFile, 0, duration, outputFile, fullWav, options, cancellation);
        result.segments.push({ path: encoded.path, baseName: 'full', startSec: 0, endSec: duration, wavFallback: encoded.wavFallback });
        this.emit(job, { kind: 'segment-end', stage: 'convert', file: inputFile, segment: encoded.path, index: 1, total: 1 });
      } else {
        let cutPoints: number[] = [];
        try {
          cutPoints = await this.detectSilence(inputFile, options, cancellation);
        } catch (error) {
          if (error instanceof PipelineCancelledError) {
            throw error;
          }
          this.emit(job, {
            kind: 'warning',
            stage: 'convert',
            file: inputFile,
            message: `silence detection failed, using a single whole-file segment: ${error instanceof Error ? error.message : String(error)}`
          });
        }
        const plan = planSegments(duration, cutPoints);
        let index = 0;
        for (const planned of plan) {
          cancellation.throwIfCancelled();
          index++;
          const outputFile = join(outputDir, `${planned.baseName}.${audioFormat}`);
          await unlinkIfExists(outputFile);
          if (audioFormat === 'mp3') {
            await unlinkIfExists(outputFile.replace(/\.mp3$/i, '.wav'));
          }
          this.emit(job, { kind: 'segment-start', stage: 'convert', file: inputFile, segment: outputFile, index, total: plan.length });
          const encoded = await this.encodeSegment(inputFile, planned.startSec, planned.endSec, outputFile, fullWav, options, cancellation);
          result.segments.push({
            path: encoded.path,
            baseName: planned.baseName,
            startSec: planned.startSec,
            endSec: planned.endSec,
            wavFallback: encoded.wavFallback
          });
          this.emit(job, { kind: 'segment-end', stage: 'convert', file: inputFile, segment: encoded.path, index, total: plan.length });
        }
      }
    } finally {
      if (fullWav) {
        await unlinkIfExists(fullWav.path);
      }
    }

    this.emit(job, { kind: 'stage-end', stage: 'convert', file: inputFile, message: `${result.segments.length} segment(s)` });
  }

  /* ------------------------------------ STAGE 2: transcribe -------------- */

  protected transcriptPathFor(segmentPath: string): string {
    return segmentPath.replace(/\.(mp3|wav)$/i, '.json');
  }

  protected async isNonEmptyFile(path: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Port of unified.sh `transcribe_local_dir`: whisper-cli per segment into a
   * `.whisper_tmp` sidecar, normalize into the final `<base>.json`, delete the
   * tmp. Concurrency 1 (sequential). Empty whisper output → warning + skip.
   */
  protected async transcribeSegmentsLocal(
    job: PipelineJob,
    inputFile: string,
    result: MediaPipelineFileResult,
    options: TranscriptionOptions
  ): Promise<void> {
    const whisperCli = options.whisperCliPath?.trim();
    const modelPath = options.modelPath?.trim();
    if (!whisperCli) {
      throw new Error('transcription.whisperCliPath is required for the local backend (set mediaTranscription.whisperCliPath)');
    }
    if (!modelPath) {
      throw new Error('transcription.modelPath is required for the local backend (set mediaTranscription.modelPath)');
    }
    const skipExisting = options.skipExisting !== false;
    let index = 0;
    for (const segment of result.segments) {
      job.cancellation.throwIfCancelled();
      index++;
      const jsonFile = this.transcriptPathFor(segment.path);
      if (skipExisting && (await this.isNonEmptyFile(jsonFile))) {
        result.transcripts.push(jsonFile);
        continue;
      }
      this.emit(job, { kind: 'segment-start', stage: 'transcribe', file: inputFile, segment: segment.path, index, total: result.segments.length });
      const normalized = await this.runWhisperCli(segment.path, whisperCli, modelPath, options, job.cancellation);
      if (!normalized) {
        this.emit(job, { kind: 'warning', stage: 'transcribe', file: inputFile, segment: segment.path, message: 'whisper output is empty — segment skipped' });
        continue;
      }
      await fs.writeFile(jsonFile, JSON.stringify(normalized, null, 2), 'utf8');
      result.transcripts.push(jsonFile);
      this.emit(job, { kind: 'segment-end', stage: 'transcribe', file: inputFile, segment: segment.path, index, total: result.segments.length });
    }
  }

  /**
   * One whisper-cli invocation: `-m <model> -f <audio> -l <lang> -t <threads>
   * -oj -of <base>.whisper_tmp -np`, stdout discarded. Returns the NORMALIZED
   * transcription (or undefined when whisper produced nothing).
   */
  protected async runWhisperCli(
    audioPath: string,
    whisperCli: string,
    modelPath: string,
    options: TranscriptionOptions,
    cancellation: CancellationHandle,
    tmpBaseOverride?: string
  ): Promise<NormalizedTranscription | undefined> {
    const tmpBase = tmpBaseOverride ?? `${audioPath.replace(/\.(mp3|wav)$/i, '')}.whisper_tmp`;
    const tmpJson = `${tmpBase}.json`;
    await unlinkIfExists(tmpJson);
    try {
      const outcome = await this.runCommand(
        whisperCli,
        [
          '-m', modelPath,
          '-f', audioPath,
          '-l', options.language?.trim() || 'auto',
          '-t', String(options.threads ?? 8),
          '-oj',
          '-of', tmpBase,
          '-np'
        ],
        { cancellation }
      );
      cancellation.throwIfCancelled();
      if (!outcome.ok) {
        const summary = summarizeCommandOutput(outcome.stderr || outcome.stdout || outcome.spawnError || '');
        throw new Error(`whisper-cli failed for "${audioPath}" (code ${outcome.code ?? 'unknown'})${summary ? `\n${summary}` : ''}`);
      }
      if (!(await this.isNonEmptyFile(tmpJson))) {
        return undefined;
      }
      const raw = JSON.parse(await fs.readFile(tmpJson, 'utf8'));
      return normalizeWhisperJson(raw);
    } finally {
      await unlinkIfExists(tmpJson);
    }
  }

  /**
   * Port of groq.ts `transcribeAudio` (per segment): random key on the first
   * try, retry-on-connection (3× with backoff), rotate-on-quota across the
   * whole key ring, then rotate once more on any other failure. Keys are never
   * logged. Writes the RAW verbose_json (STAGE 2b normalizes it).
   */
  protected async transcribeSegmentsGroq(
    job: PipelineJob,
    inputFile: string,
    result: MediaPipelineFileResult,
    options: TranscriptionOptions
  ): Promise<void> {
    const keyManager = new GroqKeyManager(options.groqApiKeys ?? []);
    const skipExisting = options.skipExisting !== false;
    let index = 0;
    for (const segment of result.segments) {
      job.cancellation.throwIfCancelled();
      index++;
      const jsonFile = this.transcriptPathFor(segment.path);
      if (skipExisting && (await this.isNonEmptyFile(jsonFile))) {
        result.transcripts.push(jsonFile);
        continue;
      }
      this.emit(job, { kind: 'segment-start', stage: 'transcribe', file: inputFile, segment: segment.path, index, total: result.segments.length });
      try {
        const transcription = await this.groqTranscribeWithRotation(segment.path, keyManager, options, job.cancellation);
        await fs.writeFile(jsonFile, JSON.stringify(transcription, null, 2), 'utf8');
        result.transcripts.push(jsonFile);
        this.emit(job, { kind: 'segment-end', stage: 'transcribe', file: inputFile, segment: segment.path, index, total: result.segments.length });
      } catch (error) {
        if (error instanceof PipelineCancelledError) {
          throw error;
        }
        this.emit(job, {
          kind: 'warning',
          stage: 'transcribe',
          file: inputFile,
          segment: segment.path,
          message: `Groq transcription failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  protected async groqTranscribeWithRotation(
    filePath: string,
    keyManager: GroqKeyManager,
    options: TranscriptionOptions,
    cancellation: CancellationHandle
  ): Promise<unknown> {
    const model = options.groqModel?.trim() || DEFAULT_GROQ_MODEL;
    const maxRetries = 3;
    let lastError: Error | undefined;
    let currentRetry = 0;
    let attempts = 0;
    const maxAttempts = keyManager.keyCount;

    while (attempts < maxAttempts) {
      while (currentRetry <= maxRetries) {
        cancellation.throwIfCancelled();
        try {
          const apiKey = currentRetry === 0 ? keyManager.getRandomKey() : keyManager.getCurrentKey();
          return await this.groqTransport(filePath, apiKey, model);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const message = lastError.message;
          if (isConnectionError(message) && currentRetry < maxRetries) {
            currentRetry++;
            await new Promise(resolvePromise => setTimeout(resolvePromise, this.groqRetryDelayMs));
            continue;
          }
          if (isQuotaError(message) && attempts < maxAttempts - 1) {
            attempts++;
            currentRetry = 0;
            keyManager.rotateKey();
            continue;
          }
          break;
        }
      }
      if (attempts < maxAttempts - 1) {
        attempts++;
        currentRetry = 0;
        keyManager.rotateKey();
        continue;
      }
      break;
    }
    throw new Error(`Groq transcription failed after ${attempts + 1} key attempt(s): ${lastError?.message ?? 'unknown error'}`);
  }

  /* ------------------------------------ STAGE 2b: normalize -------------- */

  /**
   * Port of unified.sh `normalize_json_dir`: rewrite every non-empty segment
   * transcript through the normalizer (idempotent on already-normalized
   * files). DEVIATION: a transcript that already carries the editor's
   * `_transcriber` metadata block is left untouched — the jq would strip the
   * editor's per-segment history/speakers.
   */
  protected async normalizeTranscripts(job: PipelineJob, result: MediaPipelineFileResult): Promise<void> {
    const seen = new Set<string>(result.transcripts);
    // Also pick up transcripts that predate this run (skip-existing path).
    for (const segment of result.segments) {
      const jsonFile = this.transcriptPathFor(segment.path);
      if (!seen.has(jsonFile) && (await this.isNonEmptyFile(jsonFile))) {
        seen.add(jsonFile);
        result.transcripts.push(jsonFile);
      }
    }
    for (const jsonFile of result.transcripts) {
      job.cancellation.throwIfCancelled();
      try {
        const raw = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
        if (raw !== null && typeof raw === 'object' && '_transcriber' in (raw as Record<string, unknown>)) {
          continue; // editor-owned transcript — never strip its metadata
        }
        const normalized = normalizeWhisperJson(raw);
        await fs.writeFile(jsonFile, JSON.stringify(normalized, null, 2), 'utf8');
      } catch (error) {
        this.emit(job, {
          kind: 'warning',
          stage: 'normalize',
          segment: jsonFile,
          message: `normalization failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  /* ------------------------------------ STAGE 3: raw.md ------------------ */

  /**
   * Merge the per-segment transcripts into `<outputDir>/raw.md` (the
   * toolchain's `parse --dir --merge`). Only runs when every segment has a
   * transcript (unified.sh waited for json_count == mp3_count).
   */
  protected async mergeRawMd(job: PipelineJob, result: MediaPipelineFileResult): Promise<void> {
    if (result.segments.length === 0) {
      return;
    }
    if (result.transcripts.length < result.segments.length) {
      this.emit(job, {
        kind: 'warning',
        stage: 'merge',
        file: result.inputFile,
        message: `raw.md skipped: incomplete transcription (${result.transcripts.length}/${result.segments.length})`
      });
      return;
    }
    const sources: RawMdMergeSource[] = [];
    for (const jsonFile of result.transcripts) {
      try {
        const raw = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
        sources.push({ name: basename(jsonFile), data: normalizeWhisperJson(raw) });
      } catch (error) {
        this.emit(job, {
          kind: 'warning',
          stage: 'merge',
          segment: jsonFile,
          message: `unreadable transcript skipped: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
    const rawMd = mergeTranscriptionsToRawMd(sources);
    const rawMdPath = join(result.outputDir, 'raw.md');
    await fs.writeFile(rawMdPath, rawMd, 'utf8');
    result.rawMdPath = rawMdPath;
  }

  /* ------------------------------------ per-segment (Phase 5) ------------ */

  protected async transcribeSegmentViaWhisper(
    segmentPath: string,
    options: TranscriptionOptions,
    cancellation: CancellationHandle
  ): Promise<NormalizedTranscription | undefined> {
    const whisperCli = options.whisperCliPath?.trim();
    const modelPath = options.modelPath?.trim();
    if (!whisperCli) {
      throw new Error('whisperCliPath is required for the local backend (set mediaTranscription.whisperCliPath)');
    }
    if (!modelPath) {
      throw new Error('modelPath is required for the local backend (set mediaTranscription.modelPath)');
    }
    // Whisper writes next to `-of`; keep the sidecar OUT of the media folder.
    const tmpBase = join(tmpdir(), `ai-editor-whisper-${randomUUID()}.whisper_tmp`);
    return this.runWhisperCli(segmentPath, whisperCli, modelPath, options, cancellation, tmpBase);
  }

  protected async transcribeSegmentViaGroq(
    segmentPath: string,
    options: TranscriptionOptions
  ): Promise<NormalizedTranscription | undefined> {
    const keyManager = new GroqKeyManager(options.groqApiKeys ?? []);
    const raw = await this.groqTranscribeWithRotation(segmentPath, keyManager, options, new CancellationHandle());
    return normalizeWhisperJson(raw);
  }
}
