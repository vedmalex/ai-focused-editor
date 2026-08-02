import { describe, expect, test } from 'bun:test';
import { DefaultTypographyEngine } from '../typography-engine';
import { LineSnapshot, TypographyContext, TypographyRule } from '../typography-types';
import { paragraphStartCapitalRule } from './paragraph-start-capital';
import { dialogueDashCapitalRule } from './dialogue-dash-capital';
import { fixDoubleCapitalAfterSpaceRule } from './fix-double-capital-after-space';
import { fixDoubleCapitalAfterPunctuationRule } from './fix-double-capital-after-punctuation';

function context(lines: LineSnapshot[], locale = 'ru'): TypographyContext {
  return {
    lines,
    changedRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    cursor: { line: 1, column: 1 },
    locale,
    trigger: 'type'
  };
}

function line(lineNumber: number, text: string): LineSnapshot {
  return { lineNumber, text, tokens: [], isCode: false };
}

function enabledOf(...rules: TypographyRule[]): ReadonlySet<string> {
  return new Set(rules.map(rule => rule.id));
}

describe('contextual-capitalization conflicts', () => {
  test('#31 x #41: a paragraph-start dialogue line is capitalized exactly ONCE', () => {
    const rules = [paragraphStartCapitalRule, dialogueDashCapitalRule];
    const engine = new DefaultTypographyEngine(rules);
    const edits = engine.computeEdits(context([line(1, '— привет.')]), enabledOf(...rules));
    // Both rules propose the identical `п`→`П` edit at column 3; the engine
    // dedupes overlapping edits, so exactly one survives — no double capital.
    expect(edits).toHaveLength(1);
    expect(edits[0].range.start.column).toBe(3);
    expect(edits[0].text).toBe('П');
  });

  test('#31 x #41: dedup is independent of rule registration order (UR-003)', () => {
    const forward = new DefaultTypographyEngine([paragraphStartCapitalRule, dialogueDashCapitalRule]);
    const reverse = new DefaultTypographyEngine([dialogueDashCapitalRule, paragraphStartCapitalRule]);
    const enabled = enabledOf(paragraphStartCapitalRule, dialogueDashCapitalRule);
    const a = forward.computeEdits(context([line(1, '— привет.')]), enabled);
    const b = reverse.computeEdits(context([line(1, '— привет.')]), enabled);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
  });

  test('#42 x #43: a stutter after punctuation dedupes to one lower-casing edit', () => {
    const rules = [fixDoubleCapitalAfterSpaceRule, fixDoubleCapitalAfterPunctuationRule];
    const engine = new DefaultTypographyEngine(rules);
    const edits = engine.computeEdits(context([line(1, 'Привет. КАк дела?')]), enabledOf(...rules));
    expect(edits).toHaveLength(1);
    // Column of the second capital `А` in `КАк` (0-based index 9 → column 10).
    expect(edits[0].range.start.column).toBe(10);
    expect(edits[0].text).toBe('а');
  });
});
