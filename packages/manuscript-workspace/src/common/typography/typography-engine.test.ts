import { describe, expect, test } from 'bun:test';
import { DefaultTypographyEngine, dropEditsBeyondLine } from './typography-engine';
import {
  LineSnapshot,
  TokenKind,
  TypographyContext,
  TypographyEdit,
  TypographyRule
} from './typography-types';

/** Build a single-line prose context (optionally marking the line as code or with tokens). */
function proseContext(text: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): TypographyContext {
  const line: LineSnapshot = {
    lineNumber: 1,
    text,
    tokens: opts.tokens ?? [],
    isCode: opts.isCode ?? false
  };
  return {
    lines: [line],
    changedRange: { start: { line: 1, column: 1 }, end: { line: 1, column: text.length + 1 } },
    cursor: { line: 1, column: 1 },
    locale: 'en',
    trigger: 'type'
  };
}

/** A rule that always proposes one fixed edit over a given column span. */
function fixedRule(id: string, priority: number, startCol: number, endCol: number, replacement: string): TypographyRule {
  return {
    id,
    descriptionKey: `desc/${id}`,
    defaultEnabled: true,
    priority,
    apply(): TypographyEdit[] {
      return [{
        ruleId: id,
        range: { start: { line: 1, column: startCol }, end: { line: 1, column: endCol } },
        text: replacement
      }];
    }
  };
}

describe('DefaultTypographyEngine.computeEdits', () => {
  test('runs only enabled rules (per-rule toggle filter)', () => {
    const engine = new DefaultTypographyEngine([
      fixedRule('a', 10, 1, 2, 'A'),
      fixedRule('b', 10, 3, 4, 'B')
    ]);
    const edits = engine.computeEdits(proseContext('xxxx'), new Set(['a']));
    expect(edits).toHaveLength(1);
    expect(edits[0].ruleId).toBe('a');
  });

  test('overlapping edits: higher priority wins, the intersecting loser is dropped', () => {
    const low = fixedRule('low', 10, 1, 5, 'LOW');
    const high = fixedRule('high', 40, 2, 4, 'HI');
    const engine = new DefaultTypographyEngine([low, high]);
    const edits = engine.computeEdits(proseContext('aaaaaa'), new Set(['low', 'high']));
    expect(edits).toHaveLength(1);
    expect(edits[0].ruleId).toBe('high');
  });

  test('equal priority: lexicographically smaller id wins the conflict (not registration order)', () => {
    const zeta = fixedRule('zeta', 20, 1, 4, 'Z');
    const alpha = fixedRule('alpha', 20, 2, 5, 'A');
    const engine = new DefaultTypographyEngine([zeta, alpha]);
    const edits = engine.computeEdits(proseContext('aaaaaa'), new Set(['zeta', 'alpha']));
    expect(edits).toHaveLength(1);
    expect(edits[0].ruleId).toBe('alpha');
  });

  test('determinism: output is identical regardless of rule registration order', () => {
    const r1 = fixedRule('alpha', 20, 2, 5, 'A');
    const r2 = fixedRule('zeta', 20, 1, 4, 'Z');
    const r3 = fixedRule('mid', 50, 6, 8, 'M');
    const ids = new Set(['alpha', 'zeta', 'mid']);
    const forward = new DefaultTypographyEngine([r1, r2, r3]).computeEdits(proseContext('aaaaaaaa'), ids);
    const reversed = new DefaultTypographyEngine([r3, r2, r1]).computeEdits(proseContext('aaaaaaaa'), ids);
    expect(forward).toEqual(reversed);
  });

  test('non-overlapping edits from different rules all survive, ordered by document position', () => {
    const engine = new DefaultTypographyEngine([
      fixedRule('right', 10, 5, 7, 'R'),
      fixedRule('left', 10, 1, 3, 'L')
    ]);
    const edits = engine.computeEdits(proseContext('aaaaaaa'), new Set(['left', 'right']));
    expect(edits.map(edit => edit.ruleId)).toEqual(['left', 'right']);
    expect(edits[0].range.start.column).toBe(1);
    expect(edits[1].range.start.column).toBe(5);
  });

  test('edits landing on a code line are dropped by the engine (defence in depth)', () => {
    const engine = new DefaultTypographyEngine([fixedRule('a', 10, 1, 3, 'A')]);
    const edits = engine.computeEdits(proseContext('  code', { isCode: true }), new Set(['a']));
    expect(edits).toHaveLength(0);
  });

  test('edits landing inside an inline-code token are dropped', () => {
    const tokens = [{ startColumn: 2, endColumn: 6, kind: TokenKind.InlineCode }];
    const engine = new DefaultTypographyEngine([fixedRule('a', 10, 3, 5, 'A')]);
    const edits = engine.computeEdits(proseContext('a`bc`d', { tokens }), new Set(['a']));
    expect(edits).toHaveLength(0);
  });

  test('a disabled but registered rule contributes nothing', () => {
    const engine = new DefaultTypographyEngine([fixedRule('a', 10, 1, 3, 'A')]);
    expect(engine.computeEdits(proseContext('aaaa'), new Set())).toHaveLength(0);
  });
});

describe('dropEditsBeyondLine — look-ahead widens CONTEXT, never the write surface (F-CR2-1)', () => {
  function editOn(line: number, ruleId = 'r'): TypographyEdit {
    return {
      ruleId,
      range: { start: { line, column: 1 }, end: { line, column: 2 } },
      text: '—'
    };
  }

  test('CRITICAL: an edit past the last editable line is dropped', () => {
    // The whole point: a driver may snapshot line 11 so a guard can READ it, but
    // a rule must not be able to rewrite it just because it became visible.
    const kept = dropEditsBeyondLine([editOn(10), editOn(11)], 10);
    expect(kept.map(e => e.range.start.line)).toEqual([10]);
  });

  test('the boundary line itself is INCLUSIVE — the changed line stays editable', () => {
    expect(dropEditsBeyondLine([editOn(10)], 10)).toHaveLength(1);
  });

  test('LOOK-BACK lines are deliberately untouched: only the forward end is clamped', () => {
    // Lines above the changed range have always been editable (that coupling is
    // ISS-272's subject, not this fix's). Clamping them here would smuggle a
    // behaviour change in under a bug fix.
    expect(dropEditsBeyondLine([editOn(1), editOn(5), editOn(10)], 10)).toHaveLength(3);
  });

  test('an edit whose range STRADDLES the boundary is dropped, not truncated', () => {
    const straddling: TypographyEdit = {
      ruleId: 'r',
      range: { start: { line: 10, column: 1 }, end: { line: 11, column: 2 } },
      text: 'x'
    };
    expect(dropEditsBeyondLine([straddling], 10)).toHaveLength(0);
  });

  test('ANTI-TAUTOLOGY: with a boundary below every edit, nothing survives', () => {
    // Proves the filter is carried by the comparison and not by the input
    // happening to be in range in the cases above.
    expect(dropEditsBeyondLine([editOn(1), editOn(2)], 0)).toHaveLength(0);
  });

  test('the input array is not mutated (pure)', () => {
    const input = [editOn(10), editOn(11)];
    dropEditsBeyondLine(input, 10);
    expect(input).toHaveLength(2);
  });
});
