import { describe, expect, test } from 'bun:test';
import { appendGitignoreEntry, hasGitignoreEntry } from './gitignore-utils';

describe('hasGitignoreEntry', () => {
  test('absent file has no entries', () => {
    expect(hasGitignoreEntry(undefined, 'sources/audio/')).toBe(false);
  });

  test('empty text has no entries', () => {
    expect(hasGitignoreEntry('', 'sources/audio/')).toBe(false);
  });

  test('exact entry is found', () => {
    expect(hasGitignoreEntry('node_modules/\nsources/audio/\n', 'sources/audio/')).toBe(true);
  });

  test('slash variants are treated as the same entry', () => {
    expect(hasGitignoreEntry('sources/audio\n', 'sources/audio/')).toBe(true);
    expect(hasGitignoreEntry('/sources/audio/\n', 'sources/audio/')).toBe(true);
    expect(hasGitignoreEntry('  sources/audio/  \n', 'sources/audio')).toBe(true);
  });

  test('comments and other lines do not match', () => {
    expect(hasGitignoreEntry('# sources/audio/\nbuild/\n', 'sources/audio/')).toBe(false);
  });

  test('a broader glob is not recognized as the same entry', () => {
    expect(hasGitignoreEntry('sources/audio/**\n', 'sources/audio/')).toBe(false);
  });
});

describe('appendGitignoreEntry', () => {
  test('creates a fresh file when the .gitignore is absent', () => {
    const result = appendGitignoreEntry(undefined, 'sources/audio/', 'Transcription media (audio/video) — heavy files, keep out of git');
    expect(result.added).toBe(true);
    expect(result.text).toBe('# Transcription media (audio/video) — heavy files, keep out of git\nsources/audio/\n');
  });

  test('creates a fresh file without a comment', () => {
    const result = appendGitignoreEntry(undefined, 'sources/audio/');
    expect(result.added).toBe(true);
    expect(result.text).toBe('sources/audio/\n');
  });

  test('appends after existing content, separated by a blank line', () => {
    const result = appendGitignoreEntry('node_modules/\n', 'sources/audio/');
    expect(result.added).toBe(true);
    expect(result.text).toBe('node_modules/\n\nsources/audio/\n');
  });

  test('adds a trailing newline to unterminated existing content', () => {
    const result = appendGitignoreEntry('node_modules/', 'sources/audio/');
    expect(result.text).toBe('node_modules/\n\nsources/audio/\n');
  });

  test('is idempotent: an existing entry is never duplicated', () => {
    const once = appendGitignoreEntry('build/\n', 'sources/audio/');
    const twice = appendGitignoreEntry(once.text, 'sources/audio/');
    expect(twice.added).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  test('slash variants of an existing entry short-circuit the append', () => {
    const result = appendGitignoreEntry('sources/audio\n', 'sources/audio/');
    expect(result.added).toBe(false);
    expect(result.text).toBe('sources/audio\n');
  });

  test('whitespace-only existing text is treated as a fresh file', () => {
    const result = appendGitignoreEntry('  \n', 'sources/audio/');
    expect(result.added).toBe(true);
    expect(result.text).toBe('sources/audio/\n');
  });
});
