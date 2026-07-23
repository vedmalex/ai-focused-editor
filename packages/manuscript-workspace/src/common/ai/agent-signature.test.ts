import { describe, expect, test } from 'bun:test';
import { computeAgentDisplayName, computeAgentSignature } from './agent-signature';

/**
 * Frozen pre-refactor formula (verbatim from
 * `AiModeDynamicContribution.agentDisplayName`/`agentSignature` before
 * TASK-018 WP-U4-1b extracted it into this module). This is the equivalence
 * oracle: `computeAgentSignature` must produce byte-identical output for
 * every fixture below (ISS-190).
 */
function legacyAgentSignature(mode: { label?: string; id: string; description?: string; systemPrompt: string }): string {
  return JSON.stringify([mode.label?.trim() || mode.id, mode.description ?? '', mode.systemPrompt]);
}

describe('computeAgentDisplayName', () => {
  test('uses the trimmed label when present', () => {
    const mode = { id: 'polish', label: '  Polish Prose  ' };
    expect(computeAgentDisplayName(mode)).toBe('Polish Prose');
  });

  test('falls back to the id when label is undefined', () => {
    const mode = { id: 'polish' } as { id: string; label?: string };
    expect(computeAgentDisplayName(mode)).toBe('polish');
  });

  test('falls back to the id when label is an empty string', () => {
    const mode = { id: 'polish', label: '' };
    expect(computeAgentDisplayName(mode)).toBe('polish');
  });

  test('falls back to the id when label is whitespace-only', () => {
    const mode = { id: 'polish', label: '   ' };
    expect(computeAgentDisplayName(mode)).toBe('polish');
  });
});

describe('computeAgentSignature — equivalence with the pre-refactor formula (ISS-190)', () => {
  const fixtures: Array<{ name: string; mode: { id: string; label?: string; description?: string; systemPrompt: string } }> = [
    {
      name: 'mode with label',
      mode: { id: 'polish', label: 'Polish Prose', description: 'Tighten wording', systemPrompt: 'You polish prose.' }
    },
    {
      name: 'mode without label (id fallback)',
      mode: { id: 'polish', systemPrompt: 'You polish prose.' }
    },
    {
      name: 'mode with empty label (id fallback)',
      mode: { id: 'polish', label: '', description: 'Tighten wording', systemPrompt: 'You polish prose.' }
    },
    {
      name: 'mode with empty description',
      mode: { id: 'summarize', label: 'Summarize', description: '', systemPrompt: 'You summarize text.' }
    },
    {
      name: 'mode with missing description',
      mode: { id: 'summarize', label: 'Summarize', systemPrompt: 'You summarize text.' }
    }
  ];

  for (const { name, mode } of fixtures) {
    test(`matches the legacy formula: ${name}`, () => {
      expect(computeAgentSignature(mode)).toBe(legacyAgentSignature(mode));
    });
  }

  test('golden string: mode with label', () => {
    const mode = { id: 'polish', label: 'Polish Prose', description: 'Tighten wording', systemPrompt: 'You polish prose.' };
    expect(computeAgentSignature(mode)).toBe(
      '["Polish Prose","Tighten wording","You polish prose."]'
    );
  });

  test('golden string: mode without label (id fallback)', () => {
    const mode = { id: 'polish', systemPrompt: 'You polish prose.' };
    expect(computeAgentSignature(mode)).toBe(
      '["polish","","You polish prose."]'
    );
  });

  test('golden string: mode with empty description', () => {
    const mode = { id: 'summarize', label: 'Summarize', description: '', systemPrompt: 'You summarize text.' };
    expect(computeAgentSignature(mode)).toBe(
      '["Summarize","","You summarize text."]'
    );
  });
});
