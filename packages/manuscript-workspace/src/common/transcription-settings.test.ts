import { describe, expect, test } from 'bun:test';
import {
  hasWorkspaceScopedValue,
  resolveEffectivePreference,
  splitGroqApiKeys
} from './transcription-settings';

describe('resolveEffectivePreference (Theia cascade: folder > workspace > user > default)', () => {
  test('nothing defined anywhere resolves to the default value with origin "default"', () => {
    expect(resolveEffectivePreference({ defaultValue: 'local' })).toEqual({ value: 'local', origin: 'default' });
    expect(resolveEffectivePreference({})).toEqual({ value: undefined, origin: 'default' });
  });

  test('a user value overrides the default', () => {
    expect(resolveEffectivePreference({ defaultValue: '', globalValue: '/usr/bin/ffmpeg' }))
      .toEqual({ value: '/usr/bin/ffmpeg', origin: 'user' });
  });

  test('a workspace value overrides the user value', () => {
    expect(resolveEffectivePreference({
      defaultValue: '',
      globalValue: '/user/path',
      workspaceValue: '/workspace/path'
    })).toEqual({ value: '/workspace/path', origin: 'workspace' });
  });

  test('a workspace-folder value is the narrowest and wins over everything', () => {
    expect(resolveEffectivePreference({
      defaultValue: '',
      globalValue: '/user/path',
      workspaceValue: '/workspace/path',
      workspaceFolderValue: '/folder/path'
    })).toEqual({ value: '/folder/path', origin: 'folder' });
  });

  test('an EMPTY STRING at a narrower scope is a defined value (a deliberate clear)', () => {
    expect(resolveEffectivePreference({ globalValue: '/user/path', workspaceValue: '' }))
      .toEqual({ value: '', origin: 'workspace' });
  });

  test('numbers cascade the same way', () => {
    expect(resolveEffectivePreference<number>({ defaultValue: 8, workspaceValue: 4 }))
      .toEqual({ value: 4, origin: 'workspace' });
  });
});

describe('hasWorkspaceScopedValue', () => {
  test('true for a non-blank workspace or workspace-folder value', () => {
    expect(hasWorkspaceScopedValue({ workspaceValue: 'gsk_key' })).toBe(true);
    expect(hasWorkspaceScopedValue({ workspaceFolderValue: 'gsk_key' })).toBe(true);
  });

  test('false for blank workspace values, user-only values, or nothing', () => {
    expect(hasWorkspaceScopedValue({ workspaceValue: '   ' })).toBe(false);
    expect(hasWorkspaceScopedValue({ globalValue: 'gsk_key' })).toBe(false);
    expect(hasWorkspaceScopedValue({})).toBe(false);
  });
});

describe('splitGroqApiKeys (comma-separated key list convention)', () => {
  test('splits, trims, and drops blanks', () => {
    expect(splitGroqApiKeys(' gsk_a , gsk_b ,, gsk_c ')).toEqual(['gsk_a', 'gsk_b', 'gsk_c']);
  });

  test('a single key yields a one-element list', () => {
    expect(splitGroqApiKeys('gsk_only')).toEqual(['gsk_only']);
  });

  test('blank/undefined input yields an empty list', () => {
    expect(splitGroqApiKeys('')).toEqual([]);
    expect(splitGroqApiKeys('  ,  ')).toEqual([]);
    expect(splitGroqApiKeys(undefined)).toEqual([]);
  });
});
