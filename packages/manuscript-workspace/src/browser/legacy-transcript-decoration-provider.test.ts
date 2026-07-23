import { describe, expect, test } from 'bun:test';
import { ScannedDirectory } from '../common/legacy-transcript-import';
import {
  DebouncedTrigger,
  LEGACY_TRANSCRIPT_DECORATION,
  LEGACY_TRANSCRIPT_DECORATION_LETTER,
  LEGACY_TRANSCRIPT_DECORATION_TOOLTIP,
  collectLegacyDecorationEntries
} from '../common/legacy-transcript-decoration';

/**
 * Fixtures mirror `legacy-transcript-import.test.ts` (the real
 * `BhaktiVaibhava/шраванам-2-я-инициация/Урок 4` example): Cyrillic names with
 * spaces, a chunk dir named after the media, `time[HH:MM:SS][ms]` pairs.
 */
const MEDIA_NAME = 'Академия Шраванам 2026-02-25 19_00.mp4';
const CHUNK_DIR_NAME = 'Академия_Шраванам_2026-02-25_19_00';

function chunkDir(path: string, overrides: Partial<ScannedDirectory> = {}): ScannedDirectory {
  return {
    path,
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

function plainDir(path: string, name: string, files: string[] = [], directories: ScannedDirectory[] = []): ScannedDirectory {
  return { path, name, files, directories };
}

describe('collectLegacyDecorationEntries — positive', () => {
  test('finds a legacy set at the workspace root (media + sibling chunk dir)', () => {
    const root: ScannedDirectory = {
      path: '/ws',
      name: 'ws',
      files: [MEDIA_NAME, 'list.txt'],
      directories: [chunkDir(`/ws/${CHUNK_DIR_NAME}`)]
    };
    const entries = collectLegacyDecorationEntries(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe(`/ws/${CHUNK_DIR_NAME}`);
    expect(entries[0].decoration).toBe(LEGACY_TRANSCRIPT_DECORATION);
    expect(entries[0].decoration.letter).toBe(LEGACY_TRANSCRIPT_DECORATION_LETTER);
    expect(entries[0].decoration.tooltip).toBe(LEGACY_TRANSCRIPT_DECORATION_TOOLTIP);
    expect(entries[0].decoration.bubble).toBe(true);
  });

  test('finds a chunk dir nested several levels below the workspace root', () => {
    const root: ScannedDirectory = plainDir('/ws', 'ws', [], [
      plainDir('/ws/Archive', 'Archive', [], [
        plainDir('/ws/Archive/Lessons', 'Lessons', [MEDIA_NAME], [
          chunkDir(`/ws/Archive/Lessons/${CHUNK_DIR_NAME}`)
        ])
      ])
    ]);
    const entries = collectLegacyDecorationEntries(root);
    expect(entries.map(entry => entry.path)).toEqual([`/ws/Archive/Lessons/${CHUNK_DIR_NAME}`]);
  });

  test('detects an unclaimed chunk dir (no sibling media) as its own entry', () => {
    const root: ScannedDirectory = plainDir('/ws', 'ws', ['readme.md'], [
      chunkDir('/ws/orphan-chunks', { name: 'orphan-chunks' })
    ]);
    const entries = collectLegacyDecorationEntries(root);
    expect(entries.map(entry => entry.path)).toEqual(['/ws/orphan-chunks']);
  });

  test('de-duplicates a chunk dir detected both at parent level (rule 2) and at its own node (rule 3)', () => {
    // Same shape as the previous case — the walk visits the chunk dir node
    // itself too and must not append a second entry for the same chunkDir path.
    const root: ScannedDirectory = plainDir('/ws', 'ws', [], [
      chunkDir('/ws/orphan-chunks', { name: 'orphan-chunks' })
    ]);
    const entries = collectLegacyDecorationEntries(root);
    expect(entries).toHaveLength(1);
  });
});

describe('collectLegacyDecorationEntries — negative', () => {
  test('an ordinary folder tree with no time[…] pairs yields nothing', () => {
    const root: ScannedDirectory = plainDir('/ws', 'ws', ['README.md'], [
      plainDir('/ws/chapters', 'chapters', ['chapter-1.md', 'chapter-2.md'])
    ]);
    expect(collectLegacyDecorationEntries(root)).toEqual([]);
  });

  test('skips the already-migrated transcription/ area entirely, even if it contains time[…]-named files', () => {
    const root: ScannedDirectory = plainDir('/ws', 'ws', [], [
      plainDir('/ws/transcription', 'transcription', [], [
        chunkDir('/ws/transcription/some-set/transcripts', { name: 'transcripts' })
      ])
    ]);
    expect(collectLegacyDecorationEntries(root)).toEqual([]);
  });

  test('skips the already-migrated sources/audio/ area entirely, but still scans other sources/* subfolders', () => {
    const root: ScannedDirectory = plainDir('/ws', 'ws', [], [
      plainDir('/ws/sources', 'sources', [], [
        plainDir('/ws/sources/audio', 'audio', [], [
          chunkDir('/ws/sources/audio/some-set', { name: 'some-set' })
        ]),
        plainDir('/ws/sources/scans', 'scans', [], [
          chunkDir('/ws/sources/scans/legacy-drop', { name: 'legacy-drop' })
        ])
      ])
    ]);
    const entries = collectLegacyDecorationEntries(root);
    expect(entries.map(entry => entry.path)).toEqual(['/ws/sources/scans/legacy-drop']);
  });

  test('startSegments lets an incremental/fallback rescan honor the skip even when the rescanned node is not the workspace root', () => {
    // The provider rescans "/ws/transcription" directly (its own subtree) —
    // startSegments carries the accumulated ["transcription"] context.
    const node = plainDir('/ws/transcription', 'transcription', [], [
      chunkDir('/ws/transcription/some-set/transcripts', { name: 'transcripts' })
    ]);
    expect(collectLegacyDecorationEntries(node, { startSegments: ['transcription'] })).toEqual([]);
  });
});

describe('collectLegacyDecorationEntries — multi-root & multi-set aggregation (ISS-164 REVISE, F-PLAN-2-1 pure-level coverage)', () => {
  test('multiple legacy sets in one listing are all detected, not just the first', () => {
    const root: ScannedDirectory = plainDir('/ws', 'ws', [], [
      plainDir('/ws/lesson-1', 'lesson-1', [MEDIA_NAME], [
        chunkDir(`/ws/lesson-1/${CHUNK_DIR_NAME}`)
      ]),
      plainDir('/ws/lesson-2', 'lesson-2', [], [
        chunkDir('/ws/lesson-2/orphan-chunks', { name: 'orphan-chunks' })
      ])
    ]);
    const entries = collectLegacyDecorationEntries(root);
    expect(entries.map(entry => entry.path).sort()).toEqual(
      [`/ws/lesson-1/${CHUNK_DIR_NAME}`, '/ws/lesson-2/orphan-chunks'].sort()
    );
  });

  test('two independent workspace roots (as runInitialScan processes each) never collide, even with an identically-named chunk dir', () => {
    // Mirrors the real multi-root call pattern (F-PLAN-2-1): the provider
    // calls collectLegacyDecorationEntries ONCE PER ROOT with a fresh `seen`
    // Set each time (it is created inside the function, not threaded across
    // calls) — a same-named chunk dir under two different roots must show up
    // for BOTH roots, not be de-duped away by a leaked seen-set.
    const rootA: ScannedDirectory = plainDir('/ws-a', 'ws-a', [], [
      chunkDir('/ws-a/orphan-chunks', { name: 'orphan-chunks' })
    ]);
    const rootB: ScannedDirectory = plainDir('/ws-b', 'ws-b', [], [
      chunkDir('/ws-b/orphan-chunks', { name: 'orphan-chunks' })
    ]);
    const entriesA = collectLegacyDecorationEntries(rootA);
    const entriesB = collectLegacyDecorationEntries(rootB);
    expect(entriesA.map(entry => entry.path)).toEqual(['/ws-a/orphan-chunks']);
    expect(entriesB.map(entry => entry.path)).toEqual(['/ws-b/orphan-chunks']);
    // Aggregated the way runInitialScan does (push per root into one changed/merged list) — union, no cross-root loss.
    const aggregatedPaths = [...entriesA, ...entriesB].map(entry => entry.path);
    expect(aggregatedPaths).toHaveLength(2);
  });
});

describe('DebouncedTrigger', () => {
  test('collapses rapid schedule() calls into one flush with the union of items', async () => {
    const flushed: string[][] = [];
    const trigger = new DebouncedTrigger<string>(20, items => flushed.push(items));
    trigger.schedule('a');
    trigger.schedule('b');
    trigger.schedule('a'); // duplicate — the flush set still de-dupes.
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].sort()).toEqual(['a', 'b']);
  });

  test('a schedule() after the previous flush starts a fresh debounce window', async () => {
    const flushed: string[][] = [];
    const trigger = new DebouncedTrigger<string>(15, items => flushed.push(items));
    trigger.schedule('first');
    await new Promise(resolve => setTimeout(resolve, 40));
    trigger.schedule('second');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(flushed).toEqual([['first'], ['second']]);
  });

  test('dispose() cancels a pending flush', async () => {
    const flushed: string[][] = [];
    const trigger = new DebouncedTrigger<string>(15, items => flushed.push(items));
    trigger.schedule('x');
    trigger.dispose();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(flushed).toHaveLength(0);
  });
});
