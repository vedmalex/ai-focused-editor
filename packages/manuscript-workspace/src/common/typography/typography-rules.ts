/**
 * THE canonical rule registry of the shipped product (TASK-019 §3): every rule
 * the application binds, in one enumerable place, as PURE DATA.
 *
 * WHY IT LIVES IN `common/` (F-CR-1): this array used to be declared inside
 * `browser/typography/typography-frontend-module.ts`. That module imports
 * `@theia/core/lib/browser` and monaco, so the Node test lane could not import it
 * — and `text-runner.test.ts` therefore kept a HAND-MAINTAINED second copy of the
 * rule list. Nothing checked that copy for completeness, yet the whole-document
 * golden test and the anti-ISS-241 "front matter is never rewritten" band both
 * ran against it. A 15th rule added to the real registry and forgotten in the
 * copy would have left every one of those tests green while running against 14
 * rules — and ISS-241 was a MASK defect, so any rule could be the one that
 * corrupts metadata.
 *
 * All 14 rule modules are DOM-free data, so nothing forced the registry to sit
 * behind the browser boundary in the first place.
 *
 * HARD CONSTRAINT — this module MUST stay DOM/Monaco/Theia-browser free. It is
 * imported by the Node test lane (`test:packages`) and by the pure text/batch
 * drivers; a single `@theia/core/lib/browser` or `@theia/monaco-editor-core`
 * import anywhere in its transitive graph breaks that lane. Do not "just import"
 * a browser type here — the fix belongs on the browser side of the seam.
 *
 * The frontend module now imports this array and does nothing but `bind` a loop
 * over it, so the DI bindings and this registry CANNOT drift: a rule dropped here
 * is a rule the container no longer serves, which
 * `typography-frontend-module.test.ts` pins against the canonical §3 id set.
 */

import { TypographyRule } from './typography-types';
import { collapseMultipleSpacesRule } from './rules/collapse-multiple-spaces';
import { noSpaceBeforePunctuationRule } from './rules/no-space-before-punctuation';
import { spaceAfterPunctuationRule } from './rules/space-after-punctuation';
import { spacedHyphenToEmDashRule } from './rules/spaced-hyphen-to-em-dash';
import { paragraphLeadingHyphenToEmDashRule } from './rules/paragraph-leading-hyphen-to-em-dash';
import { normalizeWordHyphenationRule } from './rules/normalize-word-hyphenation';
import { periodAfterDoubleSpaceRule } from './rules/period-after-double-space';
import { openingQuoteToGuillemetRule } from './rules/opening-quote-to-guillemet';
import { closingQuoteToGuillemetRule } from './rules/closing-quote-to-guillemet';
import { paragraphStartCapitalRule } from './rules/paragraph-start-capital';
import { sentenceStartCapitalRule } from './rules/sentence-start-capital';
import { dialogueDashCapitalRule } from './rules/dialogue-dash-capital';
import { fixDoubleCapitalAfterSpaceRule } from './rules/fix-double-capital-after-space';
import { fixDoubleCapitalAfterPunctuationRule } from './rules/fix-double-capital-after-punctuation';

export const TYPOGRAPHY_RULES: readonly TypographyRule[] = [
  // W1 (#38/#36/#37).
  collapseMultipleSpacesRule,
  noSpaceBeforePunctuationRule,
  spaceAfterPunctuationRule,
  // W2 local rules (#32/#40/#33/#44/#34/#35).
  spacedHyphenToEmDashRule,
  paragraphLeadingHyphenToEmDashRule,
  normalizeWordHyphenationRule,
  periodAfterDoubleSpaceRule,
  openingQuoteToGuillemetRule,
  closingQuoteToGuillemetRule,
  // W3 contextual capitalization rules (#31/#39/#41/#42/#43).
  paragraphStartCapitalRule,
  sentenceStartCapitalRule,
  dialogueDashCapitalRule,
  fixDoubleCapitalAfterSpaceRule,
  fixDoubleCapitalAfterPunctuationRule
];

/** Every rule id in the canonical registry — the default "all rules on" set. */
export const ALL_TYPOGRAPHY_RULE_IDS: ReadonlySet<string> = new Set(
  TYPOGRAPHY_RULES.map(rule => rule.id)
);

/**
 * The look-back the CONTEXT WINDOW must carry for `enabledIds`, aggregated as the
 * MAXIMUM `requiredLookbackLines` any enabled rule declares (F-CR-4).
 *
 * Before this existed, the window size was a private constant in the browser
 * seam (`CONTEXT_LOOKBACK_LINES`) and a rule's dependency on it was documented in
 * PROSE only: `paragraph-start-capital` states it needs the predecessor line, but
 * lowering the seam constant to 0 would not have turned anything red — the rule
 * would just silently stop firing on the first line of every paragraph, because
 * its own look-back guard is (correctly) conservative and does nothing when the
 * predecessor is not visible.
 *
 * Now a rule DECLARES its need as data and the seam asks for the aggregate, so
 * the two can no longer disagree. Rules that declare nothing contribute 0; the
 * seam still applies its own baseline floor on top (see
 * `CONTEXT_LOOKBACK_LINES`), so this function returning 0 means "no rule needs
 * more than the baseline", never "snapshot no context at all".
 */
export function resolveRequiredLookback(
  rules: readonly TypographyRule[],
  enabledIds: ReadonlySet<string>
): number {
  return resolveMax(rules, enabledIds, rule => rule.requiredLookbackLines);
}

/**
 * The look-AHEAD the CONTEXT WINDOW must carry for `enabledIds`, aggregated as
 * the MAXIMUM `requiredLookaheadLines` any enabled rule declares (F-CR2-1).
 *
 * The mirror of {@link resolveRequiredLookback}, added because the contract was
 * one-directional while a shipped rule was not.
 * `paragraph-leading-hyphen-to-em-dash` inspects the line BELOW as well as the
 * line above, but the live seam capped its window at `changedRange.end.line`, so
 * the forward neighbour was never in the snapshot and the guard's forward half
 * could not fire. Typing `- пункт` above an existing list therefore converted a
 * bullet into an em dash — the one thing GitHub #40 forbids.
 *
 * NO BASELINE FLOOR, unlike look-back. The historical forward window was exactly
 * ZERO, so anything a driver adds here is new context; adding a floor would
 * silently widen every rule's view for no declared reason. Rules that declare
 * nothing contribute 0 and the window keeps its historical end.
 *
 * The widened lines are CONTEXT ONLY: drivers must pass the computed edits
 * through `dropEditsBeyondLine` so the set of lines a pass may WRITE is exactly
 * what it was before the widening (see the note on
 * {@link TypographyRule.requiredLookaheadLines}).
 */
export function resolveRequiredLookahead(
  rules: readonly TypographyRule[],
  enabledIds: ReadonlySet<string>
): number {
  return resolveMax(rules, enabledIds, rule => rule.requiredLookaheadLines);
}

/** Maximum of `select` over the ENABLED rules; absent declarations count as 0. */
function resolveMax(
  rules: readonly TypographyRule[],
  enabledIds: ReadonlySet<string>,
  select: (rule: TypographyRule) => number | undefined
): number {
  let required = 0;
  for (const rule of rules) {
    if (!enabledIds.has(rule.id)) {
      continue;
    }
    const declared = select(rule) ?? 0;
    if (declared > required) {
      required = declared;
    }
  }
  return required;
}
