import { describe, expect, test } from 'bun:test';
import {
  ALL_TYPOGRAPHY_RULE_IDS,
  TYPOGRAPHY_RULES,
  resolveRequiredLookahead,
  resolveRequiredLookback
} from './typography-rules';
import {
  PRIORITY_BANDS,
  PRIORITY_CAPITALIZATION_START,
  priorityBandOf
} from './typography-priority';
import type { TypographyRule } from './typography-types';

/**
 * Registry-level invariants for the typography ENGINE (the DA CODE_REVIEW
 * findings F-CR-1, F-CR-4 and F-CR-5).
 *
 * These are all cheap, and they exist for one reason: adding the 15th rule must
 * be a loud act. Every check here is one that used to be carried by PROSE in a
 * JSDoc comment — a rule's stated priority band, a rule's stated need for
 * look-back context, the completeness of the rule list itself — where nothing
 * could observe it going wrong.
 *
 * This file lives in the NODE lane (`test:packages`) on purpose. The registry
 * used to sit in `browser/typography/typography-frontend-module.ts`, which pulls
 * in monaco and `@theia/core/lib/browser`, so no Node-lane suite could see it.
 */

/**
 * The canonical rule inventory of TASK-019 §3 — "ВСЕ 14 id ОКОНЧАТЕЛЬНЫ и
 * ФИКСИРОВАНЫ навсегда". Transcribed from the tech spec ON PURPOSE rather than
 * derived from any product module: a list computed from the code under test
 * would agree with it by construction and prove nothing.
 *
 * (`typography-frontend-module.test.ts` pins the same set against real DI
 * resolution; this is the NODE-lane counterpart, and it is what makes the
 * whole-document/front-matter suites in `text-runner.test.ts` — which now import
 * the registry directly — a statement about the COMPLETE shipped rule set rather
 * than about whatever the array happens to contain.)
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

describe('TYPOGRAPHY_RULES — the canonical registry is complete (F-CR-1)', () => {
  test('the registry holds EXACTLY the canonical §3 id set', () => {
    // Exact set in BOTH directions, not a `toContain` sample: these ids are
    // PERSISTED preference keys, so an addition and a removal are both events
    // that must be seen.
    expect([...TYPOGRAPHY_RULES.map(rule => rule.id)].sort()).toEqual([...CANONICAL_RULE_IDS].sort());
  });

  test('no id is registered twice (a duplicate silently shadows in the engine map)', () => {
    const ids = TYPOGRAPHY_RULES.map(rule => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('ALL_TYPOGRAPHY_RULE_IDS is derived from the registry, not a second copy', () => {
    // The "run every rule" suites use this set; if it could drift from the
    // registry it would reintroduce exactly the hand-maintained copy F-CR-1
    // removed.
    expect([...ALL_TYPOGRAPHY_RULE_IDS].sort()).toEqual([...TYPOGRAPHY_RULES.map(rule => rule.id)].sort());
  });

  test('every registered rule is well-formed data (id/priority/nls key/apply)', () => {
    for (const rule of TYPOGRAPHY_RULES) {
      expect(rule.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(typeof rule.priority).toBe('number');
      expect(typeof rule.defaultEnabled).toBe('boolean');
      expect(rule.descriptionKey.startsWith('ai-focused-editor/typography/')).toBe(true);
      expect(typeof rule.apply).toBe('function');
    }
  });
});

describe('priority bands — every rule sits in a DECLARED band (F-CR-5)', () => {
  test('CRITICAL: each registered rule uses a declared band step, never a loose number', () => {
    // The engine resolves overlapping edits by priority, so an out-of-band
    // number means a rule silently evicts another rule's fix. Per-rule suites
    // call `apply()` directly and never see that, which is why this check is at
    // registry level.
    // Collected rather than asserted per-rule so a failure names EVERY offender
    // and its number, instead of stopping at the first one.
    const offenders = TYPOGRAPHY_RULES
      .filter(rule => priorityBandOf(rule.priority) === undefined)
      .map(rule => `${rule.id} (priority ${rule.priority})`);
    expect(offenders).toEqual([]);
  });

  test('ANTI-TAUTOLOGY: a priority outside every band is rejected', () => {
    // Proves the check above is carried by the band table and not by
    // `priorityBandOf` accepting anything it is handed.
    expect(priorityBandOf(60)).toBeUndefined();
    expect(priorityBandOf(0)).toBeUndefined();
    // …and an in-RANGE but undeclared step is rejected too: membership is by
    // exact step, not by `min <= p <= max`. `33` sits inside the dashes-quotes
    // band's 30–40 range and is still not a legal priority.
    expect(priorityBandOf(33)).toBeUndefined();
  });

  test('the band table itself is coherent: steps in range, bands disjoint', () => {
    for (const band of PRIORITY_BANDS) {
      for (const step of band.steps) {
        expect(step).toBeGreaterThanOrEqual(band.min);
        expect(step).toBeLessThanOrEqual(band.max);
      }
    }
    for (const a of PRIORITY_BANDS) {
      for (const b of PRIORITY_BANDS) {
        if (a === b) {
          continue;
        }
        expect(a.max < b.min || b.max < a.min).toBe(true);
      }
    }
  });

  test('the bands really do order the rule set: spacing < dashes/quotes < capitalization', () => {
    // Not vacuous: each band is actually POPULATED by the shipped registry, so
    // the ordering above is a statement about real rules.
    const byBand = new Map<string, string[]>();
    for (const rule of TYPOGRAPHY_RULES) {
      const name = priorityBandOf(rule.priority)?.name ?? 'unbanded';
      byBand.set(name, [...(byBand.get(name) ?? []), rule.id]);
    }
    expect([...byBand.keys()].sort()).toEqual(['capitalization', 'dashes-quotes', 'spacing']);
    for (const ids of byBand.values()) {
      expect(ids.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveRequiredLookback — a rule declares the context it needs (F-CR-4)', () => {
  /** A probe rule that declares an arbitrary look-back need. */
  function probe(id: string, requiredLookbackLines?: number): TypographyRule {
    return {
      id,
      descriptionKey: `ai-focused-editor/typography/${id}-desc`,
      defaultEnabled: true,
      priority: PRIORITY_CAPITALIZATION_START,
      requiredLookbackLines,
      apply: () => null
    };
  }

  test('CRITICAL: paragraph-start-capital DECLARES the look-back its guard depends on', () => {
    // The rule's own `isParagraphStart` is conservative: with no visible
    // predecessor it emits nothing. So a window built without look-back does not
    // fail loudly — the rule just silently stops firing at every paragraph
    // start. This assertion is what makes that dependency observable at all.
    const rule = TYPOGRAPHY_RULES.find(candidate => candidate.id === 'paragraph-start-capital');
    expect(rule?.requiredLookbackLines).toBeGreaterThanOrEqual(1);
    expect(resolveRequiredLookback(TYPOGRAPHY_RULES, new Set(['paragraph-start-capital']))).toBeGreaterThanOrEqual(1);
  });

  test('CRITICAL: paragraph-leading-hyphen-to-em-dash declares it too (it reads the line above)', () => {
    const rule = TYPOGRAPHY_RULES.find(c => c.id === 'paragraph-leading-hyphen-to-em-dash');
    expect(rule?.requiredLookbackLines).toBeGreaterThanOrEqual(1);
  });

  test('every rule that declares a look-back declares a sane positive integer', () => {
    for (const rule of TYPOGRAPHY_RULES) {
      if (rule.requiredLookbackLines === undefined) {
        continue;
      }
      expect(Number.isInteger(rule.requiredLookbackLines)).toBe(true);
      expect(rule.requiredLookbackLines).toBeGreaterThan(0);
    }
  });

  test('the aggregate is the MAXIMUM over enabled rules', () => {
    const rules = [probe('a', 1), probe('b', 4), probe('c', 2)];
    expect(resolveRequiredLookback(rules, new Set(['a', 'b', 'c']))).toBe(4);
  });

  test('a DISABLED context-hungry rule costs nothing', () => {
    // Aggregating over the whole registry instead of the enabled set would make
    // every user pay for a rule they switched off.
    const rules = [probe('a', 1), probe('expensive', 9)];
    expect(resolveRequiredLookback(rules, new Set(['a']))).toBe(1);
  });

  test('rules that declare nothing aggregate to 0 (the seam then uses its baseline)', () => {
    expect(resolveRequiredLookback([probe('a'), probe('b')], new Set(['a', 'b']))).toBe(0);
    expect(resolveRequiredLookback(TYPOGRAPHY_RULES, new Set())).toBe(0);
  });

  test('an id in the enabled set that matches no rule is ignored, not counted', () => {
    expect(resolveRequiredLookback([probe('a', 3)], new Set(['a', 'ghost']))).toBe(3);
  });
});

describe('resolveRequiredLookahead — a rule declares the FORWARD context it needs (F-CR2-1)', () => {
  /** A probe rule that declares an arbitrary look-ahead need. */
  function probe(id: string, requiredLookaheadLines?: number): TypographyRule {
    return {
      id,
      descriptionKey: `ai-focused-editor/typography/${id}-desc`,
      defaultEnabled: true,
      priority: PRIORITY_CAPITALIZATION_START,
      requiredLookaheadLines,
      apply: () => null
    };
  }

  test('CRITICAL: paragraph-leading-hyphen-to-em-dash DECLARES the successor line it reads', () => {
    // The forward half of this rule's neighbour guard (`ctx.lines[idx + 1]` is a
    // list item ⇒ leave the hyphen alone) was DEAD in the live seam: the window
    // ended at the changed line, so the successor was never in `ctx.lines` and
    // `- пункт` typed above an existing list was converted anyway, breaking the
    // list. Unlike a missing look-BACK, a missing look-AHEAD does not make the
    // rule silent — it makes it WRONG.
    const rule = TYPOGRAPHY_RULES.find(c => c.id === 'paragraph-leading-hyphen-to-em-dash');
    expect(rule?.requiredLookaheadLines).toBeGreaterThanOrEqual(1);
    expect(
      resolveRequiredLookahead(TYPOGRAPHY_RULES, new Set(['paragraph-leading-hyphen-to-em-dash']))
    ).toBeGreaterThanOrEqual(1);
  });

  test('CRITICAL: it is the ONLY rule that declares one — no rule pays for context it does not read', () => {
    // Audited rule by rule against `ctx.lines[idx + N]` / successor-line reads:
    // every other rule in the registry iterates `for (const line of ctx.lines)`
    // and is strictly line-local (their `text[i + 1]` reads are WITHIN a line).
    // Over-declaring is not free — it widens the snapshot on every keystroke —
    // so this pins the audit rather than leaving it in a commit message.
    const declaring = TYPOGRAPHY_RULES
      .filter(rule => (rule.requiredLookaheadLines ?? 0) > 0)
      .map(rule => rule.id);
    expect(declaring).toEqual(['paragraph-leading-hyphen-to-em-dash']);
  });

  test('every rule that declares a look-ahead declares a sane positive integer', () => {
    for (const rule of TYPOGRAPHY_RULES) {
      if (rule.requiredLookaheadLines === undefined) {
        continue;
      }
      expect(Number.isInteger(rule.requiredLookaheadLines)).toBe(true);
      expect(rule.requiredLookaheadLines).toBeGreaterThan(0);
    }
  });

  test('the aggregate is the MAXIMUM over enabled rules, order-independently', () => {
    const rules = [probe('a', 1), probe('b', 4), probe('c', 2)];
    expect(resolveRequiredLookahead(rules, new Set(['a', 'b', 'c']))).toBe(4);
    expect(resolveRequiredLookahead([...rules].reverse(), new Set(['a', 'b', 'c']))).toBe(4);
  });

  test('a DISABLED look-ahead rule costs nothing', () => {
    expect(resolveRequiredLookahead([probe('a', 1), probe('expensive', 9)], new Set(['a']))).toBe(1);
  });

  test('rules that declare nothing aggregate to 0 — the forward window has NO baseline', () => {
    // Deliberately unlike look-back: the historical forward window was exactly
    // zero, so 0 here must mean "end the window where it always ended".
    expect(resolveRequiredLookahead([probe('a'), probe('b')], new Set(['a', 'b']))).toBe(0);
    expect(resolveRequiredLookahead(TYPOGRAPHY_RULES, new Set())).toBe(0);
  });

  test('the two directions are INDEPENDENT: a look-back declaration does not grant look-ahead', () => {
    // Anti-tautology for the shared `resolveMax` helper — a copy-paste that read
    // the wrong field would otherwise pass every test above.
    const backOnly: TypographyRule = {
      id: 'back-only',
      descriptionKey: 'ai-focused-editor/typography/back-only-desc',
      defaultEnabled: true,
      priority: PRIORITY_CAPITALIZATION_START,
      requiredLookbackLines: 7,
      apply: () => null
    };
    expect(resolveRequiredLookahead([backOnly], new Set(['back-only']))).toBe(0);
    expect(resolveRequiredLookback([probe('ahead-only', 7)], new Set(['ahead-only']))).toBe(0);
  });

  test('an id in the enabled set that matches no rule is ignored, not counted', () => {
    expect(resolveRequiredLookahead([probe('a', 3)], new Set(['a', 'ghost']))).toBe(3);
  });
});
