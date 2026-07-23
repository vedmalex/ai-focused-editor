import { describe, expect, test } from 'bun:test';
import {
  RawMdSourceFile,
  flattenRawMdSegments,
  formatTimeAbsolute,
  generateRawMd,
  parseRawMdLines,
  parseTimeAbsoluteToSeconds,
  resolveRawMdTarget,
  sortRawMdFiles
} from './raw-md';
import { TranscriptSpeaker } from './transcript-speakers';

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'a', name: 'Alice' },
  { id: 'b', name: 'Bob' }
];

describe('formatTimeAbsolute', () => {
  test('formats HH:MM:SS.mmm with padding', () => {
    expect(formatTimeAbsolute(0)).toBe('00:00:00.000');
    expect(formatTimeAbsolute(3723.456)).toBe('01:02:03.456');
    expect(formatTimeAbsolute(59.9994)).toBe('00:00:59.999');
  });
});

describe('sortRawMdFiles', () => {
  test('known offsets ascending, offset-less last by name', () => {
    const sorted = sortRawMdFiles([
      { name: 'z.json', offsetMs: null },
      { name: 'b.json', offsetMs: 1_200_000 },
      { name: 'a.json', offsetMs: null },
      { name: 'c.json', offsetMs: 600_000 }
    ]);
    expect(sorted.map(file => file.name)).toEqual(['c.json', 'b.json', 'a.json', 'z.json']);
  });
});

describe('generateRawMd', () => {
  test('single file at offset 0-equivalent: absolute time = fileStart + segment end', () => {
    // Chunk covers [0, 600s]; the offset names its END (600s) so fileStart = 0.
    const files: RawMdSourceFile[] = [
      {
        name: 'time[00:10:00].json',
        offsetMs: 600_000,
        segments: [
          { _id: 's1', start: 0, end: 300, text: 'first half', speakerId: 'a' },
          { _id: 's2', start: 300, end: 600, text: 'second half' }
        ]
      }
    ];
    expect(generateRawMd(files, SPEAKERS)).toBe(['00:05:00.000 [Alice]: first half', '00:10:00.000: second half', ''].join('\n'));
  });

  test('multi-file: absolute timestamps continue across chunks and files are offset-ordered', () => {
    const files: RawMdSourceFile[] = [
      {
        // Second chunk [600s, 1200s] listed FIRST — ordering must fix it.
        name: 'time[00:20:00].json',
        offsetMs: 1_200_000,
        segments: [{ _id: 's3', start: 0, end: 600, text: 'minute twenty', speakerId: 'a' }]
      },
      {
        name: 'time[00:10:00].json',
        offsetMs: 600_000,
        segments: [{ _id: 's1', start: 0, end: 600, text: 'minute ten', speakerId: 'a' }]
      }
    ];
    const rawMd = generateRawMd(files, SPEAKERS);
    expect(rawMd).toBe(['00:10:00.000 [Alice]: minute ten', '00:20:00.000: minute twenty', ''].join('\n'));
  });

  test('speaker-change labels: emitted only on change, carry-forward across files', () => {
    const files: RawMdSourceFile[] = [
      {
        name: 'time[00:01:00].json',
        offsetMs: 60_000,
        segments: [
          { _id: 's1', start: 0, end: 20, text: 'alice one', speakerId: 'a' },
          { _id: 's2', start: 20, end: 40, text: 'alice two' }, // inherited — no label
          { _id: 's3', start: 40, end: 60, text: 'bob one', speakerId: 'b' }
        ]
      },
      {
        name: 'time[00:02:00].json',
        offsetMs: 120_000,
        segments: [
          { _id: 's4', start: 0, end: 30, text: 'bob still' }, // inherits Bob from previous FILE
          { _id: 's5', start: 30, end: 60, text: 'alice back', speakerId: 'a' }
        ]
      }
    ];
    const lines = generateRawMd(files, SPEAKERS).trimEnd().split('\n');
    expect(lines).toEqual([
      '00:00:20.000 [Alice]: alice one',
      '00:00:40.000: alice two',
      '00:01:00.000 [Bob]: bob one',
      '00:01:30.000: bob still',
      '00:02:00.000 [Alice]: alice back'
    ]);
  });

  test('legacy free-text speaker fields resolve when no registry id matches', () => {
    const files: RawMdSourceFile[] = [
      {
        name: 'full.json',
        offsetMs: 0,
        segments: [{ _id: 's1', start: 0, end: 10, text: 'legacy', speaker: 'Old Style' }]
      }
    ];
    expect(generateRawMd(files, [])).toBe('00:00:10.000 [Old Style]: legacy\n');
  });

  test('string start/end values are coerced (foreign whisper payloads)', () => {
    const files: RawMdSourceFile[] = [
      {
        name: 'full.json',
        offsetMs: 0,
        segments: [{ _id: 's1', start: 0, end: '12.5' as unknown as number, text: 'coerced' }]
      }
    ];
    expect(generateRawMd(files, [])).toBe('00:00:12.500: coerced\n');
  });

  test('deterministic: two runs over the same inputs are byte-identical; empty inputs → empty string', () => {
    const files: RawMdSourceFile[] = [
      {
        name: 'time[00:10:00].json',
        offsetMs: 600_000,
        segments: [{ _id: 's1', start: 0, end: 600, text: 'x', speakerId: 'a' }]
      }
    ];
    expect(generateRawMd(files, SPEAKERS)).toBe(generateRawMd(files, SPEAKERS));
    expect(generateRawMd([], SPEAKERS)).toBe('');
    expect(generateRawMd([{ name: 'empty.json', offsetMs: 0, segments: [] }], SPEAKERS)).toBe('');
  });
});

describe('parseRawMdLines — the reconcile surface', () => {
  test('round-trip: generate → parse recovers per-segment text and change-only speaker labels', () => {
    const files: RawMdSourceFile[] = [
      {
        name: 'time[00:01:00].json',
        offsetMs: 60_000,
        segments: [
          { _id: 's1', start: 0, end: 20, text: 'alice one', speakerId: 'a' },
          { _id: 's2', start: 20, end: 40, text: 'alice two' },
          { _id: 's3', start: 40, end: 60, text: 'bob one', speakerId: 'b' }
        ]
      }
    ];
    const parsed = parseRawMdLines(generateRawMd(files, SPEAKERS));
    expect(parsed).toHaveLength(3);
    expect(parsed.map(line => line.text)).toEqual(['alice one', 'alice two', 'bob one']);
    expect(parsed.map(line => line.speakerLabel)).toEqual(['Alice', undefined, 'Bob']);
    expect(parsed.map(line => line.time)).toEqual(['00:00:20.000', '00:00:40.000', '00:01:00.000']);
  });

  test('positional mapping: parsed line order matches the flattened segment order', () => {
    const files: RawMdSourceFile[] = [
      {
        name: 'time[00:10:00].json',
        offsetMs: 600_000,
        segments: [
          { _id: 's1', start: 0, end: 300, text: 'one' },
          { _id: 's2', start: 300, end: 600, text: 'two' }
        ]
      }
    ];
    const parsed = parseRawMdLines(generateRawMd(files, []));
    // A reconciler zips parsed[i] ↔ flattened segment i and writes edited
    // text back via recordSegmentTextChange, then regenerates raw.md.
    expect(parsed.map(line => line.text)).toEqual(['one', 'two']);
  });

  test('a segment text containing ": " still parses (first-match split)', () => {
    const files: RawMdSourceFile[] = [
      {
        name: 'full.json',
        offsetMs: 0,
        segments: [{ _id: 's1', start: 0, end: 5, text: 'note: keep [this]: intact' }]
      }
    ];
    const parsed = parseRawMdLines(generateRawMd(files, []));
    expect(parsed[0].text).toBe('note: keep [this]: intact');
  });

  test('foreign/edited lines without a timestamp surface with raw text only', () => {
    const parsed = parseRawMdLines(['00:00:10.000: real line', 'user added a note', ''].join('\n'));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].time).toBe('00:00:10.000');
    expect(parsed[1].time).toBeUndefined();
    expect(parsed[1].text).toBe('user added a note');
  });
});

describe('flattenRawMdSegments — the RawMdWidget (TASK-016 U4b) target-resolution surface', () => {
  const MULTI_FILE: RawMdSourceFile[] = [
    {
      // Second chunk listed FIRST — sortRawMdFiles must reorder it.
      name: 'time[00:02:00].json',
      offsetMs: 120_000,
      segments: [
        { _id: 's4', start: 0, end: 30, text: 'bob still' },
        { _id: 's5', start: 30, end: 60, text: 'alice back', speakerId: 'a' }
      ]
    },
    {
      name: 'time[00:01:00].json',
      offsetMs: 60_000,
      segments: [
        { _id: 's1', start: 0, end: 20, text: 'alice one', speakerId: 'a' },
        { _id: 's2', start: 20, end: 40, text: 'alice two' },
        { _id: 's3', start: 40, end: 60, text: 'bob one', speakerId: 'b' }
      ]
    }
  ];

  test('flattens in sortRawMdFiles order with localIndex reset per file and carried-forward speaker', () => {
    const flat = flattenRawMdSegments(MULTI_FILE, SPEAKERS);
    expect(flat.map(seg => ({ base: seg.base, localIndex: seg.localIndex }))).toEqual([
      { base: 'time[00:01:00].json', localIndex: 0 },
      { base: 'time[00:01:00].json', localIndex: 1 },
      { base: 'time[00:01:00].json', localIndex: 2 },
      { base: 'time[00:02:00].json', localIndex: 0 },
      { base: 'time[00:02:00].json', localIndex: 1 }
    ]);
    expect(flat.map(seg => seg.absoluteTime)).toEqual([20, 40, 60, 90, 120]);
    // Carry-forward: every entry's speakerLabel is the EFFECTIVE speaker
    // (never '' once one has been established), unlike generateRawMd's
    // change-only marker.
    expect(flat.map(seg => seg.speakerLabel)).toEqual(['Alice', 'Alice', 'Bob', 'Bob', 'Alice']);
  });

  test('invariant: generateRawMd is exactly flattenRawMdSegments formatted change-only', () => {
    const flat = flattenRawMdSegments(MULTI_FILE, SPEAKERS);
    let lastEmitted = '';
    const expectedLines = flat.map(seg => {
      const changed = !!seg.speakerLabel && seg.speakerLabel !== lastEmitted;
      const prefix = changed ? ` [${seg.speakerLabel}]` : '';
      if (seg.speakerLabel) {
        lastEmitted = seg.speakerLabel;
      }
      return `${formatTimeAbsolute(seg.absoluteTime)}${prefix}: ${seg.text}`;
    });
    expect(generateRawMd(MULTI_FILE, SPEAKERS)).toBe(expectedLines.join('\n') + '\n');
  });

  test('empty files/segments produce an empty flatten (mirrors generateRawMd emptiness)', () => {
    expect(flattenRawMdSegments([], SPEAKERS)).toEqual([]);
    expect(flattenRawMdSegments([{ name: 'empty.json', offsetMs: 0, segments: [] }], SPEAKERS)).toEqual([]);
  });
});

describe('resolveRawMdTarget — positional-first, time-nearest fallback', () => {
  const FLAT = flattenRawMdSegments(
    [
      {
        name: 'time[00:01:00].json',
        offsetMs: 60_000,
        segments: [
          { _id: 's1', start: 0, end: 20, text: 'alice one', speakerId: 'a' },
          { _id: 's2', start: 20, end: 40, text: 'alice two' },
          { _id: 's3', start: 40, end: 60, text: 'bob one', speakerId: 'b' }
        ]
      }
    ],
    SPEAKERS
  );

  test('in range: resolves positionally, ignoring timeSeconds entirely', () => {
    expect(resolveRawMdTarget(1, 999_999, FLAT)).toEqual({ base: 'time[00:01:00].json', localIndex: 1 });
  });

  test('out of range with a usable timeSeconds: falls back to the nearest absoluteTime', () => {
    // FLAT absoluteTimes are [20, 40, 60]; 41 is nearest to index 1 (40).
    expect(resolveRawMdTarget(5, 41, FLAT)).toEqual({ base: 'time[00:01:00].json', localIndex: 1 });
    // Nearest to the last segment (60).
    expect(resolveRawMdTarget(5, 58, FLAT)).toEqual({ base: 'time[00:01:00].json', localIndex: 2 });
  });

  test('out of range with no timeSeconds: undefined (nothing sane to resolve to)', () => {
    expect(resolveRawMdTarget(5, undefined, FLAT)).toBeUndefined();
    expect(resolveRawMdTarget(5, Number.NaN, FLAT)).toBeUndefined();
  });

  test('empty segments: always undefined', () => {
    expect(resolveRawMdTarget(0, 0, [])).toBeUndefined();
  });
});

describe('parseTimeAbsoluteToSeconds — the inverse of formatTimeAbsolute', () => {
  test('round-trips formatTimeAbsolute for whole and fractional seconds', () => {
    expect(parseTimeAbsoluteToSeconds('00:00:00.000')).toBe(0);
    expect(parseTimeAbsoluteToSeconds('01:02:03.456')).toBeCloseTo(3723.456, 6);
    expect(formatTimeAbsolute(parseTimeAbsoluteToSeconds('01:02:03.456')!)).toBe('01:02:03.456');
  });

  test('non-matching input yields undefined', () => {
    expect(parseTimeAbsoluteToSeconds('not-a-time')).toBeUndefined();
    expect(parseTimeAbsoluteToSeconds('1:2:3.456')).toBeUndefined();
  });
});
