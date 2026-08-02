import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

/**
 * DOM bootstrap — MUST run before the Theia browser modules load. Same rationale
 * (and same shape) as `auto-typography-contribution.test.ts`: the frontend module
 * transitively imports monaco/Theia-browser code that touches `document` at
 * MODULE-EVALUATION time, and static ESM imports hoist above any setup, so the
 * imports below are DYNAMIC and deliberately sequenced after this bootstrap.
 *
 * TEST LANE: the bootstrap installs PROCESS-WIDE DOM globals, so the whole
 * `browser/typography` directory runs in its own `test:typography` lane (root
 * package.json) rather than inside the aggregated `test:packages` process.
 */
const domWindow = new Window() as unknown as Record<string, unknown>;
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = domWindow;
globals.self = domWindow;
for (const name of Object.getOwnPropertyNames(domWindow)) {
  if (globals[name] !== undefined) {
    continue;
  }
  try {
    const value = domWindow[name];
    if (value !== undefined) {
      globals[name] = value;
    }
  } catch {
    // Some happy-dom accessors throw when read out of context — skip them.
  }
}

/**
 * The module graph reaches `@theia/navigator`, whose contribution reads the
 * frontend application config AT MODULE-EVALUATION time and throws when it was
 * never set. Seeding an empty config is enough — nothing here renders.
 */
const { FrontendApplicationConfigProvider } = await import('@theia/core/lib/browser/frontend-application-config-provider');
FrontendApplicationConfigProvider.set({} as never);

const { Container } = await import('@theia/core/shared/inversify');
const { ContributionProvider } = await import('@theia/core/lib/common/contribution-provider');
const { TypographyRule } = await import('../../common/typography/typography-types');
const { buildTypographySchema, ruleEnabledKey } = await import('../../common/typography/typography-rule-contribution');
const { TYPOGRAPHY_RULES } = await import('../../common/typography/typography-rules');
const frontendModule = await import('./typography-frontend-module');

type Rule = import('../../common/typography/typography-types').TypographyRule;

/**
 * The canonical rule inventory of TASK-019 §3 — "ВСЕ 14 id ОКОНЧАТЕЛЬНЫ и
 * ФИКСИРОВАНЫ навсегда". Transcribed from the tech spec ON PURPOSE rather than
 * derived from any product module: a list computed from the code under test
 * would agree with it by construction and prove nothing.
 *
 * These ids are PERSISTED preference keys (`aiFocusedEditor.typography.<id>.enabled`),
 * so a rename silently orphans every user's saved toggle — hence an exact-set
 * assertion in BOTH directions, not a `toContain` sample (QA/ISS-253).
 */
const CANONICAL_RULE_IDS: readonly string[] = [
  'collapse-multiple-spaces',
  'no-space-before-punctuation',
  'space-after-punctuation',
  'spaced-hyphen-to-em-dash',
  'paragraph-leading-hyphen-to-em-dash',
  'normalize-word-hyphenation',
  'opening-quote-to-guillemet',
  'closing-quote-to-guillemet',
  'period-after-double-space',
  'paragraph-start-capital',
  'sentence-start-capital',
  'dialogue-dash-capital',
  'fix-double-capital-after-space',
  'fix-double-capital-after-punctuation'
];

/** Rules resolved from a REAL container the module was loaded into. */
function containerRules(): Rule[] {
  const container = new Container();
  container.load(frontendModule.default);
  return container.getAll<Rule>(TypographyRule);
}

describe('typography-frontend-module — the DI container serves all 14 canonical rules (ISS-253)', () => {
  test('the container resolves EXACTLY the canonical §3 id set', () => {
    const ids = containerRules().map(rule => rule.id);
    // Real DI resolution, not the exported array: a `bind` that never reaches
    // the container fails here even if the source list still mentions the rule.
    expect([...ids].sort()).toEqual([...CANONICAL_RULE_IDS].sort());
    expect(ids).toHaveLength(14);
  });

  test('no rule is bound twice (a duplicate would silently shadow in the engine map)', () => {
    const ids = containerRules().map(rule => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the CANONICAL common registry is what the container serves', () => {
    // F-CR-1: the registry now lives in `common/typography/typography-rules.ts`
    // (importable by the Node lane) and this module only binds a loop over it.
    // The bindings are generated FROM that array, so the two cannot drift — this
    // pins that relationship rather than re-asserting the ids a second time, and
    // it is what makes the Node-lane suites that import the same array a
    // statement about the SHIPPED rule set.
    expect(TYPOGRAPHY_RULES.map(rule => rule.id)).toEqual(containerRules().map(rule => rule.id));
  });

  test('every served rule is well-formed data (id/priority/nls keys/apply)', () => {
    for (const rule of containerRules()) {
      expect(typeof rule.id).toBe('string');
      expect(rule.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(typeof rule.priority).toBe('number');
      expect(typeof rule.defaultEnabled).toBe('boolean');
      expect(rule.descriptionKey.startsWith('ai-focused-editor/typography/')).toBe(true);
      expect(typeof rule.apply).toBe('function');
    }
  });

  test('UR-002 end to end: the generated schema exposes a toggle for each canonical rule', () => {
    // The settings surface the user actually sees, built from the CONTAINER's
    // rule set — the property the whole rules-as-data design exists for.
    const properties = buildTypographySchema(containerRules());
    for (const id of CANONICAL_RULE_IDS) {
      expect(properties[ruleEnabledKey(id)]).toBeDefined();
    }
    expect(Object.keys(properties)).toHaveLength(CANONICAL_RULE_IDS.length + 2);
  });

  test('the module binds a ContributionProvider for TypographyRule', () => {
    const container = new Container();
    container.load(frontendModule.default);
    const provider = container.getNamed<{ getContributions(): readonly Rule[] }>(ContributionProvider, TypographyRule);
    expect(provider.getContributions().map(rule => rule.id).sort()).toEqual([...CANONICAL_RULE_IDS].sort());
  });
});
