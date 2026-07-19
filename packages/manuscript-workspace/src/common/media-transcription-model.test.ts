import { describe, expect, test } from 'bun:test';
import {
  extractStartTimeFromName,
  formatRawMdTime,
  mediaOutputFolderName,
  mergeTranscriptionsToRawMd,
  normalizeWhisperJson,
  planSegments,
  renderRawMdBlock,
  segmentBaseNameForEndTime,
  selectSilenceCutPoints
} from './media-transcription-model';
import { parseOffsetFromFilename } from './transcript-set-model';

describe('segmentBaseNameForEndTime', () => {
  test('formats the converter naming convention exactly', () => {
    expect(segmentBaseNameForEndTime(623)).toBe('time[00:10:23][623]');
    expect(segmentBaseNameForEndTime(0)).toBe('time[00:00:00][0]');
    expect(segmentBaseNameForEndTime(3601)).toBe('time[01:00:01][3601]');
    expect(segmentBaseNameForEndTime(36_125)).toBe('time[10:02:05][36125]');
  });

  test('offset bracket is UNPADDED integer seconds', () => {
    expect(segmentBaseNameForEndTime(59)).toBe('time[00:00:59][59]');
    expect(segmentBaseNameForEndTime(600)).toBe('time[00:10:00][600]');
  });

  test('floors fractional input consistently in clock and bracket', () => {
    expect(segmentBaseNameForEndTime(623.9)).toBe('time[00:10:23][623]');
  });

  test('round-trips with the editor parseOffsetFromFilename (ms)', () => {
    for (const seconds of [1, 59, 600, 623, 3599, 3600, 7261]) {
      const name = `${segmentBaseNameForEndTime(seconds)}.mp3`;
      expect(parseOffsetFromFilename(name)).toBe(seconds * 1000);
    }
    expect(parseOffsetFromFilename('full.mp3')).toBe(0);
  });
});

describe('mediaOutputFolderName', () => {
  test('replaces spaces with underscores and strips the extension', () => {
    expect(mediaOutputFolderName('/some/dir/My Lecture 01.mp4')).toBe('My_Lecture_01');
    expect(mediaOutputFolderName('Лекция про ум.mp3')).toBe('Лекция_про_ум');
  });

  test('keeps dot-leading names and inner dots like path.parse', () => {
    expect(mediaOutputFolderName('/a/b/rec.v2.final.mov')).toBe('rec.v2.final');
    expect(mediaOutputFolderName('/a/.hidden')).toBe('.hidden');
  });
});

describe('selectSilenceCutPoints', () => {
  const start = (sec: number) => `[silencedetect @ 0x7f8] silence_start: ${sec}`;
  const end = (sec: number, dur: number) => `[silencedetect @ 0x7f8] silence_end: ${sec} | silence_duration: ${dur}`;

  test('picks the ceil of the LAST silence start per segment bucket, sorted', () => {
    const lines = [
      start(100.2), end(101.5, 1.3),
      start(550.7), end(552.0, 1.3), // last in bucket 0 → ceil(550.7) = 551
      start(700.1), end(701.4, 1.3),
      start(1100.9), end(1102.2, 1.3) // last in bucket 1 → ceil(1100.9) = 1101
    ];
    expect(selectSilenceCutPoints(lines, 600)).toEqual([551, 1101]);
  });

  test('empty input yields no cut points', () => {
    expect(selectSilenceCutPoints([], 600)).toEqual([]);
  });

  test('an end line without a preceding start is ignored', () => {
    expect(selectSilenceCutPoints([end(50, 2)], 600)).toEqual([]);
  });

  test('a trailing unpaired silence_start still participates (source quirk)', () => {
    expect(selectSilenceCutPoints([start(100.2), end(101.5, 1.3), start(590.4)], 600)).toEqual([591]);
  });

  test('a zero cut point is dropped (filter(Boolean) port)', () => {
    // silence starting at 0 in bucket 0 as the last entry → Math.ceil(0) = 0 → dropped
    expect(selectSilenceCutPoints([start(0), end(1.5, 1.5)], 600)).toEqual([]);
  });

  test('groups by floor(start / segmentSeconds) with a custom segment length', () => {
    const lines = [start(30.5), end(32, 1.5), start(80.5), end(82, 1.5)];
    expect(selectSilenceCutPoints(lines, 60)).toEqual([31, 81]);
  });
});

describe('planSegments', () => {
  test('no cut points → one whole-file segment', () => {
    expect(planSegments(1000, [])).toEqual([
      { startSec: 0, endSec: 1000, baseName: 'time[00:16:40][1000]' }
    ]);
  });

  test('appends the duration when the last cut falls short', () => {
    expect(planSegments(1500, [551, 1101])).toEqual([
      { startSec: 0, endSec: 551, baseName: segmentBaseNameForEndTime(551) },
      { startSec: 551, endSec: 1101, baseName: segmentBaseNameForEndTime(1101) },
      { startSec: 1101, endSec: 1500, baseName: segmentBaseNameForEndTime(1500) }
    ]);
  });

  test('does not append when the last cut equals the duration', () => {
    const plan = planSegments(1101, [551, 1101]);
    expect(plan.map(p => p.endSec)).toEqual([551, 1101]);
  });

  test('skips inverted/empty intervals', () => {
    const plan = planSegments(1200, [600, 600, 500]);
    // cuts arrive sorted from selectSilenceCutPoints; unsorted junk is skipped
    expect(plan.map(p => [p.startSec, p.endSec])).toEqual([[0, 600], [600, 1200]]);
  });
});

describe('normalizeWhisperJson — whisper.cpp shape', () => {
  const whisperOutput = {
    systeminfo: 'AVX = 1',
    model: { type: 'large-v3-turbo' },
    params: { language: 'auto' },
    result: { language: 'ru' },
    transcription: [
      {
        timestamps: { from: '00:00:00,000', to: '00:00:04,500' },
        offsets: { from: 0, to: 4500 },
        text: ' Привет мир',
        tokens: [50365, { id: 12345 }, { id: '777' }, { t: 1 }, 'junk', { id: 'abc' }]
      },
      {
        timestamps: { from: '00:00:04,500', to: '00:00:10,250' },
        offsets: { from: 4500, to: 10250 },
        text: ' продолжение '
      }
    ]
  };

  test('offsets are MILLISECONDS: start/end divide by 1000, seek keeps ms', () => {
    const normalized = normalizeWhisperJson(whisperOutput);
    expect(normalized.segments).toHaveLength(2);
    expect(normalized.segments[0]).toEqual({
      id: 0,
      seek: 0,
      start: 0,
      end: 4.5,
      text: ' Привет мир',
      tokens: [50365, 12345, 777],
      temperature: 0,
      avg_logprob: 0,
      compression_ratio: 0,
      no_speech_prob: 0
    });
    expect(normalized.segments[1].seek).toBe(4500);
    expect(normalized.segments[1].start).toBe(4.5);
    expect(normalized.segments[1].end).toBe(10.25);
    expect(normalized.segments[1].tokens).toEqual([]);
  });

  test('text joins segment texts with spaces trimmed; language from result.language', () => {
    const normalized = normalizeWhisperJson(whisperOutput);
    expect(normalized.text).toBe('Привет мир  продолжение');
    expect(normalized.language).toBe('ru');
  });

  test('language falls back to params.language then auto', () => {
    expect(normalizeWhisperJson({ transcription: [], params: { language: 'en' } }).language).toBe('en');
    expect(normalizeWhisperJson({ transcription: [] }).language).toBe('auto');
  });

  test('missing offsets coerce to zero', () => {
    const normalized = normalizeWhisperJson({ transcription: [{ text: 'x' }] });
    expect(normalized.segments[0].seek).toBe(0);
    expect(normalized.segments[0].start).toBe(0);
    expect(normalized.segments[0].end).toBe(0);
  });
});

describe('normalizeWhisperJson — Groq verbose_json / normalized shape', () => {
  const groqOutput = {
    task: 'transcribe',
    language: 'Russian',
    duration: 8.2,
    text: ' Привет мир продолжение ',
    segments: [
      {
        id: 0,
        seek: 0,
        start: 0.0,
        end: 4.5,
        text: ' Привет мир',
        tokens: [50365, 50366],
        temperature: 0.0,
        avg_logprob: -0.21,
        compression_ratio: 1.1,
        no_speech_prob: 0.01
      },
      {
        id: 1,
        seek: 450,
        start: 4.5,
        end: 8.2,
        text: ' продолжение',
        tokens: [50367],
        temperature: 0.0,
        avg_logprob: -0.3,
        compression_ratio: 1.2,
        no_speech_prob: 0.02
      }
    ],
    x_groq: { id: 'req_123' }
  };

  test('segments pass through in float seconds with statistics preserved', () => {
    const normalized = normalizeWhisperJson(groqOutput);
    expect(normalized.segments[1]).toEqual({
      id: 1,
      seek: 450,
      start: 4.5,
      end: 8.2,
      text: ' продолжение',
      tokens: [50367],
      temperature: 0,
      avg_logprob: -0.3,
      compression_ratio: 1.2,
      no_speech_prob: 0.02
    });
    expect(normalized.text).toBe(' Привет мир продолжение ');
    expect(normalized.language).toBe('Russian');
  });

  test('numeric strings coerce via tonumber?, junk coerces to 0', () => {
    const normalized = normalizeWhisperJson({
      segments: [{ start: '1.5', end: '2.5', text: 'x', avg_logprob: 'oops', seek: '100' }]
    });
    expect(normalized.segments[0].start).toBe(1.5);
    expect(normalized.segments[0].end).toBe(2.5);
    expect(normalized.segments[0].seek).toBe(100);
    expect(normalized.segments[0].avg_logprob).toBe(0);
  });

  test('missing id falls back to the entry index; missing text to the joined text', () => {
    const normalized = normalizeWhisperJson({
      segments: [{ start: 0, end: 1, text: ' a ' }, { start: 1, end: 2, text: 'b' }]
    });
    expect(normalized.segments.map(s => s.id)).toEqual([0, 1]);
    expect(normalized.text).toBe('a  b');
  });

  test('is IDEMPOTENT: normalizing the normalized output is a no-op', () => {
    const once = normalizeWhisperJson(groqOutput);
    const twice = normalizeWhisperJson(once);
    expect(twice).toEqual(once);
    const whisperOnce = normalizeWhisperJson({
      result: { language: 'ru' },
      transcription: [{ offsets: { from: 1000, to: 2000 }, text: 'x', tokens: [1] }]
    });
    expect(normalizeWhisperJson(whisperOnce)).toEqual(whisperOnce);
  });
});

describe('normalizeWhisperJson — degenerate shapes', () => {
  test('neither transcription nor segments → empty segments passthrough', () => {
    expect(normalizeWhisperJson({ text: 'plain', language: 'en' })).toEqual({
      text: 'plain',
      language: 'en',
      segments: []
    });
    expect(normalizeWhisperJson({})).toEqual({ text: '', language: 'auto', segments: [] });
    expect(normalizeWhisperJson(null)).toEqual({ text: '', language: 'auto', segments: [] });
    expect(normalizeWhisperJson('garbage')).toEqual({ text: '', language: 'auto', segments: [] });
  });
});

describe('formatRawMdTime / extractStartTimeFromName', () => {
  test('formats HH:MM:SS.mmm flooring the milliseconds', () => {
    expect(formatRawMdTime(0)).toBe('00:00:00.000');
    expect(formatRawMdTime(3725.5)).toBe('01:02:05.500');
    expect(formatRawMdTime(59.9994)).toBe('00:00:59.999');
  });

  test('extracts the clock start time from time[HH:MM:SS] names', () => {
    expect(extractStartTimeFromName('time[00:10:23][623].json')).toBe(623);
    expect(extractStartTimeFromName('time[01:00:00][3600].json')).toBe(3600);
    expect(extractStartTimeFromName('time[42].json')).toBe(42);
    expect(extractStartTimeFromName('full.json')).toBeNull();
  });
});

describe('renderRawMdBlock / mergeTranscriptionsToRawMd (parse.ts port)', () => {
  test('renders start-stamped lines plus the trailing end-time line', () => {
    const rendered = renderRawMdBlock(
      { segments: [{ start: 0, end: 2.5, text: ' hello ' }, { start: 2.5, end: 5, text: 'world' }] },
      0
    );
    expect(rendered.text).toBe('00:00:00.000: hello\n00:00:02.500: world\n00:00:05.000');
    expect(rendered.lastEndTime).toBe(5);
  });

  test('applies the running lastEndTime continuity offset', () => {
    const rendered = renderRawMdBlock({ segments: [{ start: 1, end: 3, text: 'later' }] }, 600);
    expect(rendered.text).toBe('00:10:01.000: later\n00:10:03.000');
    expect(rendered.lastEndTime).toBe(603);
  });

  test('empty segments render an empty block and keep continuity unchanged', () => {
    expect(renderRawMdBlock({ segments: [] }, 42)).toEqual({ text: '', lastEndTime: 42 });
    expect(renderRawMdBlock({}, 42)).toEqual({ text: '', lastEndTime: 42 });
  });

  test('merges files ordered by their time[...] name with blank-line joins', () => {
    const merged = mergeTranscriptionsToRawMd([
      {
        name: 'time[00:20:00][1200].json',
        data: { segments: [{ start: 0, end: 30, text: 'second chunk' }] }
      },
      {
        name: 'time[00:10:00][600].json',
        data: { segments: [{ start: 0, end: 600, text: 'first chunk' }] }
      }
    ]);
    expect(merged).toBe(
      '00:00:00.000: first chunk\n00:10:00.000\n\n' +
      '00:10:00.000: second chunk\n00:10:30.000'
    );
  });

  test('offset-less names sort last (Infinity fallback)', () => {
    const merged = mergeTranscriptionsToRawMd([
      { name: 'zz-notes.json', data: { segments: [{ start: 0, end: 1, text: 'tail' }] } },
      { name: 'time[00:10:00][600].json', data: { segments: [{ start: 0, end: 600, text: 'head' }] } }
    ]);
    expect(merged.startsWith('00:00:00.000: head')).toBe(true);
    expect(merged).toContain('00:10:00.000: tail');
  });

  test('single full.json merges as one block with no trailing newline', () => {
    const merged = mergeTranscriptionsToRawMd([
      { name: 'full.json', data: { segments: [{ start: 0, end: 4, text: 'only' }] } }
    ]);
    expect(merged).toBe('00:00:00.000: only\n00:00:04.000');
  });
});
