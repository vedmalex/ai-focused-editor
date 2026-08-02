import { describe, expect, test } from 'bun:test';
import { dialogueDashCapitalRule } from './dialogue-dash-capital';
import {
  LineSnapshot,
  TypographyContext,
  TypographyEdit
} from '../typography-types';

function context(lines: LineSnapshot[], locale = 'ru'): TypographyContext {
  return {
    lines,
    changedRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    cursor: { line: 1, column: 1 },
    locale,
    trigger: 'type'
  };
}

function line(lineNumber: number, text: string, opts: { isCode?: boolean } = {}): LineSnapshot {
  return { lineNumber, text, tokens: [], isCode: opts.isCode ?? false };
}

function applyCol(text: string, edits: TypographyEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.range.start.column - a.range.start.column);
  let result = text;
  for (const edit of sorted) {
    result = result.slice(0, edit.range.start.column - 1) + edit.text + result.slice(edit.range.end.column - 1);
  }
  return result;
}

describe('dialogueDashCapitalRule (#41)', () => {
  test('metadata is stable, on by default, locale-aware', () => {
    expect(dialogueDashCapitalRule.id).toBe('dialogue-dash-capital');
    expect(dialogueDashCapitalRule.priority).toBe(50);
    expect(dialogueDashCapitalRule.defaultEnabled).toBe(true);
    expect(dialogueDashCapitalRule.localeAware).toBe(true);
  });

  test('golden: capitalize after an em dash', () => {
    expect(applyCol('— привет.', dialogueDashCapitalRule.apply(context([line(1, '— привет.')])) ?? [])).toBe('— Привет.');
  });

  test('golden: capitalize after a question-ending dialogue line', () => {
    expect(applyCol('— когда ты вернёшься?', dialogueDashCapitalRule.apply(context([line(1, '— когда ты вернёшься?')])) ?? []))
      .toBe('— Когда ты вернёшься?');
  });

  test('golden: capitalize after a plain leading hyphen too (pre-#40 conversion)', () => {
    expect(applyCol('- привет.', dialogueDashCapitalRule.apply(context([line(1, '- привет.')])) ?? [])).toBe('- Привет.');
  });

  test('golden: fires even when the line is not a paragraph start', () => {
    const ctx = context([line(1, 'Обычная строка.'), line(2, '— как дела?')]);
    const edits = dialogueDashCapitalRule.apply(ctx) ?? [];
    expect(edits).toHaveLength(1);
    expect(edits[0].range.start.line).toBe(2);
  });

  test('negative: an already-capital letter after the dash is a no-op', () => {
    expect(dialogueDashCapitalRule.apply(context([line(1, '— Привет.')]))).toBeNull();
  });

  test('negative: no space after the dash is left alone', () => {
    expect(dialogueDashCapitalRule.apply(context([line(1, '—привет')]))).toBeNull();
  });

  test('negative: a double hyphen / non-dash start is left alone', () => {
    expect(dialogueDashCapitalRule.apply(context([line(1, '-- привет')]))).toBeNull();
    expect(dialogueDashCapitalRule.apply(context([line(1, 'привет — сказал он')]))).toBeNull();
  });

  test('negative: a code line is skipped', () => {
    expect(dialogueDashCapitalRule.apply(context([line(1, '- код', { isCode: true })]))).toBeNull();
  });

  test('idempotence: a second pass makes no further edits', () => {
    const first = applyCol('— привет.', dialogueDashCapitalRule.apply(context([line(1, '— привет.')])) ?? []);
    expect(dialogueDashCapitalRule.apply(context([line(1, first)]))).toBeNull();
  });
});
