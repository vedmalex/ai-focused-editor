import { describe, expect, test } from 'bun:test';
import { periodAfterDoubleSpaceRule } from './period-after-double-space';
import {
  LineSnapshot,
  TypographyContext,
  TypographyEdit
} from '../typography-types';

function context(lines: LineSnapshot[]): TypographyContext {
  return {
    lines,
    changedRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    cursor: { line: 1, column: 1 },
    locale: 'ru',
    trigger: 'type'
  };
}

function line(lineNumber: number, text: string, opts: { isCode?: boolean } = {}): LineSnapshot {
  return { lineNumber, text, tokens: [], isCode: opts.isCode ?? false };
}

function spliceEdits(text: string, edits: TypographyEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.range.start.column - a.range.start.column);
  let result = text;
  for (const edit of sorted) {
    result = result.slice(0, edit.range.start.column - 1) + edit.text + result.slice(edit.range.end.column - 1);
  }
  return result;
}

function applyToLine(text: string, opts: { isCode?: boolean } = {}): string {
  const edits = periodAfterDoubleSpaceRule.apply(context([line(1, text, opts)])) ?? [];
  return spliceEdits(text, edits);
}

describe('periodAfterDoubleSpaceRule (#44)', () => {
  test('metadata is stable and off by default', () => {
    expect(periodAfterDoubleSpaceRule.id).toBe('period-after-double-space');
    expect(periodAfterDoubleSpaceRule.priority).toBe(15);
    expect(periodAfterDoubleSpaceRule.defaultEnabled).toBe(false);
  });

  test('golden: trailing double space becomes period + space', () => {
    expect(applyToLine('Сегодня хорошая погода  ')).toBe('Сегодня хорошая погода. ');
  });

  test('golden: mid-line double space becomes period + single space (capital is #39)', () => {
    expect(applyToLine('Я закончил мысль  продолжаю дальше')).toBe('Я закончил мысль. продолжаю дальше');
  });

  test('negative: a single space is untouched', () => {
    expect(periodAfterDoubleSpaceRule.apply(context([line(1, 'обычный текст здесь')]))).toBeNull();
  });

  test('negative: double space after punctuation is not doubled', () => {
    expect(periodAfterDoubleSpaceRule.apply(context([line(1, 'конец.  Далее')]))).toBeNull();
  });

  test('negative: leading indentation (no sentence text before the run) is never touched', () => {
    // The only 2-space run is the indent; nothing sentence-text precedes it.
    expect(periodAfterDoubleSpaceRule.apply(context([line(1, '  текст')]))).toBeNull();
  });

  test('negative: a table row (pipe) is skipped', () => {
    expect(periodAfterDoubleSpaceRule.apply(context([line(1, 'col a  |  col b')]))).toBeNull();
  });

  test('negative: a code line is skipped', () => {
    expect(applyToLine('let x =  1', { isCode: true })).toBe('let x =  1');
  });

  test('idempotence: a second application makes no further edits', () => {
    const once = applyToLine('Сегодня хорошая погода  ');
    expect(once).toBe('Сегодня хорошая погода. ');
    expect(periodAfterDoubleSpaceRule.apply(context([line(1, once)]))).toBeNull();
  });
});
