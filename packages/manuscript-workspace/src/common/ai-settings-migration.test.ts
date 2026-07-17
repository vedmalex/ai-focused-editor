import { describe, expect, it } from 'bun:test';
import { parse } from 'jsonc-parser';
import {
  AI_SETTINGS_KEY_MIGRATION,
  LEGACY_AI_SETTING_KEYS,
  migrateAiSettingsText,
  planKeyMigrations,
  scanLegacyAiSettings,
  type KeyMigrationDecisionInput
} from './ai-settings-migration';

describe('AI_SETTINGS_KEY_MIGRATION', () => {
  it('maps every legacy aiFocusedEditor.ai.* key to an aiConnect.* twin', () => {
    for (const { legacy, next } of AI_SETTINGS_KEY_MIGRATION) {
      expect(legacy.startsWith('aiFocusedEditor.ai.')).toBe(true);
      expect(next.startsWith('aiConnect.')).toBe(true);
      // The suffix is preserved across the rename (endpoints -> endpoints, ...).
      expect(next.split('.').pop()).toBe(legacy.split('.').pop());
    }
  });

  it('covers the seven connection + overview keys, uniquely', () => {
    expect(LEGACY_AI_SETTING_KEYS.length).toBe(7);
    expect(new Set(LEGACY_AI_SETTING_KEYS).size).toBe(7);
    expect(LEGACY_AI_SETTING_KEYS).toContain('aiFocusedEditor.ai.manuscriptOverview');
  });
});

describe('scanLegacyAiSettings', () => {
  it('reports no keys for an absent, empty, or whitespace text', () => {
    expect(scanLegacyAiSettings(undefined)).toEqual({ legacyKeys: [], malformed: false });
    expect(scanLegacyAiSettings('')).toEqual({ legacyKeys: [], malformed: false });
    expect(scanLegacyAiSettings('   \n ')).toEqual({ legacyKeys: [], malformed: false });
  });

  it('finds the legacy keys present, in mapping order', () => {
    const text = JSON.stringify({
      'workbench.colorTheme': 'Dark',
      'aiFocusedEditor.ai.activeAlias': 'deep',
      'aiFocusedEditor.ai.apiKeys': { gateway: 'sk' }
    });
    const scan = scanLegacyAiSettings(text);
    // apiKeys precedes activeAlias in the mapping order.
    expect(scan.legacyKeys).toEqual(['aiFocusedEditor.ai.apiKeys', 'aiFocusedEditor.ai.activeAlias']);
    expect(scan.malformed).toBe(false);
  });

  it('tolerates comments and trailing commas (JSONC)', () => {
    const text = '{\n  // a comment\n  "aiFocusedEditor.ai.requestLog": "full",\n}';
    expect(scanLegacyAiSettings(text)).toEqual({
      legacyKeys: ['aiFocusedEditor.ai.requestLog'],
      malformed: false
    });
  });

  it('flags malformed JSON', () => {
    const scan = scanLegacyAiSettings('{ "aiFocusedEditor.ai.requestLog": }');
    expect(scan.malformed).toBe(true);
    expect(scan.legacyKeys).toEqual([]);
  });

  it('flags a non-object top level as malformed', () => {
    expect(scanLegacyAiSettings('[1, 2, 3]').malformed).toBe(true);
    expect(scanLegacyAiSettings('"a string"').malformed).toBe(true);
  });
});

describe('planKeyMigrations', () => {
  const pair: KeyMigrationDecisionInput = {
    legacy: 'aiFocusedEditor.ai.activeAlias',
    next: 'aiConnect.activeAlias',
    legacySet: false,
    newSet: false
  };

  it('moves a set legacy key whose twin is unset', () => {
    const plan = planKeyMigrations([{ ...pair, legacySet: true, newSet: false }]);
    expect(plan.move).toEqual([{ legacy: pair.legacy, next: pair.next }]);
    expect(plan.drop).toEqual([]);
  });

  it('drops a set legacy key whose twin is already set (twin wins)', () => {
    const plan = planKeyMigrations([{ ...pair, legacySet: true, newSet: true }]);
    expect(plan.move).toEqual([]);
    expect(plan.drop).toEqual([{ legacy: pair.legacy, next: pair.next }]);
  });

  it('leaves an unset legacy key alone regardless of the twin', () => {
    expect(planKeyMigrations([{ ...pair, legacySet: false, newSet: false }])).toEqual({ move: [], drop: [] });
    expect(planKeyMigrations([{ ...pair, legacySet: false, newSet: true }])).toEqual({ move: [], drop: [] });
  });
});

describe('migrateAiSettingsText', () => {
  it('moves a legacy value to its neutral twin and removes the legacy key', () => {
    const src = '{\n    "aiFocusedEditor.ai.activeAlias": "deep"\n}';
    const result = migrateAiSettingsText(src);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.movedKeys).toEqual(['aiFocusedEditor.ai.activeAlias']);
    expect(result.droppedKeys).toEqual([]);
    const parsed = parse(result.text) as Record<string, unknown>;
    expect(parsed['aiConnect.activeAlias']).toBe('deep');
    expect('aiFocusedEditor.ai.activeAlias' in parsed).toBe(false);
  });

  it('preserves unrelated keys and their comments', () => {
    const src = [
      '{',
      '  // keep me',
      '  "editor.fontSize": 14,',
      '  "aiFocusedEditor.ai.requestLog": "full",',
      '  "workbench.colorTheme": "Dark"',
      '}'
    ].join('\n');
    const result = migrateAiSettingsText(src);
    expect(result.text).toContain('// keep me');
    expect(result.text).toContain('"editor.fontSize": 14');
    expect(result.text).toContain('"workbench.colorTheme": "Dark"');
    const parsed = parse(result.text) as Record<string, unknown>;
    expect(parsed['aiConnect.requestLog']).toBe('full');
    expect(parsed['editor.fontSize']).toBe(14);
  });

  it('drops a shadowed legacy key when the twin already holds a value (twin wins)', () => {
    const src = JSON.stringify({
      'aiConnect.activeAlias': 'fresh',
      'aiFocusedEditor.ai.activeAlias': 'stale'
    });
    const result = migrateAiSettingsText(src);
    expect(result.movedKeys).toEqual([]);
    expect(result.droppedKeys).toEqual(['aiFocusedEditor.ai.activeAlias']);
    const parsed = parse(result.text) as Record<string, unknown>;
    expect(parsed['aiConnect.activeAlias']).toBe('fresh');
    expect('aiFocusedEditor.ai.activeAlias' in parsed).toBe(false);
  });

  it('migrates complex object/array values intact', () => {
    const endpoints = [{ id: 'gateway', provider: 'openai' }];
    const src = JSON.stringify({ 'aiFocusedEditor.ai.endpoints': endpoints }, undefined, 4);
    const result = migrateAiSettingsText(src);
    const parsed = parse(result.text) as Record<string, unknown>;
    expect(parsed['aiConnect.endpoints']).toEqual(endpoints);
  });

  it('is idempotent — a second run over migrated text changes nothing', () => {
    const src = '{\n    "aiFocusedEditor.ai.activeAlias": "deep"\n}';
    const once = migrateAiSettingsText(src);
    const twice = migrateAiSettingsText(once.text);
    expect(twice.changed).toBe(false);
    expect(twice.movedKeys).toEqual([]);
    expect(twice.droppedKeys).toEqual([]);
    expect(twice.text).toBe(once.text);
  });

  it('leaves a text with no legacy keys unchanged', () => {
    const src = '{\n    "aiConnect.activeAlias": "deep"\n}';
    const result = migrateAiSettingsText(src);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(src);
  });

  it('refuses to rewrite malformed JSON (report, do not write)', () => {
    const src = '{ "aiFocusedEditor.ai.activeAlias": }';
    const result = migrateAiSettingsText(src);
    expect(result.ok).toBe(false);
    expect(result.malformed).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(src);
  });

  it('migrates the manuscriptOverview key too', () => {
    const src = JSON.stringify({ 'aiFocusedEditor.ai.manuscriptOverview': 'compact' });
    const result = migrateAiSettingsText(src);
    const parsed = parse(result.text) as Record<string, unknown>;
    expect(parsed['aiConnect.manuscriptOverview']).toBe('compact');
  });
});
