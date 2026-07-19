import { describe, expect, test } from 'bun:test';
import {
  SPEAKERS_REGISTRY_VERSION,
  ensureSpeakerByName,
  getLegacySegmentSpeakerLabel,
  getSegmentSpeakerId,
  normalizeSpeakerLabel,
  normalizeSpeakerRegistry,
  parseSpeakersYaml,
  resolveEffectiveSpeaker,
  resolveSegmentSpeakerLabel,
  speakerNameById,
  writeSpeakersYaml
} from './transcript-speakers';

describe('normalizeSpeakerLabel', () => {
  test('trims and collapses inner whitespace', () => {
    expect(normalizeSpeakerLabel('  Alice   Smith ')).toBe('Alice Smith');
    expect(normalizeSpeakerLabel(undefined)).toBe('');
    expect(normalizeSpeakerLabel(42)).toBe('42');
  });
});

describe('normalizeSpeakerRegistry', () => {
  test('drops invalid entries and de-dupes on id and case-insensitive name', () => {
    const speakers = normalizeSpeakerRegistry([
      { id: 'a', name: 'Alice' },
      { id: 'a', name: 'Duplicate Id' },
      { id: 'b', name: 'ALICE' }, // duplicate name (case-insensitive)
      { id: '', name: 'No Id' },
      { id: 'c', name: '' },
      'garbage',
      { id: 'd', name: 'Bob' }
    ]);
    expect(speakers).toEqual([
      { id: 'a', name: 'Alice' },
      { id: 'd', name: 'Bob' }
    ]);
  });

  test('non-array input → empty registry', () => {
    expect(normalizeSpeakerRegistry({ speakers: [] })).toEqual([]);
  });
});

describe('ensureSpeakerByName', () => {
  test('reuses an existing speaker case-insensitively', () => {
    const result = ensureSpeakerByName([{ id: 'a', name: 'Alice' }], '  ALICE ');
    expect(result.changed).toBe(false);
    expect(result.speaker).toEqual({ id: 'a', name: 'Alice' });
  });

  test('creates a new speaker with an injected id', () => {
    const result = ensureSpeakerByName([], 'Bob', () => 'bob-id');
    expect(result.changed).toBe(true);
    expect(result.speaker).toEqual({ id: 'bob-id', name: 'Bob' });
    expect(result.speakers).toEqual([{ id: 'bob-id', name: 'Bob' }]);
  });

  test('blank name → no speaker, unchanged', () => {
    const result = ensureSpeakerByName([{ id: 'a', name: 'Alice' }], '   ');
    expect(result.speaker).toBeUndefined();
    expect(result.changed).toBe(false);
  });
});

describe('segment speaker accessors', () => {
  test('getSegmentSpeakerId prefers speakerId over legacy speaker_id', () => {
    expect(getSegmentSpeakerId({ speakerId: ' a ' })).toBe('a');
    expect(getSegmentSpeakerId({ speaker_id: 'b' })).toBe('b');
    expect(getSegmentSpeakerId({})).toBe('');
    expect(getSegmentSpeakerId(undefined)).toBe('');
  });

  test('getLegacySegmentSpeakerLabel falls through speaker → speakerLabel → author', () => {
    expect(getLegacySegmentSpeakerLabel({ speaker: 'A' })).toBe('A');
    expect(getLegacySegmentSpeakerLabel({ speakerLabel: 'B' })).toBe('B');
    expect(getLegacySegmentSpeakerLabel({ author: '  C  D ' })).toBe('C D');
    expect(getLegacySegmentSpeakerLabel({})).toBe('');
  });

  test('resolveSegmentSpeakerLabel: registry name wins, legacy fallback otherwise', () => {
    const byId = speakerNameById([{ id: 'a', name: 'Alice' }]);
    expect(resolveSegmentSpeakerLabel({ speakerId: 'a' }, byId)).toBe('Alice');
    expect(resolveSegmentSpeakerLabel({ speakerId: 'unknown', speaker: 'Legacy' }, byId)).toBe('Legacy');
    expect(resolveSegmentSpeakerLabel({ speaker: 'Solo' }, byId)).toBe('Solo');
    expect(resolveSegmentSpeakerLabel({}, byId)).toBe('');
  });
});

describe('resolveEffectiveSpeaker (inherited carry-forward)', () => {
  test('explicit ids win; gaps inherit the previous effective id', () => {
    const { timeline, lastSpeakerId } = resolveEffectiveSpeaker([
      { speakerId: 'a' },
      {},
      { speakerId: 'b' },
      {},
      {}
    ]);
    expect(timeline.map(entry => entry.effectiveSpeakerId)).toEqual(['a', 'a', 'b', 'b', 'b']);
    expect(timeline.map(entry => entry.explicitSpeakerId)).toEqual(['a', '', 'b', '', '']);
    expect(lastSpeakerId).toBe('b');
  });

  test('initialSpeakerId seeds the carry across files', () => {
    const { timeline } = resolveEffectiveSpeaker([{}, { speakerId: 'x' }], 'prev');
    expect(timeline.map(entry => entry.effectiveSpeakerId)).toEqual(['prev', 'x']);
  });

  test('no speakers anywhere → empty effective ids', () => {
    const { timeline, lastSpeakerId } = resolveEffectiveSpeaker([{}, {}]);
    expect(timeline.map(entry => entry.effectiveSpeakerId)).toEqual(['', '']);
    expect(lastSpeakerId).toBe('');
  });
});

describe('parseSpeakersYaml', () => {
  test('parses the canonical mapping shape', () => {
    const { registry, problems } = parseSpeakersYaml(
      ['version: 1', 'updatedAt: 2026-07-19T00:00:00.000Z', 'speakers:', '  - id: a', '    name: Alice'].join('\n')
    );
    expect(problems).toEqual([]);
    expect(registry).toEqual({
      version: 1,
      updatedAt: '2026-07-19T00:00:00.000Z',
      speakers: [{ id: 'a', name: 'Alice' }]
    });
  });

  test('tolerates the legacy bare-list shape (.transcriber-speakers.json)', () => {
    const { registry, problems } = parseSpeakersYaml(['- id: a', '  name: Alice'].join('\n'));
    expect(problems).toEqual([]);
    expect(registry!.version).toBe(SPEAKERS_REGISTRY_VERSION);
    expect(registry!.speakers).toEqual([{ id: 'a', name: 'Alice' }]);
  });

  test('drops and reports malformed speaker entries', () => {
    const { registry, problems } = parseSpeakersYaml(
      ['speakers:', '  - id: a', '    name: Alice', '  - id: ""', '    name: NoId', '  - nonsense'].join('\n')
    );
    expect(registry!.speakers).toEqual([{ id: 'a', name: 'Alice' }]);
    expect(problems.map(problem => problem.code)).toEqual(['invalid-speaker', 'invalid-speaker']);
    expect(problems.map(problem => problem.index)).toEqual([1, 2]);
  });

  test('empty / scalar-root file → blocking invalid-shape', () => {
    expect(parseSpeakersYaml('').problems.map(problem => problem.code)).toEqual(['invalid-shape']);
    expect(parseSpeakersYaml('just a string').problems.map(problem => problem.code)).toEqual(['invalid-shape']);
  });
});

describe('writeSpeakersYaml', () => {
  test('round-trips and PRESERVES comments and unknown keys', () => {
    const existing = [
      '# Speakers of the June interview',
      'version: 1',
      'updatedAt: old',
      'customNote: keep me',
      'speakers:',
      '  - id: a',
      '    name: Alice'
    ].join('\n');
    const written = writeSpeakersYaml(existing, {
      version: 1,
      updatedAt: '2026-07-19T00:00:00.000Z',
      speakers: [
        { id: 'a', name: 'Alice' },
        { id: 'b', name: 'Bob' }
      ]
    });
    expect(written).toContain('# Speakers of the June interview');
    expect(written).toContain('customNote: keep me');
    const { registry } = parseSpeakersYaml(written);
    expect(registry!.updatedAt).toBe('2026-07-19T00:00:00.000Z');
    expect(registry!.speakers).toEqual([
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob' }
    ]);
  });

  test('writes a fresh document when no existing text is given', () => {
    const written = writeSpeakersYaml(undefined, { version: 1, updatedAt: 't', speakers: [] });
    const { registry, problems } = parseSpeakersYaml(written);
    expect(problems).toEqual([]);
    expect(registry!.speakers).toEqual([]);
  });
});
