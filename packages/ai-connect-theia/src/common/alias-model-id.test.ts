import { describe, expect, it } from 'bun:test';
import {
  ALIAS_MODEL_ID_PREFIX,
  aliasFromModelId,
  aliasModelId,
  diffAliasModels,
  isAliasModelId
} from './alias-model-id';

describe('aliasModelId / aliasFromModelId', () => {
  it('produces the ai-connect/<alias> scheme and round-trips', () => {
    expect(aliasModelId('fast')).toBe('ai-connect/fast');
    expect(aliasFromModelId('ai-connect/fast')).toBe('fast');
  });

  it('encodes awkward characters so the segment is a single token, and round-trips', () => {
    for (const alias of ['a/b', 'with space', '100%done', 'кириллица', 'a?b#c', '']) {
      const id = aliasModelId(alias);
      // The only slash is the prefix separator.
      expect(id.slice(ALIAS_MODEL_ID_PREFIX.length).includes('/')).toBe(false);
      expect(aliasFromModelId(id)).toBe(alias);
    }
  });

  it('is collision-free for distinct aliases that look similar once separated', () => {
    // 'a/b' and 'a' + '/b' must not collapse, because '/' is encoded.
    expect(aliasModelId('a/b')).not.toBe(`${ALIAS_MODEL_ID_PREFIX}a/b`);
    expect(aliasModelId('a b')).not.toBe(aliasModelId('a%20b'));
    expect(aliasFromModelId(aliasModelId('a b'))).toBe('a b');
    expect(aliasFromModelId(aliasModelId('a%20b'))).toBe('a%20b');
  });

  it('isAliasModelId only matches our prefix', () => {
    expect(isAliasModelId('ai-connect/x')).toBe(true);
    expect(isAliasModelId('ai-focused-editor.ai-connect')).toBe(false);
    expect(aliasFromModelId('ai-focused-editor.ai-connect')).toBeUndefined();
  });

  it('returns undefined for malformed percent-encoding rather than throwing', () => {
    expect(aliasFromModelId('ai-connect/%')).toBeUndefined();
  });
});

describe('diffAliasModels', () => {
  it('adds models for brand-new aliases', () => {
    const diff = diffAliasModels([], ['fast', 'smart']);
    expect(diff.toAdd).toEqual([
      { alias: 'fast', id: 'ai-connect/fast' },
      { alias: 'smart', id: 'ai-connect/smart' }
    ]);
    expect(diff.toRemove).toEqual([]);
  });

  it('is a no-op when the registry already matches the alias list', () => {
    const diff = diffAliasModels(['ai-connect/fast', 'ai-connect/smart'], ['fast', 'smart']);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRemove).toEqual([]);
  });

  it('removes models whose alias is gone', () => {
    const diff = diffAliasModels(['ai-connect/fast', 'ai-connect/smart'], ['fast']);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRemove).toEqual(['ai-connect/smart']);
  });

  it('treats a rename as add + remove', () => {
    const diff = diffAliasModels(['ai-connect/old'], ['new']);
    expect(diff.toAdd).toEqual([{ alias: 'new', id: 'ai-connect/new' }]);
    expect(diff.toRemove).toEqual(['ai-connect/old']);
  });

  it('adds only the new alias and keeps the existing one', () => {
    const diff = diffAliasModels(['ai-connect/fast'], ['fast', 'smart']);
    expect(diff.toAdd).toEqual([{ alias: 'smart', id: 'ai-connect/smart' }]);
    expect(diff.toRemove).toEqual([]);
  });

  it('collapses duplicate aliases into a single model', () => {
    const diff = diffAliasModels([], ['fast', 'fast']);
    expect(diff.toAdd).toEqual([{ alias: 'fast', id: 'ai-connect/fast' }]);
  });

  it('handles encoded aliases end-to-end', () => {
    const diff = diffAliasModels(['ai-connect/a%2Fb'], ['a/b', 'c d']);
    expect(diff.toRemove).toEqual([]);
    expect(diff.toAdd).toEqual([{ alias: 'c d', id: aliasModelId('c d') }]);
  });
});
