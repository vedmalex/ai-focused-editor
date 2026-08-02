import { describe, expect, test } from 'bun:test';
import { BATCH_MAX_PASSES, TypographyBatchService } from './typography-batch-service';
import { TypographyMonacoAdapter } from './typography-monaco-adapter';
import { DefaultTypographyEngine } from '../../common/typography/typography-engine';
import { collapseMultipleSpacesRule } from '../../common/typography/rules/collapse-multiple-spaces';
import { noSpaceBeforePunctuationRule } from '../../common/typography/rules/no-space-before-punctuation';
import { spaceAfterPunctuationRule } from '../../common/typography/rules/space-after-punctuation';
import { paragraphLeadingHyphenToEmDashRule } from '../../common/typography/rules/paragraph-leading-hyphen-to-em-dash';
import type { TypographyRule } from '../../common/typography/typography-types';

/**
 * Seam-double for the batch contract (TASK-019 W1b §2, UR-006). A MUTABLE fake
 * `ITextModel` backs the document with a line array and applies
 * `pushEditOperations` for real, so the fixpoint loop actually converges and we
 * can assert:
 *   - the whole-document golden result (multiple rules, code lines skipped),
 *   - that the ENTIRE run is ONE discrete undo element (exactly one
 *     `pushStackElement` open + one close, however many internal passes),
 *   - idempotence (a second run makes no edits and pushes no undo element body),
 *   - that a selection range confines edits to its lines.
 */
function fakeModel(initial: string[]): {
  model: any;
  calls: string[];
  lines: () => string[];
} {
  const lines = [...initial];
  const calls: string[] = [];
  const model: any = {
    getLineCount: () => lines.length,
    getLineMaxColumn: (line: number) => (lines[line - 1]?.length ?? 0) + 1,
    getLinesContent: () => [...lines],
    getValue: () => lines.join('\n'),
    pushStackElement: () => calls.push('stack'),
    pushEditOperations: (_before: unknown, operations: Array<{ range: any; text: string }>) => {
      calls.push(`edit:${operations.length}`);
      // Apply single-line operations right-to-left so earlier offsets are stable.
      const sorted = [...operations].sort((a, b) =>
        b.range.startLineNumber - a.range.startLineNumber || b.range.startColumn - a.range.startColumn
      );
      for (const op of sorted) {
        const idx = op.range.startLineNumber - 1;
        const line = lines[idx];
        const start = op.range.startColumn - 1;
        const end = op.range.endColumn - 1;
        lines[idx] = line.slice(0, start) + op.text + line.slice(end);
      }
      return null;
    }
  };
  return { model, calls, lines: () => [...lines] };
}

const DEFAULT_RULES = [
  collapseMultipleSpacesRule,
  noSpaceBeforePunctuationRule,
  spaceAfterPunctuationRule
];

/**
 * The service under test, wired with the REAL engine over `rules` and the REAL
 * adapter. The `ruleProvider` serves the SAME array the engine runs, mirroring
 * the DI wiring — the service reads it only for the rules' declared look-ahead
 * (F-CR2-1), so a provider that disagreed with the engine would build a window
 * for one rule set and run another.
 */
function service(rules: readonly TypographyRule[] = DEFAULT_RULES): TypographyBatchService {
  const svc = new TypographyBatchService();
  (svc as unknown as { engine: unknown }).engine = new DefaultTypographyEngine(rules);
  (svc as unknown as { adapter: unknown }).adapter = new TypographyMonacoAdapter();
  (svc as unknown as { ruleProvider: unknown }).ruleProvider = { getContributions: () => rules };
  return svc;
}

const ALL_IDS: ReadonlySet<string> = new Set([
  collapseMultipleSpacesRule.id,
  noSpaceBeforePunctuationRule.id,
  spaceAfterPunctuationRule.id
]);

describe('TypographyBatchService.applyTo — front matter is never rewritten (ISS-241)', () => {
  const META = [
    'title: привет,мир',
    'type: chapter',
    'updated: 2026-08-01T10:20'
  ];

  test('a whole-buffer batch leaves the front matter byte-identical', () => {
    const { model, lines } = fakeModel([
      '---',
      ...META,
      '---',
      '',
      'иван шёл ,молча'
    ]);
    const result = service().applyTo(model, { enabledIds: ALL_IDS, locale: 'ru' });

    // NOT vacuous: the prose below really was normalised.
    expect(result.applied).toBeGreaterThan(0);
    expect(lines()[6]).toBe('иван шёл, молча');
    // …and every front-matter line came back unchanged, delimiters included.
    expect(lines().slice(0, 5)).toEqual(['---', ...META, '---']);
  });

  test('anti-tautology: the SAME metadata lines ARE rewritten when they are prose', () => {
    // Once the code mask stops protecting them these lines are ordinary prose
    // and the rules rewrite them. The `10:20` clock is the exception: rule #37's
    // structural guards (ISS-240) protect it independently of the mask, so it is
    // asserted unchanged rather than corrupted.
    const { model, lines } = fakeModel(['проза.', '', ...META]);
    service().applyTo(model, { enabledIds: ALL_IDS, locale: 'ru' });

    expect(lines().slice(2)).toEqual([
      'title: привет, мир',
      'type: chapter',
      'updated: 2026-08-01T10:20'
    ]);
  });

  test('a selection confined to front-matter lines writes nothing at all', () => {
    const { model, calls, lines } = fakeModel(['---', ...META, '---', 'проза ,тут']);
    const result = service().applyTo(model, {
      enabledIds: ALL_IDS,
      locale: 'ru',
      startLine: 2,
      endLine: 3
    });

    expect(result.applied).toBe(0);
    expect(calls.filter(c => c.startsWith('edit:'))).toHaveLength(0);
    expect(lines()).toEqual(['---', ...META, '---', 'проза ,тут']);
  });
});

describe('TypographyBatchService.applyTo (whole-document, one undo step)', () => {
  test('golden: whole document is normalised, code fence left intact', () => {
    const { model, lines } = fakeModel([
      'foo  bar ,baz . end',
      '```',
      'let x =  1 ,2',
      '```',
      'second ,line .'
    ]);
    const result = service().applyTo(model, { enabledIds: ALL_IDS, locale: 'en' });

    expect(result.applied).toBeGreaterThan(0);
    expect(lines()).toEqual([
      'foo bar, baz. end',
      '```',
      'let x =  1 ,2',
      '```',
      'second, line.'
    ]);
  });

  test('the whole run is ONE discrete undo element (single open + close)', () => {
    const { model, calls } = fakeModel(['foo  bar ,baz . end']);
    service().applyTo(model, { enabledIds: ALL_IDS, locale: 'en' });

    // First and last calls are the boundary; every write sits strictly inside.
    expect(calls[0]).toBe('stack');
    expect(calls[calls.length - 1]).toBe('stack');
    expect(calls.filter(c => c === 'stack')).toHaveLength(2);
    expect(calls.filter(c => c.startsWith('edit:')).length).toBeGreaterThan(0);
  });

  test('idempotence: a second run makes no edits and writes no undo body', () => {
    const { model, lines } = fakeModel(['foo  bar ,baz . end']);
    const svc = service();
    svc.applyTo(model, { enabledIds: ALL_IDS, locale: 'en' });
    const afterFirst = lines();

    const { model: model2, calls } = fakeModel(afterFirst);
    const result = svc.applyTo(model2, { enabledIds: ALL_IDS, locale: 'en' });

    expect(result.applied).toBe(0);
    // Only the (empty) boundary; no pushEditOperations at all.
    expect(calls.filter(c => c.startsWith('edit:'))).toHaveLength(0);
  });

  test('an empty enabled set is a no-op (no undo boundary)', () => {
    const { model, calls, lines } = fakeModel(['foo  bar ,baz']);
    const result = service().applyTo(model, { enabledIds: new Set(), locale: 'en' });
    expect(result.applied).toBe(0);
    expect(calls).toEqual([]);
    expect(lines()).toEqual(['foo  bar ,baz']);
  });

  test('runOnText: multi-file text driver uses the injected engine (whole-doc golden)', () => {
    const result = service().runOnText('foo  bar ,baz . end', { enabledIds: ALL_IDS, locale: 'en' });
    expect(result.editCount).toBeGreaterThan(0);
    expect(result.text).toBe('foo bar, baz. end');
  });

  test('runOnText: an empty enabled set is a no-op', () => {
    const result = service().runOnText('foo  bar', { enabledIds: new Set(), locale: 'en' });
    expect(result.editCount).toBe(0);
    expect(result.text).toBe('foo  bar');
  });

  test('selection: only lines within the range are touched', () => {
    const { model, lines } = fakeModel([
      'first ,line .',
      'second ,line .',
      'third ,line .'
    ]);
    // Restrict to line 2 only.
    const result = service().applyTo(model, {
      enabledIds: ALL_IDS,
      locale: 'en',
      startLine: 2,
      endLine: 2
    });

    expect(result.applied).toBeGreaterThan(0);
    expect(lines()).toEqual([
      'first ,line .',
      'second, line.',
      'third ,line .'
    ]);
  });
});

describe('TypographyBatchService.applyTo — an unfinished run is OBSERVABLE (ISS-259)', () => {
  /**
   * The open-buffer path used to return only an edit COUNT, so a run that ran out
   * of passes with fixes still pending was indistinguishable from one that
   * reached a fixpoint — the command reported "applied N fix(es)" either way.
   * That is the same silence already rejected for the multi-file path (ISS-255),
   * and it is only detectable through the `passes`/`converged` pair.
   *
   * A NON-CONVERGING engine is the only way to reach the pass ceiling, since
   * every real rule is idempotent. `alwaysEdits` inserts one character per pass
   * forever — the exact rule-authoring bug BATCH_MAX_PASSES exists to contain.
   */
  function serviceWithEngine(engine: unknown, adapter?: unknown): TypographyBatchService {
    const svc = new TypographyBatchService();
    (svc as unknown as { engine: unknown }).engine = engine;
    (svc as unknown as { adapter: unknown }).adapter = adapter ?? new TypographyMonacoAdapter();
    // No rules bound: the look-ahead aggregate is 0 and the window keeps its
    // historical end, which is what these convergence cases assume.
    (svc as unknown as { ruleProvider: unknown }).ruleProvider = { getContributions: () => [] };
    return svc;
  }

  /** An engine that never reaches a fixpoint: every pass inserts one more 'x'. */
  const alwaysEdits = {
    computeEdits: () => [{
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      text: 'x'
    }]
  };

  test('CRITICAL: hitting the pass ceiling reports converged:false, not a clean success', () => {
    const { model, lines } = fakeModel(['prose']);

    const result = serviceWithEngine(alwaysEdits).applyTo(model, {
      enabledIds: new Set(['whatever']),
      locale: 'ru'
    });

    // The run really did work and really did stop at the budget…
    expect(result.applied).toBe(BATCH_MAX_PASSES);
    expect(result.passes).toBe(BATCH_MAX_PASSES);
    expect(lines()[0]).toBe('x'.repeat(BATCH_MAX_PASSES) + 'prose');
    // …and says so. Reporting `applied` alone would look like a healthy run.
    expect(result.converged).toBe(false);
  });

  test('ANTI-TAUTOLOGY: a real, idempotent rule set converges well inside the budget', () => {
    const { model } = fakeModel(['foo  bar ,baz . end']);

    const result = service().applyTo(model, { enabledIds: ALL_IDS, locale: 'en' });

    expect(result.converged).toBe(true);
    expect(result.applied).toBeGreaterThan(0);
    expect(result.passes).toBeGreaterThan(0);
    expect(result.passes).toBeLessThan(BATCH_MAX_PASSES);
  });

  test('a model that REFUSES the write is unfinished, not converged', () => {
    // `applyEditsWithoutBoundary` returning false means computed fixes were
    // dropped on the floor. Zero edits landed, but there IS outstanding work —
    // so this must not be reported as "nothing to fix".
    const refusingAdapter = { buildContext: () => ({}), applyEditsWithoutBoundary: () => false };
    const { model, lines } = fakeModel(['prose']);

    const result = serviceWithEngine(alwaysEdits, refusingAdapter).applyTo(model, {
      enabledIds: new Set(['whatever']),
      locale: 'ru'
    });

    expect(result.applied).toBe(0);
    expect(result.converged).toBe(false);
    expect(lines()).toEqual(['prose']);
  });

  test('nothing-to-do outcomes are CONVERGED (no spurious warning for the user)', () => {
    const { model } = fakeModel(['prose']);
    const svc = service();

    // No enabled rules at all…
    expect(svc.applyTo(model, { enabledIds: new Set(), locale: 'en' }).converged).toBe(true);
    // …and a selection that starts past the end of the document.
    expect(svc.applyTo(model, { enabledIds: ALL_IDS, locale: 'en', startLine: 99 }).converged).toBe(true);
  });
});

describe('TypographyBatchService.applyTo — declared look-ahead, with the selection still the write surface (F-CR2-1)', () => {
  const HYPHEN_RULE_ONLY = [paragraphLeadingHyphenToEmDashRule];
  const HYPHEN_ID: ReadonlySet<string> = new Set([paragraphLeadingHyphenToEmDashRule.id]);

  test('CRITICAL: a selection ENDING on a list item does not convert it into an em dash', () => {
    // The batch twin of the live defect. The window used to stop at `endLine`,
    // so the last selected line never saw the bullet continuing below it and
    // #40 converted it — breaking the list. The documented "zero look-back costs
    // a MISSED fix, never a wrong one" argument does not transfer to the forward
    // direction: an unseen successor makes this rule WRONG, not silent.
    const { model, lines } = fakeModel([
      'Обычная проза.',
      '- пункт',
      '- существующий',
      '- ещё один'
    ]);

    const result = service(HYPHEN_RULE_ONLY).applyTo(model, {
      enabledIds: HYPHEN_ID,
      locale: 'ru',
      startLine: 1,
      endLine: 2
    });

    expect(result.applied).toBe(0);
    expect(result.converged).toBe(true);
    expect(lines()).toEqual(['Обычная проза.', '- пункт', '- существующий', '- ещё один']);
  });

  test('ANTI-TAUTOLOGY: the same selection over a LONE dialogue line still converts it', () => {
    // Guards against passing the case above by simply never editing the last
    // selected line.
    const { model, lines } = fakeModel(['Обычная проза.', '- Привет.', '', 'Дальше.']);

    const result = service(HYPHEN_RULE_ONLY).applyTo(model, {
      enabledIds: HYPHEN_ID,
      locale: 'ru',
      startLine: 1,
      endLine: 2
    });

    expect(result.applied).toBe(1);
    expect(lines()[1]).toBe('— Привет.');
  });

  test('CRITICAL: the look-ahead line is CONTEXT — a selection never writes outside itself', () => {
    // The ISS-272 guarantee under the widened window: line 3 is a convertible
    // dialogue line that the widened snapshot now exposes, and the run must
    // still leave it byte-identical because it is outside the selection.
    const { model, lines } = fakeModel(['Обычная проза.', 'Ещё проза.', '- Привет.', '']);

    const result = service(HYPHEN_RULE_ONLY).applyTo(model, {
      enabledIds: HYPHEN_ID,
      locale: 'ru',
      startLine: 1,
      endLine: 2
    });

    expect(result.applied).toBe(0);
    expect(result.converged).toBe(true);
    expect(lines()[2]).toBe('- Привет.');
  });

  test('a run past the END of the document does not break on the phantom look-ahead line', () => {
    // `windowEnd` is `endLine + lookahead` unconditionally, so a whole-file run
    // always asks for one line that does not exist. The adapter clamps it.
    const { model, lines } = fakeModel(['Обычная проза.', '- Привет.']);

    const result = service(HYPHEN_RULE_ONLY).applyTo(model, { enabledIds: HYPHEN_ID, locale: 'ru' });

    expect(result.converged).toBe(true);
    expect(lines()[1]).toBe('— Привет.');
  });
});
