import { describe, expect, test } from 'bun:test';
import {
  ScannedDirectory,
  detectLegacyTranscriptSets,
  legacySetSlug,
  pairLegacyChunks
} from './legacy-transcript-import';

/**
 * Fixtures mirror the REAL legacy example
 * (`BhaktiVaibhava/шраванам-2-я-инициация/Урок 4`): Cyrillic names with spaces,
 * a chunk dir named after the media (spaces→underscores, extension dropped),
 * `time[HH:MM:SS][SEC]` mp3/json pairs, `raw.md`, plus `list.txt` /
 * `transcripts/` / `temp_*` leftovers that must be ignored.
 */

const MEDIA_NAME = 'Академия Шраванам 2026-02-25 19_00.mp4';
const CHUNK_DIR_NAME = 'Академия_Шраванам_2026-02-25_19_00';

function chunkDir(overrides: Partial<ScannedDirectory> = {}): ScannedDirectory {
  return {
    path: `/legacy/Урок 4/${CHUNK_DIR_NAME}`,
    name: CHUNK_DIR_NAME,
    files: [
      'raw.md',
      'time[00:09:22][562].json',
      'time[00:09:22][562].mp3',
      'time[00:18:19][1099].json',
      'time[00:18:19][1099].mp3'
    ],
    directories: [],
    ...overrides
  };
}

function lessonDir(overrides: Partial<ScannedDirectory> = {}): ScannedDirectory {
  return {
    path: '/legacy/Урок 4',
    name: 'Урок 4',
    files: [MEDIA_NAME, 'list.txt', 'process_videos_unified.sh'],
    directories: [
      chunkDir(),
      { path: '/legacy/Урок 4/transcripts', name: 'transcripts', files: ['Академия_Шраванам_2026-02-25_19_00.md'], directories: [] },
      { path: '/legacy/Урок 4/temp_1772039835858', name: 'temp_1772039835858', files: [], directories: [] }
    ],
    ...overrides
  };
}

describe('legacySetSlug', () => {
  test('keeps Cyrillic and hyphens, replaces spaces and separators', () => {
    expect(legacySetSlug('Академия Шраванам 2026-02-25 19_00')).toBe(CHUNK_DIR_NAME);
    expect(legacySetSlug('a/b\\c:d')).toBe('a_b_c_d');
    expect(legacySetSlug('')).toBe('imported-set');
    expect(legacySetSlug('..hidden')).toBe('_hidden');
  });
});

describe('pairLegacyChunks', () => {
  test('pairs media and json by base, sorted by offset', () => {
    const pairs = pairLegacyChunks([
      'time[00:18:19][1099].mp3',
      'time[00:18:19][1099].json',
      'time[00:09:22][562].mp3',
      'time[00:09:22][562].json',
      'raw.md',
      'list.txt'
    ]);
    expect(pairs.map(pair => pair.base)).toEqual(['time[00:09:22][562]', 'time[00:18:19][1099]']);
    expect(pairs[0]).toEqual({
      base: 'time[00:09:22][562]',
      mediaName: 'time[00:09:22][562].mp3',
      jsonName: 'time[00:09:22][562].json',
      offsetMs: 562_000
    });
  });

  test('surfaces missing json and orphan json as incomplete pairs', () => {
    const pairs = pairLegacyChunks([
      'time[00:09:22][562].mp3',
      'time[00:18:19][1099].json'
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].jsonName).toBeUndefined();
    expect(pairs[1].mediaName).toBeUndefined();
  });

  test('accepts full.<ext> single-recording names at offset 0', () => {
    const pairs = pairLegacyChunks(['full.mp3', 'full.json']);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].offsetMs).toBe(0);
  });
});

describe('detectLegacyTranscriptSets', () => {
  test('detects the real-example layout: media + sibling chunk dir (Cyrillic, spaces)', () => {
    const plans = detectLegacyTranscriptSets(lessonDir());
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan.sourceMediaName).toBe(MEDIA_NAME);
    expect(plan.sourceMediaPath).toBe(`/legacy/Урок 4/${MEDIA_NAME}`);
    expect(plan.chunkDir).toBe(`/legacy/Урок 4/${CHUNK_DIR_NAME}`);
    expect(plan.slug).toBe(CHUNK_DIR_NAME);
    expect(plan.targets.audioFolder).toBe(`sources/audio/${CHUNK_DIR_NAME}`);
    expect(plan.targets.transcriptFolder).toBe(`transcription/${CHUNK_DIR_NAME}/transcripts`);
    expect(plan.targets.sidecarPath).toBe(`transcription/${CHUNK_DIR_NAME}/transcriptset.yaml`);
    expect(plan.pairs).toHaveLength(2);
    expect(plan.completePairs).toBe(2);
    expect(plan.hasLegacyRawMd).toBe(true);
    expect(plan.legacyRawMdPath).toBe(`/legacy/Урок 4/${CHUNK_DIR_NAME}/raw.md`);
    // transcripts/ and temp_* leftovers produce no extra sets.
    expect(plan.warnings).toEqual([]);
  });

  test('detects a chunk dir without its source media (chunk-dir-only case)', () => {
    const dir = lessonDir({ files: ['list.txt'] });
    const plans = detectLegacyTranscriptSets(dir);
    expect(plans).toHaveLength(1);
    expect(plans[0].sourceMediaPath).toBeUndefined();
    expect(plans[0].slug).toBe(CHUNK_DIR_NAME);
    expect(plans[0].warnings.map(warning => warning.code)).toContain('no-source-media');
  });

  test('detects the scan root itself being a chunk dir', () => {
    const plans = detectLegacyTranscriptSets(chunkDir());
    expect(plans).toHaveLength(1);
    expect(plans[0].chunkDir).toBe(`/legacy/Урок 4/${CHUNK_DIR_NAME}`);
    expect(plans[0].sourceMediaPath).toBeUndefined();
  });

  test('warns per chunk on missing json / orphan json and on absent raw.md', () => {
    const dir = lessonDir({
      directories: [chunkDir({
        files: [
          'time[00:09:22][562].mp3',
          'time[00:09:22][562].json',
          'time[00:18:19][1099].mp3', // no json
          'time[00:28:15][1695].json' // orphan
        ]
      })]
    });
    const plans = detectLegacyTranscriptSets(dir);
    expect(plans).toHaveLength(1);
    const codes = plans[0].warnings.map(warning => warning.code);
    expect(codes).toContain('missing-json');
    expect(codes).toContain('orphan-json');
    expect(codes).toContain('no-raw-md');
    expect(plans[0].completePairs).toBe(1);
  });

  test('a directory with media but no complete pair is NOT a set', () => {
    const dir = lessonDir({
      directories: [chunkDir({ files: ['time[00:09:22][562].mp3', 'raw.md'] })]
    });
    expect(detectLegacyTranscriptSets(dir)).toHaveLength(0);
  });

  test('scanChildDirectories finds sets one level down and de-duplicates', () => {
    const parent: ScannedDirectory = {
      path: '/legacy',
      name: 'legacy',
      files: [],
      directories: [lessonDir()]
    };
    expect(detectLegacyTranscriptSets(parent)).toHaveLength(0);
    const plans = detectLegacyTranscriptSets(parent, { scanChildDirectories: true });
    expect(plans).toHaveLength(1);
    expect(plans[0].sourceMediaName).toBe(MEDIA_NAME);

    // The chunk dir is also visible as an unclaimed dir from the parent's own
    // level? No — it is nested two levels down; but a lesson-level scan must
    // not double-report when the same chunk dir would match twice.
    const double = detectLegacyTranscriptSets(lessonDir(), { scanChildDirectories: true });
    expect(double).toHaveLength(1);
  });

  test('two lessons side by side yield two independent plans', () => {
    const lesson5Chunk = chunkDir({
      path: '/legacy/Урок 5/Другая_Лекция',
      name: 'Другая_Лекция',
      files: ['time[00:10:00][600].mp3', 'time[00:10:00][600].json']
    });
    const parent: ScannedDirectory = {
      path: '/legacy',
      name: 'legacy',
      files: [],
      directories: [
        lessonDir(),
        {
          path: '/legacy/Урок 5',
          name: 'Урок 5',
          files: ['Другая Лекция.mp4'],
          directories: [lesson5Chunk]
        }
      ]
    };
    const plans = detectLegacyTranscriptSets(parent, { scanChildDirectories: true });
    expect(plans).toHaveLength(2);
    expect(plans.map(plan => plan.slug).sort()).toEqual([CHUNK_DIR_NAME, 'Другая_Лекция'].sort());
    expect(plans.find(plan => plan.slug === 'Другая_Лекция')?.sourceMediaName).toBe('Другая Лекция.mp4');
  });

  test('a video source with a same-named audio chunk dir pairs by folder name only', () => {
    // The chunk dir must equal mediaOutputFolderName(media): a differently
    // named dir is not claimed.
    const dir = lessonDir({
      directories: [chunkDir({ path: '/legacy/Урок 4/Другое_Имя', name: 'Другое_Имя' })]
    });
    const plans = detectLegacyTranscriptSets(dir);
    expect(plans).toHaveLength(1);
    // Unclaimed → chunk-dir-only set named after the dir.
    expect(plans[0].sourceMediaPath).toBeUndefined();
    expect(plans[0].slug).toBe('Другое_Имя');
  });
});
