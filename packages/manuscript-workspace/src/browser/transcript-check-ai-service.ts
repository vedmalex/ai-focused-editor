import { inject, injectable } from '@theia/core/shared/inversify';
import { nls } from '@theia/core/lib/common/nls';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import {
  AiConnectionService,
  AiGenerateRequest,
  AudioConversionService,
  PcmAudioData,
  SegmentProofreadResult,
  SegmentTranscriptionResult,
  TranscriptionOptions,
  buildTranscriptProofreadMessages,
  bytesToBase64,
  extractJsonFromContent,
  extractSegmentWav,
  generateWithFailover,
  normalizeProofreadIssues,
  normalizeProofreadPayload
} from '../common';
import {
  AiProfilePreferenceService,
  AiRequestLogService
} from '@ai-focused-editor/ai-connect-theia/lib/browser';
import {
  MEDIA_TRANSCRIPTION_BACKEND,
  MEDIA_TRANSCRIPTION_GROQ_API_KEY,
  MEDIA_TRANSCRIPTION_GROQ_MODEL,
  MEDIA_TRANSCRIPTION_LANGUAGE,
  MEDIA_TRANSCRIPTION_MODEL_PATH,
  MEDIA_TRANSCRIPTION_THREADS,
  MEDIA_TRANSCRIPTION_WHISPER_CLI_PATH
} from './ai-focused-editor-preferences';

/** Request-log command id of the proofread lane (mirrors proofreading's prefix style). */
const PROOFREAD_COMMAND_ID = 'ai-focused-editor.transcript.proofread';

/**
 * Hard cap on the re-recognized segment length: a PCM16 WAV slice is
 * ~172 KB/s at 44.1 kHz mono and base64 inflates it by 4/3, so a very long
 * segment turns into a multi-megabyte RPC payload. Segments in this editor are
 * utterance-sized; anything past this cap should be split first.
 */
export const MAX_RETRANSCRIBE_SEGMENT_SEC = 300;

/** Above this the slice still runs, but the user is warned it may be slow. */
export const WARN_RETRANSCRIBE_SEGMENT_SEC = 60;

/** Request for a per-segment AI action (both lanes share the shape). */
export interface TranscriptSegmentAiRequest {
  /** Workspace-relative path to the media file (for the STT lane). */
  mediaRelPath?: string;
  /** Segment range, seconds within the media file. */
  startSec: number;
  endSec: number;
  /** The segment text at request time (proofread input / STT sourceText). */
  sourceText: string;
  /** Language hint from the set sidecar (e.g. `ru`). */
  language?: string;
  /**
   * Decoded PCM of the WHOLE media file (the widget's cached AudioBuffer,
   * projected to plain channel arrays). The STT lane slices `[startSec,
   * endSec]` out of it locally — required for `retranscribeSegment`.
   */
  audio?: PcmAudioData;
}

/** Result envelope of a per-segment AI action. */
export interface TranscriptSegmentAiResult<T> {
  result?: T;
  /** Non-fatal warnings (failover legs, long-segment notice). */
  warnings?: string[];
  /** Human-readable failure/unavailability message. */
  error?: string;
}

/**
 * The AI lanes of the Transcript Check editor. NEVER throws — every failure
 * comes back as `{ error }` so the widget surfaces it without a crash
 * (the `ProofreadingAiService` discipline):
 *
 * - `proofreadSegment` (Phase 4) routes the segment text through the
 *   ai-connect profile/failover stack (`buildTranscriptProofreadMessages` →
 *   `generateWithFailover`) and parses the `{correctedText, summary, issues[]}`
 *   JSON contract (`extractJsonFromContent` + `normalizeProofreadPayload`).
 * - `retranscribeSegment` (Phase 5) slices the segment WAV out of the
 *   widget-provided decoded PCM (`extractSegmentWav`), ships it base64 to the
 *   backend `AudioConversionService.transcribeSegmentFile`, with the
 *   whisper/Groq options read from the `mediaTranscription.*` preferences.
 */
@injectable()
export class TranscriptCheckAiService {

  @inject(AiConnectionService)
  protected readonly aiConnection!: AiConnectionService;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiRequestLogService)
  protected readonly requestLog!: AiRequestLogService;

  @inject(PreferenceService)
  protected readonly preferences!: PreferenceService;

  @inject(AudioConversionService)
  protected readonly audioConversion!: AudioConversionService;

  /** True once a real backend is wired (lets the widget label the buttons). */
  get proofreadAvailable(): boolean {
    return true;
  }

  get retranscribeAvailable(): boolean {
    return true;
  }

  /**
   * Proofread ONE segment's text through the configured ai-connect profile.
   * Temperature 0.15 + `json_object` response format (the source app's
   * settings); the response is parsed against the
   * `{correctedText, summary, issues[]}` contract.
   */
  async proofreadSegment(request: TranscriptSegmentAiRequest): Promise<TranscriptSegmentAiResult<SegmentProofreadResult>> {
    try {
      const profile = await this.aiProfilePreferences.getConfiguredProfile();
      if (!profile) {
        return {
          error: nls.localize(
            'ai-focused-editor/transcript/ai-needs-profile',
            'Configure an AI connection (add an endpoint and alias in the Model Config view) before running transcript AI actions.'
          )
        };
      }
      const { system, user } = buildTranscriptProofreadMessages(request.sourceText);
      const aiRequest: AiGenerateRequest = {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        parameters: { temperature: 0.15, responseFormat: { type: 'json_object' } },
        logContext: { command: PROOFREAD_COMMAND_ID }
      };
      const chain = await this.aiProfilePreferences.getFailoverChain();
      const outcome = await generateWithFailover(
        this.aiConnection,
        chain.length > 0 ? chain : [profile],
        aiRequest,
        this.requestLog.createRecorder(PROOFREAD_COMMAND_ID)
      );
      const payload = normalizeProofreadPayload(extractJsonFromContent(outcome.text), request.sourceText);
      const result: SegmentProofreadResult = {
        provider: outcome.route?.provider ?? outcome.profileUsed?.provider ?? '',
        model: outcome.route?.model ?? outcome.profileUsed?.model ?? '',
        summary: payload.summary,
        correctedText: payload.correctedText,
        sourceText: payload.sourceText,
        updatedAt: new Date().toISOString(),
        issues: normalizeProofreadIssues(payload.issues)
      };
      return { result, warnings: outcome.warnings ?? [] };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Re-recognize ONE segment: slice `[startSec, endSec]` out of the decoded
   * PCM into a PCM16 WAV, base64 it over the RPC boundary, and let the backend
   * run whisper.cpp/Groq on the temp file. Options come from the
   * `mediaTranscription.*` preferences; the sidecar `language` wins over the
   * preference when set.
   */
  async retranscribeSegment(request: TranscriptSegmentAiRequest): Promise<TranscriptSegmentAiResult<SegmentTranscriptionResult>> {
    try {
      if (!request.audio || request.audio.channels.length === 0) {
        return {
          error: nls.localize(
            'ai-focused-editor/transcript/ai-audio-not-decoded',
            'The audio is not decoded yet — wait for the waveform to finish loading, then try again.'
          )
        };
      }
      const durationSec = request.endSec - request.startSec;
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        return {
          error: nls.localize(
            'ai-focused-editor/transcript/ai-invalid-segment-range',
            'The segment has an invalid time range — fix its start/end before re-recognizing.'
          )
        };
      }
      if (durationSec > MAX_RETRANSCRIBE_SEGMENT_SEC) {
        return {
          error: nls.localize(
            'ai-focused-editor/transcript/ai-segment-too-long',
            'This segment is too long to re-recognize ({0}s; the limit is {1}s). Split it first.',
            String(Math.round(durationSec)),
            String(MAX_RETRANSCRIBE_SEGMENT_SEC)
          )
        };
      }
      const warnings: string[] = [];
      if (durationSec > WARN_RETRANSCRIBE_SEGMENT_SEC) {
        warnings.push(nls.localize(
          'ai-focused-editor/transcript/ai-segment-long-warning',
          'Long segment ({0}s) — encoding and uploading the audio may take a while.',
          String(Math.round(durationSec))
        ));
      }

      const options = this.readTranscriptionOptions(request.language);
      const configError = this.validateTranscriptionOptions(options);
      if (configError) {
        return { error: configError };
      }

      const wavBytes = extractSegmentWav(request.audio, request.startSec, request.endSec);
      const response = await this.audioConversion.transcribeSegmentFile({
        audioBase64: bytesToBase64(wavBytes),
        audioFileName: 'segment.wav',
        transcription: options
      });
      if (!response.ok || typeof response.text !== 'string') {
        return {
          warnings,
          error: response.error || nls.localize(
            'ai-focused-editor/transcript/ai-no-recognition-output',
            'Re-recognition produced no text for this segment.'
          )
        };
      }
      const result: SegmentTranscriptionResult = {
        provider: options.backend === 'groq' ? 'groq' : 'whisper.cpp',
        model: options.backend === 'groq'
          ? (options.groqModel || 'whisper-large-v3-turbo')
          : lastPathSegment(options.modelPath || ''),
        suggestedText: response.text.trim(),
        sourceText: request.sourceText,
        updatedAt: new Date().toISOString(),
        raw: response.transcription ?? null
      };
      return { result, warnings };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Project the `mediaTranscription.*` preferences into {@link TranscriptionOptions}. */
  protected readTranscriptionOptions(languageHint?: string): TranscriptionOptions {
    const backend = this.preferences.get<string>(MEDIA_TRANSCRIPTION_BACKEND, 'local') === 'groq' ? 'groq' : 'local';
    const preferenceLanguage = (this.preferences.get<string>(MEDIA_TRANSCRIPTION_LANGUAGE, '') || '').trim();
    const language = (languageHint || '').trim() || preferenceLanguage;
    const groqApiKey = (this.preferences.get<string>(MEDIA_TRANSCRIPTION_GROQ_API_KEY, '') || '').trim();
    const options: TranscriptionOptions = {
      backend,
      whisperCliPath: (this.preferences.get<string>(MEDIA_TRANSCRIPTION_WHISPER_CLI_PATH, '') || '').trim(),
      modelPath: (this.preferences.get<string>(MEDIA_TRANSCRIPTION_MODEL_PATH, '') || '').trim(),
      threads: this.preferences.get<number>(MEDIA_TRANSCRIPTION_THREADS, 8),
      groqModel: (this.preferences.get<string>(MEDIA_TRANSCRIPTION_GROQ_MODEL, '') || '').trim() || undefined,
      groqApiKeys: groqApiKey ? [groqApiKey] : []
    };
    if (language) {
      options.language = language;
    }
    return options;
  }

  /** A friendly not-configured message, or undefined when the backend can run. */
  protected validateTranscriptionOptions(options: TranscriptionOptions): string | undefined {
    if (options.backend === 'groq') {
      if (!options.groqApiKeys || options.groqApiKeys.length === 0) {
        return nls.localize(
          'ai-focused-editor/transcript/ai-groq-not-configured',
          'The Groq STT backend is not configured — set mediaTranscription.groqApiKey in Settings (get a key at console.groq.com).'
        );
      }
      return undefined;
    }
    if (!options.whisperCliPath || !options.modelPath) {
      return nls.localize(
        'ai-focused-editor/transcript/ai-local-stt-not-configured',
        'The local STT backend is not configured — set mediaTranscription.whisperCliPath and mediaTranscription.modelPath in Settings (or switch mediaTranscription.backend to "groq").'
      );
    }
    return undefined;
  }
}

/** Last path segment of a POSIX/Windows path (browser-safe `basename`). */
function lastPathSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}
