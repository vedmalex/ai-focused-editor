import { describe, expect, test } from 'bun:test';
import { spaceAfterPunctuationRule } from './space-after-punctuation';
import {
  LineSnapshot,
  TokenKind,
  TypographyContext,
  TypographyEdit
} from '../typography-types';

function context(lines: LineSnapshot[]): TypographyContext {
  return {
    lines,
    changedRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
    cursor: { line: 1, column: 1 },
    locale: 'en',
    trigger: 'type'
  };
}

function line(lineNumber: number, text: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): LineSnapshot {
  return { lineNumber, text, tokens: opts.tokens ?? [], isCode: opts.isCode ?? false };
}

/** Splice single-line edits (right-to-left) into `text` for golden assertions. */
function spliceEdits(text: string, edits: TypographyEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.range.start.column - a.range.start.column);
  let result = text;
  for (const edit of sorted) {
    const start = edit.range.start.column - 1;
    const end = edit.range.end.column - 1;
    result = result.slice(0, start) + edit.text + result.slice(end);
  }
  return result;
}

function applyToLine(text: string, opts: { isCode?: boolean; tokens?: LineSnapshot['tokens'] } = {}): string {
  const ctx = context([line(1, text, opts)]);
  const edits = spaceAfterPunctuationRule.apply(ctx) ?? [];
  return spliceEdits(text, edits);
}

describe('spaceAfterPunctuationRule (#37)', () => {
  test('metadata is stable and correct', () => {
    expect(spaceAfterPunctuationRule.id).toBe('space-after-punctuation');
    expect(spaceAfterPunctuationRule.priority).toBe(20);
    expect(spaceAfterPunctuationRule.defaultEnabled).toBe(true);
  });

  test('golden: a comma glued to the next word gets a space', () => {
    expect(applyToLine('word,next')).toBe('word, next');
  });

  test('golden: every sentence mark followed by a letter is spaced — EXCEPT a glued colon', () => {
    // ISS-240: the previous expectation here (`d: e`) was a FALSE GOLDEN — it
    // pinned the very behaviour that split `12:30` and `key:value`. A colon with
    // a non-space character on its left and a lower-case letter on its right is
    // structural and stays glued; every other mark is still spaced.
    expect(applyToLine('a.b,c;d:e!f?g')).toBe('a. b, c; d:e! f? g');
  });

  test('golden: a glued colon IS spaced when a capital follows (a prose clause)', () => {
    expect(applyToLine('он сказал:Привет')).toBe('он сказал: Привет');
  });

  test('golden: an ellipsis followed by a word is spaced', () => {
    expect(applyToLine('wait…now')).toBe('wait… now');
  });

  test('negative: a decimal number is not split', () => {
    const ctx = context([line(1, 'pi is 3.14 today')]);
    expect(spaceAfterPunctuationRule.apply(ctx)).toBeNull();
  });

  test('negative: a thousands separator is not split', () => {
    const ctx = context([line(1, 'about 1,000 people')]);
    expect(spaceAfterPunctuationRule.apply(ctx)).toBeNull();
  });

  test('negative: already-correct text is untouched', () => {
    const ctx = context([line(1, 'word, next sentence.')]);
    expect(spaceAfterPunctuationRule.apply(ctx)).toBeNull();
  });

  test('negative: a run of punctuation is not split (?! stays)', () => {
    const ctx = context([line(1, 'really?!')]);
    expect(spaceAfterPunctuationRule.apply(ctx)).toBeNull();
  });

  test('negative: a mark at end of line is left alone', () => {
    const ctx = context([line(1, 'the end.')]);
    expect(spaceAfterPunctuationRule.apply(ctx)).toBeNull();
  });

  test('a period after a WORD before a digit is still spaced (not a number)', () => {
    expect(applyToLine('see rule.5 below')).toBe('see rule. 5 below');
  });

  // ISS-240 — the manuscript-corruption fixtures. Rule #37 is ON BY DEFAULT and
  // runs on the git-irreversible multi-file batch, so each of these was real
  // damage to a writer's text, not a hypothetical.
  describe('ISS-240 negatives: structural tokens are never split', () => {
    const untouched = [
      ['clock time', 'встреча в 12:30 у входа'],
      ['clock time with seconds', 'таймкод 10:20:30 на записи'],
      ['a score / ratio', 'счёт 2:1 в нашу пользу'],
      ['a domain', 'смотри example.com сегодня'],
      ['a file name', 'открой notes.md рядом'],
      ['a hyphenated chapter file', 'правь chapter-01.md первым'],
      ['a full URL', 'ссылка https://site.com/path здесь'],
      ['an e-mail address', 'пиши на ivan@example.com завтра'],
      ['a relative path', 'лежит в ./content/part-01/chapter-02.md рядом'],
      ['a Windows path', 'путь C:\\books\\draft.docx открыт'],
      ['an ISO timestamp', 'updated 2026-08-01T10:20 подтверждено'],
      ['a key:value pair', 'параметр type:chapter в шапке'],
      ['an unknown but file-shaped extension', 'файл chapter-01.qqq рядом'],
      // These two are what the STRUCTURAL guard alone protects: an unknown TLD
      // or extension inside a URL/e-mail, where the suffix dictionary has
      // nothing to say and only `://` / `@` identifies the token as one atom.
      ['a URL with a comma and an unknown extension', 'открой https://example.com/a,b/notes.qqq потом'],
      ['an e-mail on an unknown TLD', 'пиши на ivan@example.qqq завтра']
    ] as const;

    for (const [label, text] of untouched) {
      test(`negative: ${label} — "${text}"`, () => {
        const ctx = context([line(1, text)]);
        expect(spaceAfterPunctuationRule.apply(ctx)).toBeNull();
      });
    }

    test('negative: a digit-flanked semicolon (guard 2 alone covers `;`)', () => {
      // `;` is the one mark the glued-colon guard does NOT cover, so this test
      // is what pins the DIGIT_FLANKED_MARKS extension itself.
      const ctx = context([line(1, 'в пропорции 3;4 по массе')]);
      expect(spaceAfterPunctuationRule.apply(ctx)).toBeNull();
    });

    test('anti-tautology: ordinary prose glued on the same marks IS still fixed', () => {
      // If the guards above were simply "never touch anything", these would
      // regress. They are the reason the negatives are meaningful.
      expect(applyToLine('Привет,мир')).toBe('Привет, мир');
      expect(applyToLine('Да.Нет')).toBe('Да. Нет');
      expect(applyToLine('one,two.three')).toBe('one, two. three');
    });

    test('a file name mid-sentence keeps its extension but ends its sentence', () => {
      // Per-DOT decision, not per-token: the first dot joins `notes.md`, the
      // second one ends the sentence before `Потом`.
      expect(applyToLine('открой notes.md.Потом закрой')).toBe('открой notes.md. Потом закрой');
    });

    test('a domain followed by a comma still gets the comma spacing', () => {
      expect(applyToLine('зайди на example.com,потом уходи')).toBe('зайди на example.com, потом уходи');
    });

    test('idempotence holds on a line that mixes prose and structural tokens', () => {
      const once = applyToLine('в 12:30 открой notes.md,затем пиши');
      expect(once).toBe('в 12:30 открой notes.md, затем пиши');
      const ctx = context([line(1, once)]);
      expect(spaceAfterPunctuationRule.apply(ctx)).toBeNull();
    });
  });

  test('negative: a code line is skipped wholesale', () => {
    expect(applyToLine('a=b;c=d', { isCode: true })).toBe('a=b;c=d');
  });

  test('negative: a mark inside inline code is not spaced', () => {
    // "call `a,b` now" — inline span covers columns 6..11 (1-based, exclusive end).
    const tokens = [{ startColumn: 6, endColumn: 11, kind: TokenKind.InlineCode }];
    expect(applyToLine('call `a,b` now', { tokens })).toBe('call `a,b` now');
  });

  test('idempotence: a second application makes no further edits', () => {
    const once = applyToLine('one,two.three');
    expect(once).toBe('one, two. three');
    const ctx = context([line(1, once)]);
    expect(spaceAfterPunctuationRule.apply(ctx)).toBeNull();
  });

  test('inserted edit is a zero-width space insertion at the right column', () => {
    const ctx = context([line(1, 'a,b')]);
    const edits = spaceAfterPunctuationRule.apply(ctx) ?? [];
    expect(edits).toHaveLength(1);
    // Comma is column 2; the space goes into the gap at column 3 (zero-width).
    expect(edits[0].range.start.column).toBe(3);
    expect(edits[0].range.end.column).toBe(3);
    expect(edits[0].text).toBe(' ');
  });
});
