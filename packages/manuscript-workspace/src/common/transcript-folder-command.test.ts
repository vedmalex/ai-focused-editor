import { describe, expect, test } from 'bun:test';
import URI from '@theia/core/lib/common/uri';
import { buildTranscribeFolderArgs, resolveDirectoryUriFromNode } from './transcript-folder-command';

describe('buildTranscribeFolderArgs (U3a navigator context-menu wizard args, UR-003/UR-007)', () => {
  test('builds import-mode wizard args carrying the folder URI as a string', () => {
    const folder = new URI('file:///workspace/legacy%20transcripts');
    expect(buildTranscribeFolderArgs(folder)).toEqual({
      mode: 'import',
      importFolder: folder.toString()
    });
  });

  test('preserves a nested folder path unchanged, always in import mode', () => {
    const folder = new URI('file:///workspace/book/imports/2026-lecture');
    const args = buildTranscribeFolderArgs(folder);
    expect(args.mode).toBe('import');
    expect(args.importFolder).toBe('file:///workspace/book/imports/2026-lecture');
  });
});

describe('resolveDirectoryUriFromNode (U3a isEnabled/isVisible predicate, folder-only)', () => {
  test('resolves the URI of a directory-shaped navigator node', () => {
    const folder = new URI('file:///workspace/legacy');
    const dirNode = { uri: folder, fileStat: { isDirectory: true } };
    expect(resolveDirectoryUriFromNode(dirNode)).toBe(folder);
  });

  test('returns undefined for a file-shaped navigator node', () => {
    const fileNode = { uri: new URI('file:///workspace/notes.md'), fileStat: { isDirectory: false } };
    expect(resolveDirectoryUriFromNode(fileNode)).toBeUndefined();
  });

  test('returns undefined for a non-node value (no selection / unrelated widget selection)', () => {
    expect(resolveDirectoryUriFromNode(undefined)).toBeUndefined();
    expect(resolveDirectoryUriFromNode(null)).toBeUndefined();
    expect(resolveDirectoryUriFromNode('not-a-node')).toBeUndefined();
    expect(resolveDirectoryUriFromNode({})).toBeUndefined();
  });

  test('returns undefined when fileStat is missing isDirectory (malformed node)', () => {
    expect(resolveDirectoryUriFromNode({ uri: new URI('file:///x'), fileStat: {} })).toBeUndefined();
  });
});
