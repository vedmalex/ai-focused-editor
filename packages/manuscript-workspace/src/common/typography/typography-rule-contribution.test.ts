import { describe, expect, test } from 'bun:test';
import { PreferenceScope } from '@theia/core/lib/common/preferences';
import {
  TYPOGRAPHY_ENABLED_KEY,
  TYPOGRAPHY_PREFERENCE_PREFIX,
  TYPOGRAPHY_SCOPE_KEY,
  buildTypographySchema,
  ruleEnabledKey
} from './typography-rule-contribution';
import { TypographyRule } from './typography-types';

/**
 * `buildTypographySchema` is the ONE place the per-rule settings surface comes
 * from — the OBLIGATORY half of UR-002 ("add a rule, its toggle appears"). It
 * shipped with no test at all (QA/ISS-253): nothing pinned that every rule gets a
 * key, that the key's default is the rule's OWN `defaultEnabled` (rather than a
 * blanket `true`, which would silently switch on the rules that ship off), or
 * that the master/scope keys survive. Those are exactly the regressions that
 * cost a user their preferences without any other visible symptom.
 */

/** A minimal rule stub — the schema builder reads only these four fields. */
function ruleStub(id: string, defaultEnabled: boolean): TypographyRule {
  return {
    id,
    descriptionKey: `ai-focused-editor/typography/${id}-desc`,
    defaultEnabled,
    priority: 10,
    apply: () => null
  };
}

const RULES: readonly TypographyRule[] = [
  ruleStub('alpha-rule', true),
  ruleStub('beta-rule', false),
  ruleStub('gamma-rule', true)
];

describe('buildTypographySchema — per-rule toggles (UR-002, ISS-253)', () => {
  test('EVERY rule gets its own preference key', () => {
    const properties = buildTypographySchema(RULES);
    for (const rule of RULES) {
      expect(properties[ruleEnabledKey(rule.id)]).toBeDefined();
    }
    // …and nothing extra: exactly the master, the scope, and one key per rule.
    expect(Object.keys(properties)).toHaveLength(RULES.length + 2);
  });

  test("a key's default is the RULE's defaultEnabled, not a blanket true", () => {
    const properties = buildTypographySchema(RULES);
    for (const rule of RULES) {
      expect(properties[ruleEnabledKey(rule.id)].default).toBe(rule.defaultEnabled);
    }
    // Anti-tautology: the fixture really does contain both polarities, so a
    // hard-coded `true` (or `false`) cannot pass the loop above.
    expect(RULES.some(rule => rule.defaultEnabled)).toBe(true);
    expect(RULES.some(rule => !rule.defaultEnabled)).toBe(true);
    expect(properties[ruleEnabledKey('beta-rule')].default).toBe(false);
  });

  test('every per-rule key is a boolean scoped to the folder', () => {
    const properties = buildTypographySchema(RULES);
    for (const rule of RULES) {
      const property = properties[ruleEnabledKey(rule.id)];
      expect(property.type).toBe('boolean');
      expect(property.scope).toBe(PreferenceScope.Folder);
    }
  });

  test('the master toggle and the scope enum are present alongside the rules', () => {
    const properties = buildTypographySchema(RULES);

    const master = properties[TYPOGRAPHY_ENABLED_KEY];
    expect(master).toBeDefined();
    expect(master.type).toBe('boolean');
    expect(master.default).toBe(true);

    const scope = properties[TYPOGRAPHY_SCOPE_KEY];
    expect(scope).toBeDefined();
    expect(scope.type).toBe('string');
    expect(scope.enum).toEqual(['chapters', 'all-md']);
    expect(scope.default).toBe('chapters');
  });

  test('EVERY key derives from TYPOGRAPHY_PREFERENCE_PREFIX', () => {
    const properties = buildTypographySchema(RULES);
    for (const key of Object.keys(properties)) {
      expect(key.startsWith(TYPOGRAPHY_PREFERENCE_PREFIX)).toBe(true);
    }
    // The exact key shape is PERSISTED in user settings and must never drift.
    expect(ruleEnabledKey('alpha-rule')).toBe('aiFocusedEditor.typography.alpha-rule.enabled');
    expect(TYPOGRAPHY_ENABLED_KEY).toBe('aiFocusedEditor.typography.enabled');
    expect(TYPOGRAPHY_SCOPE_KEY).toBe('aiFocusedEditor.typography.scope');
  });

  test('no key carries an empty description (the settings UI would show a blank row)', () => {
    const properties = buildTypographySchema(RULES);
    for (const key of Object.keys(properties)) {
      const description = properties[key].description;
      expect(typeof description).toBe('string');
      expect((description ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  test('the per-rule description falls back to a HUMANISED id, not the raw id', () => {
    const properties = buildTypographySchema([ruleStub('collapse-multiple-spaces', true)]);
    const description = properties[ruleEnabledKey('collapse-multiple-spaces')].description ?? '';
    expect(description).toContain('Collapse multiple spaces');
    expect(description).not.toContain('collapse-multiple-spaces');
  });

  test('an empty rule set still yields the master + scope keys (and nothing else)', () => {
    const properties = buildTypographySchema([]);
    expect(Object.keys(properties).sort()).toEqual([TYPOGRAPHY_ENABLED_KEY, TYPOGRAPHY_SCOPE_KEY].sort());
  });
});
