import { describe, expect, test } from 'bun:test';
import type { AiMode } from './ai-mode-protocol';
import {
  AiModeLayer,
  enabledResolvedModes,
  isModeEnabled,
  layerModes
} from './ai-mode-layering';

function mode(id: string, extra: Partial<AiMode> = {}): AiMode {
  return { id, label: id, systemPrompt: `prompt for ${id}`, ...extra };
}

describe('layerModes', () => {
  test('returns bundled modes when only the built-in layer is present', () => {
    const resolved = layerModes([{ origin: 'built-in', modes: [mode('a'), mode('b')] }]);
    expect(resolved.map(m => m.id)).toEqual(['a', 'b']);
    expect(resolved.every(m => m.origin === 'built-in')).toBe(true);
    expect(resolved.every(m => m.enabled === true)).toBe(true);
    expect(resolved[0].overrides).toBeUndefined();
  });

  test('book overrides global overrides built-in by id, replacing the whole record', () => {
    const layers: AiModeLayer[] = [
      { origin: 'built-in', modes: [mode('shared', { label: 'base', systemPrompt: 'base prompt' })] },
      { origin: 'global', modes: [mode('shared', { label: 'global', systemPrompt: 'global prompt' })] },
      { origin: 'book', modes: [mode('shared', { label: 'book', systemPrompt: 'book prompt' })] }
    ];
    const resolved = layerModes(layers);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].origin).toBe('book');
    expect(resolved[0].label).toBe('book');
    expect(resolved[0].systemPrompt).toBe('book prompt');
    // Shadows a lower layer.
    expect(resolved[0].overrides).toBe('global');
  });

  test('a whole-record override drops fields not present in the higher layer', () => {
    const layers: AiModeLayer[] = [
      { origin: 'built-in', modes: [mode('x', { icon: 'star', menu: true, description: 'base desc' })] },
      { origin: 'book', modes: [mode('x', { label: 'override' })] }
    ];
    const resolved = layerModes(layers);
    expect(resolved[0].icon).toBeUndefined();
    expect(resolved[0].menu).toBeUndefined();
    expect(resolved[0].description).toBeUndefined();
    expect(resolved[0].label).toBe('override');
    expect(resolved[0].overrides).toBe('built-in');
  });

  test('preserves first-seen order: base first, then global-only, then book-only', () => {
    const layers: AiModeLayer[] = [
      { origin: 'built-in', modes: [mode('base1'), mode('base2')] },
      { origin: 'global', modes: [mode('base1'), mode('glob1')] },
      { origin: 'book', modes: [mode('base2'), mode('book1')] }
    ];
    const resolved = layerModes(layers);
    expect(resolved.map(m => m.id)).toEqual(['base1', 'base2', 'glob1', 'book1']);
    expect(resolved.find(m => m.id === 'base1')!.origin).toBe('global');
    expect(resolved.find(m => m.id === 'base2')!.origin).toBe('book');
  });

  test('is order-independent in the input array (sorted by precedence)', () => {
    const bookFirst: AiModeLayer[] = [
      { origin: 'book', modes: [mode('id', { label: 'book' })] },
      { origin: 'built-in', modes: [mode('id', { label: 'base' })] }
    ];
    const resolved = layerModes(bookFirst);
    expect(resolved[0].origin).toBe('book');
    expect(resolved[0].label).toBe('book');
    expect(resolved[0].overrides).toBe('built-in');
  });

  test('enabled defaults to true and only an explicit false disables', () => {
    const resolved = layerModes([
      { origin: 'book', modes: [mode('on'), mode('off', { enabled: false }), mode('explicit', { enabled: true })] }
    ]);
    expect(resolved.find(m => m.id === 'on')!.enabled).toBe(true);
    expect(resolved.find(m => m.id === 'off')!.enabled).toBe(false);
    expect(resolved.find(m => m.id === 'explicit')!.enabled).toBe(true);
  });

  test('a higher layer can disable a base mode via enabled:false', () => {
    const resolved = layerModes([
      { origin: 'built-in', modes: [mode('hideme', { enabled: true })] },
      { origin: 'book', modes: [mode('hideme', { enabled: false })] }
    ]);
    expect(resolved[0].enabled).toBe(false);
    expect(resolved[0].origin).toBe('book');
    expect(enabledResolvedModes(resolved)).toHaveLength(0);
  });

  test('a higher layer can re-enable a base mode disabled elsewhere', () => {
    const resolved = layerModes([
      { origin: 'built-in', modes: [mode('m', { enabled: false })] },
      { origin: 'book', modes: [mode('m', { enabled: true })] }
    ]);
    expect(resolved[0].enabled).toBe(true);
    expect(enabledResolvedModes(resolved).map(m => m.id)).toEqual(['m']);
  });
});

describe('enabledResolvedModes', () => {
  test('drops disabled modes, keeps origin tags', () => {
    const resolved = layerModes([
      { origin: 'built-in', modes: [mode('keep')] },
      { origin: 'global', modes: [mode('drop', { enabled: false })] }
    ]);
    const enabled = enabledResolvedModes(resolved);
    expect(enabled.map(m => m.id)).toEqual(['keep']);
    expect(enabled[0].origin).toBe('built-in');
  });
});

describe('isModeEnabled', () => {
  test('true unless enabled is explicitly false', () => {
    expect(isModeEnabled(mode('a'))).toBe(true);
    expect(isModeEnabled(mode('a', { enabled: true }))).toBe(true);
    expect(isModeEnabled(mode('a', { enabled: false }))).toBe(false);
  });
});
