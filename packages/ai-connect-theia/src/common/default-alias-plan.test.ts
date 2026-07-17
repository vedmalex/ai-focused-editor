import { describe, expect, test } from 'bun:test';
import { planDefaultAliasUpdates } from './default-alias-plan';

const MODEL = 'ai-focused-editor.ai-connect';

describe('planDefaultAliasUpdates', () => {
  test('prepends the model to every default/* alias missing it', () => {
    const updates = planDefaultAliasUpdates([
      { id: 'default/universal', defaultModelIds: ['anthropic/claude-opus-4-8', 'openai/gpt-5.5'] },
      { id: 'default/fast', defaultModelIds: ['anthropic/claude-haiku-4-5'] }
    ], MODEL, true);
    expect(updates).toHaveLength(2);
    expect(updates[0].defaultModelIds).toEqual([MODEL, 'anthropic/claude-opus-4-8', 'openai/gpt-5.5']);
    expect(updates[1].defaultModelIds).toEqual([MODEL, 'anthropic/claude-haiku-4-5']);
  });

  test('is idempotent: already-first model produces no update', () => {
    const updates = planDefaultAliasUpdates([
      { id: 'default/universal', defaultModelIds: [MODEL, 'openai/gpt-5.5'] }
    ], MODEL, true);
    expect(updates).toHaveLength(0);
  });

  test('moves the model to the front when present but not first', () => {
    const updates = planDefaultAliasUpdates([
      { id: 'default/code', defaultModelIds: ['openai/gpt-5.5', MODEL] }
    ], MODEL, true);
    expect(updates).toHaveLength(1);
    expect(updates[0].defaultModelIds).toEqual([MODEL, 'openai/gpt-5.5']);
  });

  test('removes the model everywhere when disabled', () => {
    const updates = planDefaultAliasUpdates([
      { id: 'default/universal', defaultModelIds: [MODEL, 'openai/gpt-5.5'] },
      { id: 'default/fast', defaultModelIds: ['anthropic/claude-haiku-4-5'] }
    ], MODEL, false);
    expect(updates).toHaveLength(1);
    expect(updates[0].defaultModelIds).toEqual(['openai/gpt-5.5']);
  });

  test('ignores non-default aliases and preserves selectedModelId and description', () => {
    const updates = planDefaultAliasUpdates([
      { id: 'my-custom-alias', defaultModelIds: ['x'] },
      { id: 'default/summarize', defaultModelIds: ['openai/gpt-5.5'], selectedModelId: 'user-pick', description: 'd' }
    ], MODEL, true);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('default/summarize');
    expect(updates[0].selectedModelId).toBe('user-pick');
    expect(updates[0].description).toBe('d');
  });
});
