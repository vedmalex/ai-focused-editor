import { describe, expect, test } from 'bun:test';
import {
  AudioTranscriptionService,
  AudioTranscriptionServicePath,
  ConvertMediaResponse,
  TranscribeMediaResponse,
  TranscribeSegmentRequest,
  TranscribeSegmentResponse
} from './audio-transcription-protocol';

describe('audio-transcription protocol surface', () => {
  test('service path follows the repo RPC convention and the symbol is stable', () => {
    expect(AudioTranscriptionServicePath).toBe('/services/ai-focused-editor/audio-transcription');
    expect(typeof AudioTranscriptionService).toBe('symbol');
    expect(AudioTranscriptionService.toString()).toContain('AudioTranscriptionService');
  });

  test('the declared shapes compose (compile-level contract check)', async () => {
    // A minimal in-memory implementation proves the interface is implementable
    // without Theia imports — the phase-1 contract the later backend fulfills.
    const service: AudioTranscriptionService = {
      async transcribeSegment(request: TranscribeSegmentRequest): Promise<TranscribeSegmentResponse> {
        return { ok: true, text: `stub:${request.mediaRelPath}:${request.startSec}-${request.endSec}` };
      },
      async transcribeMedia(): Promise<TranscribeMediaResponse> {
        return { ok: true, segments: [{ start: 0, end: 1, text: 'stub' }] };
      },
      async convertMedia(): Promise<ConvertMediaResponse> {
        return { ok: false, error: 'not implemented in phase 1' };
      }
    };

    const segment = await service.transcribeSegment({ mediaRelPath: 'sources/audio/talk/full.mp3', startSec: 1, endSec: 2 });
    expect(segment.ok).toBe(true);
    expect(segment.text).toBe('stub:sources/audio/talk/full.mp3:1-2');

    const media = await service.transcribeMedia({ mediaRelPath: 'sources/audio/talk/full.mp3' });
    expect(media.segments).toHaveLength(1);

    const conversion = await service.convertMedia({ mediaRelPath: 'clip.mp4', targetExtension: '.wav' });
    expect(conversion.ok).toBe(false);
    expect(conversion.error).toContain('not implemented');
  });
});
