import { describe, expect, test } from 'bun:test';
import { DEFAULT_MEDIA_EXTENSIONS } from './transcript-set-model';
import { parseTranscriptsetYaml, writeTranscriptsetYaml } from './transcript-sidecar';
import {
  AUDIO_SOURCES_AREA,
  RAW_MD_FILE_NAME,
  TRANSCRIPTION_AREA,
  buildTranscriptsetSkeleton,
  isRawMdPath,
  rawMdRelPath,
  seedFilesFromMediaNames,
  speakersRelPath,
  transcriptSetFolder,
  transcriptSetFolders,
  transcriptsetRelPath
} from './transcript-set-scaffold';

describe('folder conventions', () => {
  test('derives the owner-decided layout from a slug', () => {
    expect(TRANSCRIPTION_AREA).toBe('transcription');
    expect(AUDIO_SOURCES_AREA).toBe('sources/audio');
    expect(transcriptSetFolders('june-talk')).toEqual({
      audioFolder: 'sources/audio/june-talk',
      transcriptFolder: 'transcription/june-talk/transcripts'
    });
    expect(transcriptSetFolder('june-talk')).toBe('transcription/june-talk');
    expect(transcriptsetRelPath('june-talk')).toBe('transcription/june-talk/transcriptset.yaml');
    expect(speakersRelPath('june-talk')).toBe('transcription/june-talk/speakers.yaml');
    expect(rawMdRelPath('june-talk')).toBe(`transcription/june-talk/${RAW_MD_FILE_NAME}`);
  });
});

describe('seedFilesFromMediaNames', () => {
  test('one entry per media base, non-media ignored, duplicates first-wins', () => {
    const files = seedFilesFromMediaNames(['a.mp3', 'a.mp4', 'notes.txt', 'b.webm']);
    expect(files).toEqual([
      { base: 'a', verified: false, needsRework: false },
      { base: 'b', verified: false, needsRework: false }
    ]);
  });

  test('sorted by chunk offset first, offset-less last by numeric-aware base', () => {
    const files = seedFilesFromMediaNames([
      'part.10.mp3',
      'time[00:20:00].mp3',
      'part.2.mp3',
      'time[00:10:00].mp3'
    ]);
    expect(files.map(file => file.base)).toEqual(['time[00:10:00]', 'time[00:20:00]', 'part.2', 'part.10']);
  });

  test('honors a custom extension list', () => {
    const files = seedFilesFromMediaNames(['a.opus', 'b.mp3'], ['.opus']);
    expect(files.map(file => file.base)).toEqual(['a']);
  });

  test('empty input → empty seed', () => {
    expect(seedFilesFromMediaNames([])).toEqual([]);
  });
});

describe('buildTranscriptsetSkeleton', () => {
  test('builds a set from slug + media names with defaults', () => {
    const set = buildTranscriptsetSkeleton({ slug: 'talk', mediaNames: ['full.mp3'] });
    expect(set).toEqual({
      audioFolder: 'sources/audio/talk',
      transcriptFolder: 'transcription/talk/transcripts',
      mediaExtensions: [...DEFAULT_MEDIA_EXTENSIONS],
      files: [{ base: 'full', verified: false, needsRework: false }]
    });
  });

  test('honors language and extension overrides (seeding through the override)', () => {
    const set = buildTranscriptsetSkeleton({
      slug: 'talk',
      language: ' ru ',
      mediaExtensions: ['.opus'],
      mediaNames: ['a.opus', 'b.mp3']
    });
    expect(set.language).toBe('ru');
    expect(set.mediaExtensions).toEqual(['.opus']);
    expect(set.files.map(file => file.base)).toEqual(['a']);
  });

  test('blank language is omitted', () => {
    const set = buildTranscriptsetSkeleton({ slug: 'talk', language: '  ' });
    expect(set.language).toBeUndefined();
  });

  test('the skeleton serializes straight through the sidecar round-trip', () => {
    const set = buildTranscriptsetSkeleton({ slug: 'talk', mediaNames: ['time[00:10:00].mp3'] });
    const { set: reparsed, problems } = parseTranscriptsetYaml(writeTranscriptsetYaml(undefined, set));
    expect(problems).toEqual([]);
    expect(reparsed).toEqual(set);
  });
});

describe('isRawMdPath (mirror of isTranscriptsetPath — TASK-016 U4b RawMdOpenHandler predicate)', () => {
  test('positive: raw.md under a transcription/ folder, any depth/casing, POSIX or file:// URI path', () => {
    expect(isRawMdPath('transcription/june-talk/raw.md')).toBe(true);
    expect(isRawMdPath('/book/transcription/june-talk/raw.md')).toBe(true);
    expect(isRawMdPath('file:///book/transcription/nested/deep/raw.md')).toBe(true);
    expect(isRawMdPath('TRANSCRIPTION/June-Talk/RAW.MD')).toBe(true);
    expect(isRawMdPath('C:\\book\\transcription\\june-talk\\raw.md')).toBe(true);
  });

  test('negative: raw.md outside transcription/, or a different basename inside transcription/', () => {
    expect(isRawMdPath('notes/raw.md')).toBe(false);
    expect(isRawMdPath('/book/notes/raw.md')).toBe(false);
    expect(isRawMdPath('transcription/june-talk/transcriptset.yaml')).toBe(false);
    expect(isRawMdPath('transcription/june-talk/raw.md.bak')).toBe(false);
    expect(isRawMdPath('raw.md')).toBe(false);
  });
});
