import { describe, expect, test } from 'bun:test';
import { paragraphLeadingHyphenToEmDashRule } from './paragraph-leading-hyphen-to-em-dash';
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

describe('paragraphLeadingHyphenToEmDashRule (#40)', () => {
  test('metadata is stable and off by default', () => {
    expect(paragraphLeadingHyphenToEmDashRule.id).toBe('paragraph-leading-hyphen-to-em-dash');
    expect(paragraphLeadingHyphenToEmDashRule.priority).toBe(30);
    expect(paragraphLeadingHyphenToEmDashRule.defaultEnabled).toBe(false);
  });

  test('golden: a lone leading hyphen becomes an em dash', () => {
    const edits = paragraphLeadingHyphenToEmDashRule.apply(context([line(1, '- Привет.')])) ?? [];
    expect(spliceEdits('- Привет.', edits)).toBe('— Привет.');
  });

  test('golden: dialogue line surrounded by blank prose converts', () => {
    const ctx = context([line(1, ''), line(2, '- Я вернусь завтра.'), line(3, '')]);
    const edits = paragraphLeadingHyphenToEmDashRule.apply(ctx) ?? [];
    expect(edits).toHaveLength(1);
    expect(edits[0].range.start.line).toBe(2);
  });

  test('negative: a bullet list (adjacent list neighbour) is left alone', () => {
    const ctx = context([line(1, '- first'), line(2, '- second'), line(3, '- third')]);
    expect(paragraphLeadingHyphenToEmDashRule.apply(ctx)).toBeNull();
  });

  test('negative: an indented hyphen (nested list) is not converted', () => {
    expect(paragraphLeadingHyphenToEmDashRule.apply(context([line(1, '  - nested')]))).toBeNull();
  });

  test('negative: a thematic-break-ish / double hyphen is not converted', () => {
    expect(paragraphLeadingHyphenToEmDashRule.apply(context([line(1, '-- not a dash')]))).toBeNull();
    expect(paragraphLeadingHyphenToEmDashRule.apply(context([line(1, '-  двойной пробел')]))).toBeNull();
  });

  test('negative: a code line is skipped', () => {
    expect(paragraphLeadingHyphenToEmDashRule.apply(context([line(1, '- code', { isCode: true })]))).toBeNull();
  });

  test('idempotence: a second application makes no further edits', () => {
    const edits = paragraphLeadingHyphenToEmDashRule.apply(context([line(1, '- Привет.')])) ?? [];
    const once = spliceEdits('- Привет.', edits);
    expect(paragraphLeadingHyphenToEmDashRule.apply(context([line(1, once)]))).toBeNull();
  });
});
