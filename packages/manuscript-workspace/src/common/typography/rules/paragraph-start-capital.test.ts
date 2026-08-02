import { describe, expect, test } from 'bun:test';
import { paragraphStartCapitalRule } from './paragraph-start-capital';
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

/** Apply single-line edits to `text` (columns are 1-based). */
function applyCol(text: string, edits: TypographyEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.range.start.column - a.range.start.column);
  let result = text;
  for (const edit of sorted) {
    result = result.slice(0, edit.range.start.column - 1) + edit.text + result.slice(edit.range.end.column - 1);
  }
  return result;
}

describe('paragraphStartCapitalRule (#31)', () => {
  test('metadata is stable, on by default, locale-aware', () => {
    expect(paragraphStartCapitalRule.id).toBe('paragraph-start-capital');
    expect(paragraphStartCapitalRule.priority).toBe(50);
    expect(paragraphStartCapitalRule.defaultEnabled).toBe(true);
    expect(paragraphStartCapitalRule.localeAware).toBe(true);
  });

  test('golden: first line of the document is capitalized', () => {
    const edits = paragraphStartCapitalRule.apply(context([line(1, 'иван вошёл.')])) ?? [];
    expect(applyCol('иван вошёл.', edits)).toBe('Иван вошёл.');
  });

  test('golden: line after a blank line is capitalized', () => {
    const ctx = context([line(1, ''), line(2, 'иван вошёл.')]);
    const edits = paragraphStartCapitalRule.apply(ctx) ?? [];
    expect(edits).toHaveLength(1);
    expect(edits[0].range.start.line).toBe(2);
    expect(applyCol('иван вошёл.', edits)).toBe('Иван вошёл.');
  });

  test('golden: a list item capitalizes its content, not the marker', () => {
    const edits = paragraphStartCapitalRule.apply(context([line(1, '- первый пункт')])) ?? [];
    expect(applyCol('- первый пункт', edits)).toBe('- Первый пункт');
  });

  test('golden: a dialogue-dash paragraph capitalizes after the dash', () => {
    const edits = paragraphStartCapitalRule.apply(context([line(1, '— привет.')])) ?? [];
    expect(applyCol('— привет.', edits)).toBe('— Привет.');
  });

  test('negative: a mid-paragraph line (previous line not blank) is left alone', () => {
    const ctx = context([line(1, 'Первая строка.'), line(2, 'и вторая строка.')]);
    expect(paragraphStartCapitalRule.apply(ctx)).toBeNull();
  });

  test('negative: a heading line is not capitalized', () => {
    expect(paragraphStartCapitalRule.apply(context([line(1, '# заголовок')]))).toBeNull();
    expect(paragraphStartCapitalRule.apply(context([line(1, '### раздел')]))).toBeNull();
  });

  test('negative: a code line is skipped', () => {
    expect(paragraphStartCapitalRule.apply(context([line(1, 'иван', { isCode: true })]))).toBeNull();
  });

  test('negative: an already-capital first letter is a no-op', () => {
    expect(paragraphStartCapitalRule.apply(context([line(1, 'Иван вошёл.')]))).toBeNull();
  });

  test('negative: predecessor not in the window and not line 1 is left alone', () => {
    // A lone window line numbered 5 — the blank/prose above is not visible, so
    // the rule must not guess it is a paragraph start.
    expect(paragraphStartCapitalRule.apply(context([line(5, 'иван вошёл.')]))).toBeNull();
  });

  test('idempotence: a second pass makes no further edits', () => {
    const edits = paragraphStartCapitalRule.apply(context([line(1, 'иван вошёл.')])) ?? [];
    const once = applyCol('иван вошёл.', edits);
    expect(paragraphStartCapitalRule.apply(context([line(1, once)]))).toBeNull();
  });

  /**
   * The rule declares `localeAware: true` and routes every decision through
   * `\p{Ll}` + `toLocaleUpperCase(locale)` — yet every case above pins `ru`
   * (QA/ISS-257). A regression that hard-coded a Cyrillic case table, or dropped
   * the `u` flag, would leave the whole suite green while silently doing nothing
   * for an English manuscript.
   */
  describe('en locale (UR-005 Unicode/locale branch)', () => {
    test('golden: an English paragraph start is capitalized', () => {
      const edits = paragraphStartCapitalRule.apply(context([line(1, 'hello world.')], 'en')) ?? [];
      expect(applyCol('hello world.', edits)).toBe('Hello world.');
    });

    test('golden: an English list item capitalizes its content, not the marker', () => {
      const edits = paragraphStartCapitalRule.apply(context([line(1, '- first item')], 'en')) ?? [];
      expect(applyCol('- first item', edits)).toBe('- First item');
    });

    test('negative: an already-capital English start is a no-op', () => {
      expect(paragraphStartCapitalRule.apply(context([line(1, 'Hello world.')], 'en'))).toBeNull();
    });

    test('negative: an English heading is left alone', () => {
      expect(paragraphStartCapitalRule.apply(context([line(1, '# the chapter')], 'en'))).toBeNull();
    });
  });
});
