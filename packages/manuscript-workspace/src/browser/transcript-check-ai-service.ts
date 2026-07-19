import { injectable } from '@theia/core/shared/inversify';
import { nls } from '@theia/core/lib/common/nls';
import type { SegmentProofreadResult, SegmentTranscriptionResult } from '../common';

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
}

/** Result envelope of a per-segment AI action. */
export interface TranscriptSegmentAiResult<T> {
  result?: T;
  /** Human-readable failure/unavailability message. */
  error?: string;
}

/**
 * The AI seam of the Transcript Check editor. BOTH lanes are deliberate
 * placeholders in this phase — the widget renders the buttons/panels and calls
 * these methods, so the later phases only swap the method bodies:
 *
 * - TODO(Phase 4): `proofreadSegment` — route through the ai-connect profile
 *   (see `transcript-prompts.ts` `buildTranscriptProofreadMessages` /
 *   `normalizeProofreadPayload`) and return a {@link SegmentProofreadResult}.
 * - TODO(Phase 5): `retranscribeSegment` — slice the segment WAV
 *   (`audio-segment-wav.ts` via the widget's decoded-buffer cache, or the
 *   backend `AudioTranscriptionService` in `audio-transcription-protocol.ts`)
 *   and return a {@link SegmentTranscriptionResult}-shaped payload.
 */
@injectable()
export class TranscriptCheckAiService {
  /** True once a real backend is wired (lets the widget label the buttons). */
  get proofreadAvailable(): boolean {
    return false;
  }

  get retranscribeAvailable(): boolean {
    return false;
  }

  async proofreadSegment(_request: TranscriptSegmentAiRequest): Promise<TranscriptSegmentAiResult<SegmentProofreadResult>> {
    return {
      error: nls.localize(
        'ai-focused-editor/transcript/ai-proofread-coming-soon',
        'AI proofreading for transcript segments is coming soon.'
      )
    };
  }

  async retranscribeSegment(_request: TranscriptSegmentAiRequest): Promise<TranscriptSegmentAiResult<SegmentTranscriptionResult>> {
    return {
      error: nls.localize(
        'ai-focused-editor/transcript/ai-retranscribe-coming-soon',
        'AI re-recognition for transcript segments is coming soon.'
      )
    };
  }
}
