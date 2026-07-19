import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MEDIA_EXTENSIONS,
  TRANSCRIPT_EXTENSION,
  VALID_PLAYBACK_RATES,
  computeSegmentFillProgress,
  computeTranscriptProgress,
  formatTranscriptProgressChip,
  isTranscriptsetPath,
  matchTranscriptPairs,
  parseOffsetFromFilename
} from './transcript-set-model';

const FOLDERS = { audioFolder: 'sources/audio/talk', transcriptFolder: 'transcription/talk/transcripts' };

describe('DEFAULT_MEDIA_EXTENSIONS', () => {
  test('includes audio AND video extensions (owner decision)', () => {
    for (const ext of ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']) {
      expect(DEFAULT_MEDIA_EXTENSIONS).toContain(ext);
    }
    expect(TRANSCRIPT_EXTENSION).toBe('.json');
  });
});

describe('parseOffsetFromFilename', () => {
  test('clock-only shape → milliseconds', () => {
    expect(parseOffsetFromFilename('time[00:10:00].json')).toBe(600_000);
    expect(parseOffsetFromFilename('time[01:02:03].mp3')).toBe((3600 + 120 + 3) * 1000);
  });

  test('explicit [SECONDS] bracket wins over the clock', () => {
    expect(parseOffsetFromFilename('time[00:10:00][720].json')).toBe(720_000);
    expect(parseOffsetFromFilename('time[00:00:00][0].json')).toBe(0);
  });

  test('full.<ext> and bare full → 0 (single-file recording)', () => {
    expect(parseOffsetFromFilename('full.json')).toBe(0);
    expect(parseOffsetFromFilename('full.mp3')).toBe(0);
    expect(parseOffsetFromFilename('full')).toBe(0);
  });

  test('works on a bare base name (no extension) and on media extensions', () => {
    expect(parseOffsetFromFilename('time[00:10:00]')).toBe(600_000);
    expect(parseOffsetFromFilename('time[00:10:00][720]')).toBe(720_000);
    expect(parseOffsetFromFilename('time[00:10:00].m4a')).toBe(600_000);
  });

  test('ignores a leading path', () => {
    expect(parseOffsetFromFilename('transcription/talk/time[00:10:00].json')).toBe(600_000);
  });

  test('edge cases → null', () => {
    expect(parseOffsetFromFilename('lecture.mp3')).toBeNull();
    expect(parseOffsetFromFilename('time[0:10:00].json')).toBeNull(); // 1-digit hour
    expect(parseOffsetFromFilename('time[00:10].json')).toBeNull(); // missing seconds
    expect(parseOffsetFromFilename('time[00:10:00][].json')).toBeNull(); // empty bracket
    expect(parseOffsetFromFilename('mytime.json')).toBeNull();
    expect(parseOffsetFromFilename('')).toBeNull();
    expect(parseOffsetFromFilename('fullhouse.json')).toBeNull(); // not exactly "full"
  });
});

describe('matchTranscriptPairs', () => {
  test('audio + transcript pair (audio-driven)', () => {
    const pairs = matchTranscriptPairs(['time[00:10:00].mp3'], ['time[00:10:00].json'], FOLDERS);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({
      base: 'time[00:10:00]',
      mediaRelPath: 'sources/audio/talk/time[00:10:00].mp3',
      transcriptRelPath: 'transcription/talk/transcripts/time[00:10:00].json',
      missing: false,
      offsetMs: 600_000
    });
  });

  test('video files pair too', () => {
    const pairs = matchTranscriptPairs(['interview.mp4', 'clip.webm'], ['interview.json'], FOLDERS);
    const byBase = new Map(pairs.map(pair => [pair.base, pair]));
    expect(byBase.get('interview')!.mediaRelPath).toBe('sources/audio/talk/interview.mp4');
    expect(byBase.get('interview')!.missing).toBe(false);
    expect(byBase.get('clip')!.mediaRelPath).toBe('sources/audio/talk/clip.webm');
    expect(byBase.get('clip')!.missing).toBe(true);
    expect(byBase.get('clip')!.transcriptRelPath).toBe('transcription/talk/transcripts/clip.json');
  });

  test('media without a transcript → missing pair with the EXPECTED json path', () => {
    const pairs = matchTranscriptPairs(['full.mp3'], [], FOLDERS);
    expect(pairs).toEqual([
      {
        base: 'full',
        mediaRelPath: 'sources/audio/talk/full.mp3',
        transcriptRelPath: 'transcription/talk/transcripts/full.json',
        missing: true,
        offsetMs: 0
      }
    ]);
  });

  test('orphan transcript (media deleted) still surfaces, without mediaRelPath', () => {
    const pairs = matchTranscriptPairs([], ['orphan.json'], FOLDERS);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].mediaRelPath).toBeUndefined();
    expect(pairs[0].missing).toBe(false);
    expect(pairs[0].transcriptRelPath).toBe('transcription/talk/transcripts/orphan.json');
  });

  test('mismatched basenames yield two separate pairs (no cross-pairing)', () => {
    const pairs = matchTranscriptPairs(['a.mp3'], ['b.json'], FOLDERS);
    expect(pairs).toHaveLength(2);
    const byBase = new Map(pairs.map(pair => [pair.base, pair]));
    expect(byBase.get('a')!.missing).toBe(true);
    expect(byBase.get('b')!.mediaRelPath).toBeUndefined();
  });

  test('non-media and non-json files are ignored; matching is case-insensitive', () => {
    const pairs = matchTranscriptPairs(['notes.txt', 'TALK.MP3'], ['talk.yaml', 'TALK.json'], FOLDERS);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].base).toBe('TALK');
    expect(pairs[0].missing).toBe(false);
  });

  test('sorted by chunk offset, offset-less names last by numeric-aware base', () => {
    const pairs = matchTranscriptPairs(
      ['z-extra.mp3', 'time[00:20:00].mp3', 'a-extra.mp3', 'time[00:10:00].mp3'],
      [],
      FOLDERS
    );
    expect(pairs.map(pair => pair.base)).toEqual(['time[00:10:00]', 'time[00:20:00]', 'a-extra', 'z-extra']);
  });

  test('duplicate bases across extensions: first media file wins deterministically', () => {
    const pairs = matchTranscriptPairs(['talk.mp3', 'talk.mp4'], [], FOLDERS);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].mediaRelPath).toBe('sources/audio/talk/talk.mp3');
  });
});

describe('isTranscriptsetPath', () => {
  test('recognizes the sidecar under a transcription/ segment', () => {
    expect(isTranscriptsetPath('transcription/talk/transcriptset.yaml')).toBe(true);
    expect(isTranscriptsetPath('/book/transcription/talk/transcriptset.yaml')).toBe(true);
    expect(isTranscriptsetPath('C:\\book\\transcription\\talk\\transcriptset.yaml')).toBe(true);
  });

  test('rejects a stray transcriptset.yaml or another file', () => {
    expect(isTranscriptsetPath('somewhere/transcriptset.yaml')).toBe(false);
    expect(isTranscriptsetPath('transcription/talk/other.yaml')).toBe(false);
    expect(isTranscriptsetPath('')).toBe(false);
  });
});

describe('progress', () => {
  test('computeTranscriptProgress counts verified/needsRework and rounds percent', () => {
    const progress = computeTranscriptProgress([
      { verified: true, needsRework: false },
      { verified: false, needsRework: true },
      { verified: false, needsRework: false }
    ]);
    expect(progress).toEqual({ verified: 1, needsRework: 1, total: 3, percent: 33 });
  });

  test('empty set → zeroes', () => {
    expect(computeTranscriptProgress([])).toEqual({ verified: 0, needsRework: 0, total: 0, percent: 0 });
  });

  test('computeSegmentFillProgress counts non-blank texts', () => {
    const progress = computeSegmentFillProgress([{ text: 'a' }, { text: '   ' }, { text: '' }, {}]);
    expect(progress).toEqual({ filled: 1, total: 4, percent: 25 });
  });

  test('formatTranscriptProgressChip renders N/M ✓', () => {
    expect(formatTranscriptProgressChip({ verified: 2, total: 5 })).toBe('2/5 ✓');
    expect(formatTranscriptProgressChip({ verified: 0, total: 0 })).toBe('0/0 ✓');
  });
});

describe('VALID_PLAYBACK_RATES', () => {
  test('the 13 source-app rates, ascending', () => {
    expect(VALID_PLAYBACK_RATES).toHaveLength(13);
    expect(VALID_PLAYBACK_RATES[0]).toBe(1 / 4);
    expect(VALID_PLAYBACK_RATES).toContain(1);
    expect(VALID_PLAYBACK_RATES[VALID_PLAYBACK_RATES.length - 1]).toBe(4);
    const sorted = [...VALID_PLAYBACK_RATES].sort((a, b) => a - b);
    expect(sorted).toEqual([...VALID_PLAYBACK_RATES]);
  });
});
