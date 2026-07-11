import { describe, expect, test } from 'bun:test';
import {
  aiModeToRow,
  applyOptionsForContext,
  defaultApplyForContext,
  flattenModes,
  hasBlockingProblems,
  isApplyValidForContext,
  isKebabCase,
  modeToYamlPatch,
  validateModes,
  type AiModeRow
} from './ai-mode-forms';

function row(overrides: Partial<AiModeRow> = {}): AiModeRow {
  return {
    id: 'improve',
    label: '',
    description: '',
    systemPrompt: 'You improve text.',
    userPrompt: '',
    context: 'chat',
    apply: 'chat',
    menu: false,
    agent: false,
    icon: '',
    enabled: true,
    temperature: '',
    maxTokens: '',
    ...overrides
  };
}

describe('flattenModes', () => {
  test('reads modes from a { modes: [...] } document with defaults applied', () => {
    const rows = flattenModes({
      version: 1,
      modes: [
        {
          id: 'improve-selection',
          label: 'Improve',
          description: 'Improve the selection',
          systemPrompt: 'You improve text.',
          userPrompt: 'Improve this.',
          context: 'selection',
          apply: 'replace',
          menu: true,
          agent: false,
          icon: 'sparkle',
          parameters: { temperature: 0.5, maxTokens: 800 }
        }
      ]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'improve-selection',
      label: 'Improve',
      description: 'Improve the selection',
      systemPrompt: 'You improve text.',
      userPrompt: 'Improve this.',
      context: 'selection',
      apply: 'replace',
      menu: true,
      agent: false,
      icon: 'sparkle',
      enabled: true,
      temperature: '0.5',
      maxTokens: '800'
    });
  });

  test('applies defaults for a minimal mode', () => {
    const rows = flattenModes({ modes: [{ id: 'plain', systemPrompt: 'Do a thing.' }] });
    expect(rows[0]).toMatchObject({
      id: 'plain',
      label: '',
      context: 'chat',
      apply: 'chat',
      menu: false,
      agent: false,
      icon: '',
      temperature: '',
      maxTokens: ''
    });
  });

  test('accepts the legacy `prompt` alias for systemPrompt', () => {
    const rows = flattenModes({ modes: [{ id: 'legacy', prompt: 'Legacy prompt.' }] });
    expect(rows[0].systemPrompt).toBe('Legacy prompt.');
  });

  test('accepts a bare list and skips non-object entries', () => {
    const rows = flattenModes([{ id: 'a', systemPrompt: 's' }, 'nope', null, 42]);
    expect(rows.map(r => r.id)).toEqual(['a']);
  });

  test('coerces an apply that is invalid for the context back to the default', () => {
    const rows = flattenModes({ modes: [{ id: 'x', systemPrompt: 's', context: 'chat', apply: 'replace' }] });
    expect(rows[0].apply).toBe('chat');
  });

  test('returns an empty list for missing/invalid input', () => {
    expect(flattenModes(undefined)).toEqual([]);
    expect(flattenModes({ modes: 5 })).toEqual([]);
    expect(flattenModes('nope')).toEqual([]);
  });

  test('non-numeric parameters become empty strings', () => {
    const rows = flattenModes({ modes: [{ id: 'x', systemPrompt: 's', parameters: { temperature: 'hot' } }] });
    expect(rows[0].temperature).toBe('');
  });
});

describe('apply/context helpers', () => {
  test('defaultApplyForContext follows resolveAiModeApply', () => {
    expect(defaultApplyForContext('selection')).toBe('replace');
    expect(defaultApplyForContext('word')).toBe('chat');
    expect(defaultApplyForContext('chapter')).toBe('chat');
    expect(defaultApplyForContext('chat')).toBe('chat');
  });

  test('isApplyValidForContext restricts replace/insert to selection/word', () => {
    expect(isApplyValidForContext('replace', 'selection')).toBe(true);
    expect(isApplyValidForContext('insert', 'word')).toBe(true);
    expect(isApplyValidForContext('replace', 'chat')).toBe(false);
    expect(isApplyValidForContext('insert', 'chapter')).toBe(false);
    expect(isApplyValidForContext('chat', 'chat')).toBe(true);
    expect(isApplyValidForContext('chat', 'selection')).toBe(true);
  });

  test('applyOptionsForContext filters by context validity', () => {
    expect(applyOptionsForContext('selection')).toEqual(['replace', 'insert', 'chat']);
    expect(applyOptionsForContext('word')).toEqual(['replace', 'insert', 'chat']);
    expect(applyOptionsForContext('chapter')).toEqual(['chat']);
    expect(applyOptionsForContext('chat')).toEqual(['chat']);
  });

  test('isKebabCase', () => {
    expect(isKebabCase('improve-selection')).toBe(true);
    expect(isKebabCase('a1')).toBe(true);
    expect(isKebabCase('Improve')).toBe(false);
    expect(isKebabCase('with space')).toBe(false);
    expect(isKebabCase('-lead')).toBe(false);
    expect(isKebabCase('trail-')).toBe(false);
  });
});

describe('modeToYamlPatch', () => {
  test('writes only the id + systemPrompt for a minimal mode and omits the defaults', () => {
    const patch = modeToYamlPatch(row({ id: 'plain' }));
    expect(patch.write).toEqual({ id: 'plain', systemPrompt: 'You improve text.' });
    // menu:false / agent:false / context:'chat' delete the key rather than write noise.
    expect(patch.omit).toEqual(expect.arrayContaining(['menu', 'agent', 'context', 'apply', 'label', 'description', 'userPrompt', 'icon', 'parameters']));
  });

  test('keeps id first and preserves a readable key order', () => {
    const patch = modeToYamlPatch(row({
      id: 'improve-selection',
      label: 'Improve',
      description: 'desc',
      context: 'selection',
      apply: 'insert',
      menu: true,
      agent: true,
      icon: 'sparkle',
      userPrompt: 'Improve this.',
      temperature: '0.5',
      maxTokens: '800'
    }));
    expect(Object.keys(patch.write)).toEqual([
      'id', 'label', 'description', 'systemPrompt', 'userPrompt', 'context', 'apply', 'menu', 'agent', 'icon', 'parameters'
    ]);
    expect(patch.write.parameters).toEqual({ temperature: 0.5, maxTokens: 800 });
    // enabled defaults to true and is the only omitted key here.
    expect(patch.omit).toEqual(['enabled']);
  });

  test('menu/agent write true only when enabled', () => {
    expect(modeToYamlPatch(row({ menu: true })).write.menu).toBe(true);
    expect(modeToYamlPatch(row({ menu: false })).write.menu).toBeUndefined();
    expect(modeToYamlPatch(row({ agent: true })).write.agent).toBe(true);
    expect(modeToYamlPatch(row({ agent: false })).write.agent).toBeUndefined();
  });

  test('omits apply when it equals the context default, writes it otherwise', () => {
    // selection default is replace -> replace omitted, insert written.
    expect(modeToYamlPatch(row({ context: 'selection', apply: 'replace' })).omit).toContain('apply');
    expect(modeToYamlPatch(row({ context: 'selection', apply: 'insert' })).write.apply).toBe('insert');
    // chat default is chat -> chat omitted.
    expect(modeToYamlPatch(row({ context: 'chat', apply: 'chat' })).omit).toContain('apply');
  });

  test('drops an apply invalid for the context back to the omitted default', () => {
    const patch = modeToYamlPatch(row({ context: 'chat', apply: 'replace' }));
    expect(patch.write.apply).toBeUndefined();
    expect(patch.omit).toContain('apply');
  });

  test('only sets the parameter sub-keys that are present', () => {
    expect(modeToYamlPatch(row({ temperature: '0.7' })).write.parameters).toEqual({ temperature: 0.7 });
    expect(modeToYamlPatch(row({ maxTokens: '256' })).write.parameters).toEqual({ maxTokens: 256 });
    expect(modeToYamlPatch(row({})).write.parameters).toBeUndefined();
  });

  test('trims id but preserves multi-line prompt content verbatim', () => {
    const patch = modeToYamlPatch(row({ id: '  spaced  ', systemPrompt: 'line 1\nline 2\n' }));
    expect(patch.write.id).toBe('spaced');
    expect(patch.write.systemPrompt).toBe('line 1\nline 2\n');
  });

  test('writes enabled:false only when disabled and omits it by default', () => {
    expect(modeToYamlPatch(row({ enabled: false })).write.enabled).toBe(false);
    const patch = modeToYamlPatch(row({ enabled: true }));
    expect(patch.write.enabled).toBeUndefined();
    expect(patch.omit).toContain('enabled');
  });

  test('never writes an origin field into the file (derived, not persisted)', () => {
    const seeded = aiModeToRow({
      id: 'from-base', label: 'Base', systemPrompt: 'base', origin: 'built-in', enabled: true
    });
    const patch = modeToYamlPatch(seeded);
    expect(Object.keys(patch.write)).not.toContain('origin');
    expect(patch.omit).not.toContain('origin');
    expect('origin' in patch.write).toBe(false);
  });
});

describe('aiModeToRow', () => {
  test('seeds an editable row from a resolved mode, dropping origin/overrides', () => {
    const seeded = aiModeToRow({
      id: 'gv-proof',
      label: 'Корректура',
      description: 'desc',
      systemPrompt: 'prompt',
      context: 'selection',
      apply: 'replace',
      menu: true,
      icon: 'check',
      origin: 'built-in',
      enabled: true,
      parameters: { temperature: 0.2 }
    });
    expect(seeded.id).toBe('gv-proof');
    expect(seeded.context).toBe('selection');
    expect(seeded.apply).toBe('replace');
    expect(seeded.menu).toBe(true);
    expect(seeded.icon).toBe('check');
    expect(seeded.temperature).toBe('0.2');
    // origin/overrides are not row fields.
    expect((seeded as Record<string, unknown>).origin).toBeUndefined();
  });

  test('carries an explicit disabled flag through to the row', () => {
    const seeded = aiModeToRow({ id: 'x', label: 'x', systemPrompt: 's', enabled: false });
    expect(seeded.enabled).toBe(false);
  });
});

describe('validateModes', () => {
  test('accepts a valid unique set', () => {
    const problems = validateModes([
      row({ id: 'improve-selection' }),
      row({ id: 'fix-grammar' })
    ]);
    expect(hasBlockingProblems(problems)).toBe(false);
  });

  test('flags an empty id', () => {
    const problems = validateModes([row({ id: '' })]);
    expect(problems.some(p => p.severity === 'error' && /id is required/.test(p.message))).toBe(true);
  });

  test('flags duplicate ids', () => {
    const problems = validateModes([row({ id: 'dup' }), row({ id: 'dup' })]);
    expect(problems.filter(p => /duplicate/.test(p.message))).toHaveLength(1);
    expect(hasBlockingProblems(problems)).toBe(true);
  });

  test('warns (non-blocking) about a non-kebab id', () => {
    const problems = validateModes([row({ id: 'ImproveSelection' })]);
    const kebab = problems.find(p => /kebab-case/.test(p.message));
    expect(kebab?.severity).toBe('warning');
    expect(hasBlockingProblems(problems)).toBe(false);
  });

  test('requires a system prompt', () => {
    const problems = validateModes([row({ id: 'x', systemPrompt: '' })]);
    expect(problems.some(p => p.severity === 'error' && /system prompt is required/.test(p.message))).toBe(true);
  });

  test('flags an invalid apply/context combination', () => {
    const problems = validateModes([row({ id: 'x', context: 'chat', apply: 'replace' })]);
    expect(problems.some(p => p.severity === 'error' && /only valid for a selection or word/.test(p.message))).toBe(true);
  });

  test('warns about out-of-range parameters', () => {
    const tooHot = validateModes([row({ id: 'x', temperature: '3' })]);
    expect(tooHot.some(p => p.severity === 'warning' && /temperature/.test(p.message))).toBe(true);
    const badTokens = validateModes([row({ id: 'y', maxTokens: '0' })]);
    expect(badTokens.some(p => p.severity === 'warning' && /maxTokens/.test(p.message))).toBe(true);
  });
});
