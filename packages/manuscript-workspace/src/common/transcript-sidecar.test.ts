import { describe, expect, test } from 'bun:test';
import { DEFAULT_MEDIA_EXTENSIONS, TranscriptSet } from './transcript-set-model';
import {
  TranscriptsetSchemaValidator,
  parseTranscriptsetYaml,
  setTranscriptFileNeedsRework,
  setTranscriptFileVerified,
  writeTranscriptsetYaml
} from './transcript-sidecar';

const VALID_MINIMAL = ['audioFolder: sources/audio/talk', 'transcriptFolder: transcription/talk/transcripts', ''].join('\n');

describe('parseTranscriptsetYaml — valid', () => {
  test('parses a minimal set and fills default media extensions + empty files', () => {
    const { set, problems } = parseTranscriptsetYaml(VALID_MINIMAL);
    expect(problems).toEqual([]);
    expect(set).toBeDefined();
    expect(set!.audioFolder).toBe('sources/audio/talk');
    expect(set!.transcriptFolder).toBe('transcription/talk/transcripts');
    expect(set!.mediaExtensions).toEqual([...DEFAULT_MEDIA_EXTENSIONS]);
    expect(set!.language).toBeUndefined();
    expect(set!.files).toEqual([]);
  });

  test('parses language, explicit extensions and files', () => {
    const text = [
      VALID_MINIMAL,
      'language: ru',
      'mediaExtensions:',
      '  - .mp3',
      '  - .mp4',
      'files:',
      '  - base: time[00:10:00]',
      '    verified: true',
      '    needsRework: false'
    ].join('\n');
    const { set, problems } = parseTranscriptsetYaml(text);
    expect(problems).toEqual([]);
    expect(set!.language).toBe('ru');
    expect(set!.mediaExtensions).toEqual(['.mp3', '.mp4']);
    expect(set!.files).toEqual([{ base: 'time[00:10:00]', verified: true, needsRework: false }]);
  });
});

describe('parseTranscriptsetYaml — each problem code', () => {
  test('invalid-shape: empty / unparseable / non-mapping', () => {
    expect(parseTranscriptsetYaml('').problems.map(p => p.code)).toEqual(['invalid-shape']);
    expect(parseTranscriptsetYaml('audioFolder: [unterminated').problems.map(p => p.code)).toEqual(['invalid-shape']);
    expect(parseTranscriptsetYaml('- a list\n').problems.map(p => p.code)).toEqual(['invalid-shape']);
  });

  test('missing-audio-folder blocks', () => {
    const { set, problems } = parseTranscriptsetYaml('transcriptFolder: t\n');
    expect(set).toBeUndefined();
    expect(problems.map(p => p.code)).toEqual(['missing-audio-folder']);
  });

  test('missing-transcript-folder blocks', () => {
    const { set, problems } = parseTranscriptsetYaml('audioFolder: a\n');
    expect(set).toBeUndefined();
    expect(problems.map(p => p.code)).toEqual(['missing-transcript-folder']);
  });

  test('invalid-extensions is non-blocking and falls back to defaults', () => {
    const { set, problems } = parseTranscriptsetYaml([VALID_MINIMAL, 'mediaExtensions: nope'].join('\n'));
    expect(problems.map(p => p.code)).toEqual(['invalid-extensions']);
    expect(set!.mediaExtensions).toEqual([...DEFAULT_MEDIA_EXTENSIONS]);
  });

  test('empty extensions list also falls back to defaults (matches nothing otherwise)', () => {
    const { set, problems } = parseTranscriptsetYaml([VALID_MINIMAL, 'mediaExtensions: []'].join('\n'));
    expect(problems).toEqual([]);
    expect(set!.mediaExtensions).toEqual([...DEFAULT_MEDIA_EXTENSIONS]);
  });

  test('invalid-language is non-blocking and drops the value', () => {
    const { set, problems } = parseTranscriptsetYaml([VALID_MINIMAL, 'language: [ru]'].join('\n'));
    expect(problems.map(p => p.code)).toEqual(['invalid-language']);
    expect(set!.language).toBeUndefined();
  });

  test('invalid-file entries are dropped (and indexed) while valid ones survive', () => {
    const text = [
      VALID_MINIMAL,
      'files:',
      '  - base: good',
      '  - notAnObject',
      '  - base: ""',
      '  - base: badFlag',
      '    verified: sometimes'
    ].join('\n');
    const { set, problems } = parseTranscriptsetYaml(text);
    expect(set!.files).toEqual([{ base: 'good', verified: false, needsRework: false }]);
    expect(problems.map(p => p.code)).toEqual(['invalid-file', 'invalid-file', 'invalid-file']);
    expect(problems.map(p => p.index)).toEqual([1, 2, 3]);
  });
});

describe('writeTranscriptsetYaml — round-trip', () => {
  const set: TranscriptSet = {
    audioFolder: 'sources/audio/talk',
    transcriptFolder: 'transcription/talk/transcripts',
    mediaExtensions: ['.mp3', '.mp4'],
    language: 'ru',
    files: [{ base: 'time[00:10:00]', verified: true, needsRework: false }]
  };

  test('parse(write(set)) round-trips losslessly', () => {
    const written = writeTranscriptsetYaml(undefined, set);
    const { set: reparsed, problems } = parseTranscriptsetYaml(written);
    expect(problems).toEqual([]);
    expect(reparsed).toEqual(set);
  });

  test('PRESERVES comments and unknown keys of the existing text', () => {
    const existing = [
      '# My lecture recordings',
      'audioFolder: old/audio',
      'transcriptFolder: old/transcripts',
      'customKey: keep me # inline comment',
      'files: []'
    ].join('\n');
    const written = writeTranscriptsetYaml(existing, set);
    expect(written).toContain('# My lecture recordings');
    expect(written).toContain('customKey: keep me');
    expect(written).toContain('# inline comment');
    const { set: reparsed } = parseTranscriptsetYaml(written);
    expect(reparsed!.audioFolder).toBe('sources/audio/talk');
    expect(reparsed!.files).toEqual(set.files);
  });

  test('removes language when the set has none', () => {
    const written = writeTranscriptsetYaml('audioFolder: a\ntranscriptFolder: b\nlanguage: ru\n', {
      ...set,
      language: undefined
    });
    expect(written).not.toContain('language:');
  });
});

describe('verified/rework upserts', () => {
  const base: TranscriptSet = {
    audioFolder: 'a',
    transcriptFolder: 't',
    mediaExtensions: ['.mp3'],
    files: [{ base: 'one', verified: false, needsRework: false }]
  };

  test('setTranscriptFileVerified toggles an existing file immutably', () => {
    const next = setTranscriptFileVerified(base, 'one', true);
    expect(next).not.toBe(base);
    expect(next.files[0]).toEqual({ base: 'one', verified: true, needsRework: false });
    expect(base.files[0].verified).toBe(false);
  });

  test('upsert adds an unknown base', () => {
    const next = setTranscriptFileNeedsRework(base, 'two', true);
    expect(next.files).toHaveLength(2);
    expect(next.files[1]).toEqual({ base: 'two', verified: false, needsRework: true });
  });
});

describe('TranscriptsetSchemaValidator', () => {
  const validator = new TranscriptsetSchemaValidator();

  test('accepts a valid object', () => {
    expect(
      validator.validate('file:///transcriptset.yaml', {
        audioFolder: 'a',
        transcriptFolder: 't',
        mediaExtensions: ['.mp3'],
        language: 'ru',
        files: [{ base: 'one', verified: true }]
      })
    ).toEqual([]);
  });

  test('rejects a missing required folder with a pathed message', () => {
    const diagnostics = validator.validate('file:///transcriptset.yaml', { transcriptFolder: 't' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('error');
    expect(diagnostics[0].source).toBe('transcriptset-schema');
    expect(diagnostics[0].message).toContain('audioFolder');
  });

  test('rejects wrong-typed fields (schema reject)', () => {
    const diagnostics = validator.validate('u', {
      audioFolder: 'a',
      transcriptFolder: 't',
      mediaExtensions: 'not-a-list',
      files: [{ verified: true }]
    });
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(diagnostics.every(d => d.severity === 'error')).toBe(true);
  });
});

describe('sourceMedia (legacy-import / new-transcription source reference)', () => {
  test('parses an absolute sourceMedia path (Cyrillic + spaces)', () => {
    const text = [
      VALID_MINIMAL,
      'sourceMedia: "/books/Урок 4/Академия Шраванам 2026-02-25 19_00.mp4"'
    ].join('\n');
    const { set, problems } = parseTranscriptsetYaml(text);
    expect(problems).toEqual([]);
    expect(set!.sourceMedia).toBe('/books/Урок 4/Академия Шраванам 2026-02-25 19_00.mp4');
  });

  test('absent / blank sourceMedia stays undefined (backward compatible)', () => {
    expect(parseTranscriptsetYaml(VALID_MINIMAL).set!.sourceMedia).toBeUndefined();
    expect(parseTranscriptsetYaml(`${VALID_MINIMAL}\nsourceMedia: "  "\n`).set!.sourceMedia).toBeUndefined();
  });

  test('invalid-source-media is non-blocking and drops the field', () => {
    const { set, problems } = parseTranscriptsetYaml(`${VALID_MINIMAL}\nsourceMedia: 42\n`);
    expect(problems.map(p => p.code)).toEqual(['invalid-source-media']);
    expect(set).toBeDefined();
    expect(set!.sourceMedia).toBeUndefined();
  });

  test('write → parse round-trips sourceMedia and preserves comments', () => {
    const set: TranscriptSet = {
      audioFolder: 'sources/audio/lesson-4',
      transcriptFolder: 'transcription/lesson-4/transcripts',
      mediaExtensions: ['.mp3'],
      sourceMedia: '/abs/Академия Шраванам 2026-02-25 19_00.mp4',
      files: [{ base: 'time[00:09:22][562]', verified: false, needsRework: false }]
    };
    const written = writeTranscriptsetYaml('# keep me\naudioFolder: old\ntranscriptFolder: old\n', set);
    expect(written).toContain('# keep me');
    const parsed = parseTranscriptsetYaml(written);
    expect(parsed.problems).toEqual([]);
    expect(parsed.set!.sourceMedia).toBe('/abs/Академия Шраванам 2026-02-25 19_00.mp4');
    expect(parsed.set!.files).toEqual(set.files);
  });

  test('writing a set without sourceMedia removes a stale key', () => {
    const withSource = `${VALID_MINIMAL}\nsourceMedia: /old/path.mp4\n`;
    const set = parseTranscriptsetYaml(VALID_MINIMAL).set!;
    const written = writeTranscriptsetYaml(withSource, set);
    expect(written).not.toContain('sourceMedia');
  });

  test('schema accepts sourceMedia and rejects a non-string', () => {
    const validator = new TranscriptsetSchemaValidator();
    expect(validator.validate('mem:/t.yaml', {
      audioFolder: 'a', transcriptFolder: 't', sourceMedia: '/abs/x.mp4'
    })).toEqual([]);
    const errors = validator.validate('mem:/t.yaml', {
      audioFolder: 'a', transcriptFolder: 't', sourceMedia: 42
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
