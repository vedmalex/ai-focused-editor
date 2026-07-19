import { describe, expect, test } from 'bun:test';
import {
  SEGMENT_HISTORY_CAP,
  TRANSCRIBER_METADATA_VERSION,
  TranscriptDocument,
  TranscriptSegment,
  capSegmentHistory,
  createHistoryEntry,
  ensureSegmentIds,
  ensureTranscriptMetadata,
  getSegmentHistory,
  getSegmentProofread,
  getSegmentTranscription,
  migrateLegacySpeakerFields,
  normalizeProofreadIssues,
  recordSegmentTextChange,
  restoreSegmentHistoryEntry,
  setSegmentProofreadResult,
  setSegmentTranscriptionResult,
  withSegmentCollection
} from './transcript-metadata';

function doc(segments: TranscriptSegment[]): TranscriptDocument {
  return { segments };
}

describe('ensureSegmentIds', () => {
  test('assigns ids only to segments lacking one and returns a new array', () => {
    let counter = 0;
    const segments: TranscriptSegment[] = [
      { _id: 'keep', start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'b' }
    ];
    const result = ensureSegmentIds(segments, () => `id-${++counter}`);
    expect(result).not.toBe(segments);
    expect(result[0]._id).toBe('keep');
    expect(result[1]._id).toBe('id-1');
  });

  test('returns the SAME array when every segment already has an id', () => {
    const segments: TranscriptSegment[] = [{ _id: 'x', start: 0, end: 1, text: 'a' }];
    expect(ensureSegmentIds(segments)).toBe(segments);
  });
});

describe('ensureTranscriptMetadata', () => {
  test('builds the version-2 metadata block from nothing', () => {
    const { transcript, changed } = ensureTranscriptMetadata(undefined);
    expect(changed).toBe(true);
    expect(transcript.segments).toEqual([]);
    expect(transcript._transcriber!.version).toBe(TRANSCRIBER_METADATA_VERSION);
    expect(transcript._transcriber!.segmentHistory).toEqual({});
    expect(transcript._transcriber!.segmentProofreads).toEqual({});
    expect(transcript._transcriber!.segmentTranscriptions).toEqual({});
  });

  test('seeds an initial history entry per segment with an id', () => {
    const { transcript } = ensureTranscriptMetadata(doc([{ _id: 's1', start: 0, end: 1, text: 'hello' }]));
    const history = getSegmentHistory(transcript, 's1');
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe('hello');
    expect(history[0].source).toBe('initial');
  });

  test('appends a sync entry when the stored text drifted past the last history entry', () => {
    const first = ensureTranscriptMetadata(doc([{ _id: 's1', start: 0, end: 1, text: 'v1' }])).transcript;
    const drifted: TranscriptDocument = {
      ...first,
      segments: [{ ...first.segments[0], text: 'v2' }]
    };
    const { transcript, changed } = ensureTranscriptMetadata(drifted);
    expect(changed).toBe(true);
    const history = getSegmentHistory(transcript, 's1');
    expect(history.map(entry => [entry.text, entry.source])).toEqual([
      ['v1', 'initial'],
      ['v2', 'sync']
    ]);
  });

  test('is a no-op (same object) on an already-normalized transcript', () => {
    const first = ensureTranscriptMetadata(doc([{ _id: 's1', start: 0, end: 1, text: 'v1' }])).transcript;
    const second = ensureTranscriptMetadata(first);
    expect(second.changed).toBe(false);
    expect(second.transcript).toBe(first);
  });

  test('does NOT truncate an over-cap persisted history (loss-free load)', () => {
    const longHistory = Array.from({ length: SEGMENT_HISTORY_CAP + 5 }, (_, i) => createHistoryEntry(`v${i}`, 'manual'));
    longHistory[longHistory.length - 1] = { ...longHistory[longHistory.length - 1], text: 'latest' };
    const transcript: TranscriptDocument = {
      segments: [{ _id: 's1', start: 0, end: 1, text: 'latest' }],
      _transcriber: {
        version: 2,
        segmentHistory: { s1: longHistory },
        segmentProofreads: {},
        segmentTranscriptions: {}
      }
    };
    const { transcript: normalized } = ensureTranscriptMetadata(transcript);
    expect(getSegmentHistory(normalized, 's1')).toHaveLength(SEGMENT_HISTORY_CAP + 5);
  });
});

describe('recordSegmentTextChange — history capping', () => {
  test('records a manual entry with note and updates the segment text', () => {
    const base = doc([{ _id: 's1', start: 0, end: 1, text: 'orig' }]);
    const next = recordSegmentTextChange(base, 0, 'edited', { note: 'fix typo' })!;
    expect(next.segments[0].text).toBe('edited');
    const history = getSegmentHistory(next, 's1');
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ text: 'edited', source: 'manual', note: 'fix typo' });
  });

  test('no new entry when the text equals the last history entry', () => {
    const base = recordSegmentTextChange(doc([{ _id: 's1', start: 0, end: 1, text: 'orig' }]), 0, 'edited')!;
    const next = recordSegmentTextChange(base, 0, 'edited')!;
    expect(getSegmentHistory(next, 's1')).toHaveLength(2);
  });

  test('exceeding the cap drops the OLDEST entries (last CAP kept)', () => {
    let transcript: TranscriptDocument | undefined = doc([{ _id: 's1', start: 0, end: 1, text: 'v0' }]);
    for (let i = 1; i <= SEGMENT_HISTORY_CAP + 10; i++) {
      transcript = recordSegmentTextChange(transcript, 0, `v${i}`);
    }
    const history = getSegmentHistory(transcript, 's1');
    expect(history).toHaveLength(SEGMENT_HISTORY_CAP);
    // Newest survives; the very oldest ('v0' initial and early edits) are gone.
    expect(history[history.length - 1].text).toBe(`v${SEGMENT_HISTORY_CAP + 10}`);
    expect(history[0].text).toBe(`v${11}`);
    expect(history.some(entry => entry.text === 'v0')).toBe(false);
  });

  test('returns the transcript untouched for an unknown index', () => {
    const base = doc([{ _id: 's1', start: 0, end: 1, text: 'a' }]);
    expect(recordSegmentTextChange(base, 5, 'x')).toBe(base);
  });
});

describe('restoreSegmentHistoryEntry', () => {
  test('restores an older text as a NEW capped history-restore entry', () => {
    let transcript = recordSegmentTextChange(doc([{ _id: 's1', start: 0, end: 1, text: 'v1' }]), 0, 'v2')!;
    const older = getSegmentHistory(transcript, 's1')[0];
    transcript = restoreSegmentHistoryEntry(transcript, 0, older)!;
    expect(transcript.segments[0].text).toBe('v1');
    const history = getSegmentHistory(transcript, 's1');
    expect(history[history.length - 1]).toMatchObject({
      text: 'v1',
      source: 'history-restore'
    });
    expect(history[history.length - 1].note).toContain(older.createdAt);
  });

  test('restore still works after the cap dropped the oldest entries', () => {
    let transcript: TranscriptDocument | undefined = doc([{ _id: 's1', start: 0, end: 1, text: 'v0' }]);
    for (let i = 1; i <= SEGMENT_HISTORY_CAP + 3; i++) {
      transcript = recordSegmentTextChange(transcript, 0, `v${i}`);
    }
    const survivor = getSegmentHistory(transcript, 's1')[0];
    const restored = restoreSegmentHistoryEntry(transcript, 0, survivor)!;
    expect(restored.segments[0].text).toBe(survivor.text);
    expect(getSegmentHistory(restored, 's1').length).toBeLessThanOrEqual(SEGMENT_HISTORY_CAP);
  });

  test('ignores a malformed entry', () => {
    const base = doc([{ _id: 's1', start: 0, end: 1, text: 'a' }]);
    expect(restoreSegmentHistoryEntry(base, 0, { text: undefined as unknown as string })).toBe(base);
  });
});

describe('capSegmentHistory', () => {
  test('keeps the LAST cap entries', () => {
    const entries = Array.from({ length: SEGMENT_HISTORY_CAP + 2 }, (_, i) => createHistoryEntry(`v${i}`));
    const capped = capSegmentHistory(entries);
    expect(capped).toHaveLength(SEGMENT_HISTORY_CAP);
    expect(capped[0].text).toBe('v2');
    expect(capped[capped.length - 1].text).toBe(`v${SEGMENT_HISTORY_CAP + 1}`);
  });

  test('copies but never truncates an under-cap list', () => {
    const entries = [createHistoryEntry('a')];
    const capped = capSegmentHistory(entries);
    expect(capped).toEqual(entries);
    expect(capped).not.toBe(entries);
  });
});

describe('proofread / transcription results', () => {
  test('setSegmentProofreadResult normalizes fields and filters message-less issues', () => {
    const base = doc([{ _id: 's1', start: 0, end: 1, text: 'a' }]);
    const next = setSegmentProofreadResult(base, 's1', {
      provider: 'p',
      model: 'm',
      summary: 'sum',
      correctedText: 'fixed',
      sourceText: 'a',
      issues: [
        { type: 'spelling', severity: 'warn', message: 'typo', excerpt: 'a', suggestion: 'b' },
        { type: 'empty' }, // no message → dropped
        'garbage'
      ]
    })!;
    const stored = getSegmentProofread(next, 's1')!;
    expect(stored.correctedText).toBe('fixed');
    expect(stored.issues).toHaveLength(1);
    expect(stored.issues[0]).toMatchObject({ type: 'spelling', severity: 'warn', message: 'typo' });
    expect(stored.issues[0].id).toBeTruthy();
    expect(stored.updatedAt).toBeTruthy();
  });

  test('setSegmentTranscriptionResult maps payload `text` to on-disk `suggestedText`', () => {
    const base = doc([{ _id: 's1', start: 0, end: 1, text: 'a' }]);
    const next = setSegmentTranscriptionResult(base, 's1', {
      provider: 'stt',
      model: 'whisper',
      text: 'recognized',
      sourceText: 'a',
      raw: { chunks: 1 }
    })!;
    const stored = getSegmentTranscription(next, 's1')!;
    expect(stored.suggestedText).toBe('recognized');
    expect(stored.raw).toEqual({ chunks: 1 });
  });

  test('both return the transcript unchanged without a segment id', () => {
    const base = doc([{ _id: 's1', start: 0, end: 1, text: 'a' }]);
    expect(setSegmentProofreadResult(base, '', {})).toBe(base);
    expect(setSegmentTranscriptionResult(base, '', {})).toBe(base);
  });
});

describe('withSegmentCollection (split/merge surface)', () => {
  test('explicit histories win and are normalized + capped', () => {
    const parentHistory = Array.from({ length: SEGMENT_HISTORY_CAP }, (_, i) => createHistoryEntry(`p${i}`));
    const base = doc([{ _id: 'parent', start: 0, end: 2, text: 'whole' }]);
    const children: TranscriptSegment[] = [
      { _id: 'c1', start: 0, end: 1, text: 'first' },
      { _id: 'c2', start: 1, end: 2, text: 'second' }
    ];
    const next = withSegmentCollection(base, children, {
      historyEntriesBySegmentId: {
        c1: [...parentHistory, createHistoryEntry('first', 'split', { note: 'Split from segment 1' })],
        c2: [...parentHistory, createHistoryEntry('second', 'split', { note: 'Split from segment 1' })]
      }
    });
    const c1History = getSegmentHistory(next, 'c1');
    expect(c1History).toHaveLength(SEGMENT_HISTORY_CAP);
    expect(c1History[c1History.length - 1]).toMatchObject({ text: 'first', source: 'split' });
    expect(getSegmentHistory(next, 'c2')[SEGMENT_HISTORY_CAP - 1].source).toBe('split');
  });

  test('a segment without explicit history gets initial/sync entries', () => {
    const base = ensureTranscriptMetadata(doc([{ _id: 'a', start: 0, end: 1, text: 'one' }])).transcript;
    const next = withSegmentCollection(base, [
      { _id: 'a', start: 0, end: 1, text: 'one edited' },
      { _id: 'b', start: 1, end: 2, text: 'new' }
    ]);
    expect(getSegmentHistory(next, 'a').map(entry => entry.source)).toEqual(['initial', 'sync']);
    expect(getSegmentHistory(next, 'b').map(entry => entry.source)).toEqual(['initial']);
  });
});

describe('migrateLegacySpeakerFields', () => {
  test('migrates legacy speaker/speakerLabel/author to registry ids and strips the fields', () => {
    let counter = 0;
    const segments: TranscriptSegment[] = [
      { _id: 's1', start: 0, end: 1, text: 'a', speaker: 'Alice' },
      { _id: 's2', start: 1, end: 2, text: 'b', speakerLabel: '  Bob  Smith ' },
      { _id: 's3', start: 2, end: 3, text: 'c', author: 'alice' }, // case-insensitive reuse
      { _id: 's4', start: 3, end: 4, text: 'd' } // untouched
    ];
    const result = migrateLegacySpeakerFields(segments, [], () => `spk-${++counter}`);
    expect(result.segmentsChanged).toBe(true);
    expect(result.speakersChanged).toBe(true);
    expect(result.speakers).toEqual([
      { id: 'spk-1', name: 'Alice' },
      { id: 'spk-2', name: 'Bob Smith' }
    ]);
    expect(result.segments[0].speakerId).toBe('spk-1');
    expect(result.segments[0].speaker).toBeUndefined();
    expect(result.segments[1].speakerId).toBe('spk-2');
    expect(result.segments[1].speakerLabel).toBeUndefined();
    expect(result.segments[2].speakerId).toBe('spk-1'); // reused Alice by name
    expect(result.segments[3].speakerId).toBeUndefined();
  });

  test('a segment with an explicit speakerId is left untouched', () => {
    const segments: TranscriptSegment[] = [{ _id: 's1', start: 0, end: 1, text: 'a', speakerId: 'keep', speaker: 'Alice' }];
    const result = migrateLegacySpeakerFields(segments, [{ id: 'keep', name: 'Kept' }]);
    expect(result.segmentsChanged).toBe(false);
    expect(result.segments[0]).toBe(segments[0]);
    expect(result.segments[0].speaker).toBe('Alice'); // untouched, not migrated
  });

  test('reuses an existing registry entry by normalized name', () => {
    const segments: TranscriptSegment[] = [{ _id: 's1', start: 0, end: 1, text: 'a', speaker: ' ALICE ' }];
    const result = migrateLegacySpeakerFields(segments, [{ id: 'existing', name: 'Alice' }]);
    expect(result.speakersChanged).toBe(false);
    expect(result.segments[0].speakerId).toBe('existing');
  });
});

describe('normalizeProofreadIssues (the Phase-4 AI response shaping)', () => {
  test('coerces well-formed issues field-by-field and keeps ids', () => {
    const issues = normalizeProofreadIssues([
      { id: 'i1', type: 'grammar', severity: 'warning', message: 'Bad case', excerpt: 'дом', suggestion: 'дома' }
    ]);
    expect(issues).toEqual([
      { id: 'i1', type: 'grammar', severity: 'warning', message: 'Bad case', excerpt: 'дом', suggestion: 'дома' }
    ]);
  });

  test('fills defaults, generates missing ids, and drops entries without a message', () => {
    const issues = normalizeProofreadIssues([
      { message: 'Only message' },
      { type: 'noise' }, // no message → dropped
      'not-an-object',
      null
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('Only message');
    expect(issues[0].type).toBe('issue');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].excerpt).toBe('');
    expect(issues[0].suggestion).toBe('');
    expect(issues[0].id.length).toBeGreaterThan(0);
  });

  test('a non-array payload yields an empty list', () => {
    expect(normalizeProofreadIssues(undefined)).toEqual([]);
    expect(normalizeProofreadIssues({ issues: [] })).toEqual([]);
    expect(normalizeProofreadIssues('nope')).toEqual([]);
  });
});
