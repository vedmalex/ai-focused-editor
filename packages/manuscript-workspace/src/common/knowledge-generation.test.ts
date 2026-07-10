import { describe, expect, test } from 'bun:test';
import {
  coercePlan,
  coerceQuestions,
  coerceSummary,
  extractJsonValue,
  slugifyChapter,
  type KnowledgeMeta
} from './knowledge-generation';

const meta: KnowledgeMeta = {
  chapter: 'content/chapter-01.md',
  title: 'Chapter One',
  generated_at: '2026-07-10T00:00:00.000Z',
  provider: 'openai',
  model: 'gpt-4o-mini'
};

describe('slugifyChapter', () => {
  test('lowercases and hyphenates ASCII titles', () => {
    expect(slugifyChapter('Chapter One: The Beginning')).toBe('chapter-one-the-beginning');
  });

  test('preserves unicode letters (Cyrillic)', () => {
    expect(slugifyChapter('Глава Первая')).toBe('глава-первая');
  });

  test('preserves unicode letters and digits (Greek + number)', () => {
    expect(slugifyChapter('Κεφάλαιο 2')).toBe('κεφάλαιο-2');
  });

  test('collapses combining marks per the shared slug convention (Devanagari)', () => {
    // Devanagari vowel signs are \p{M} (marks), not \p{L}, so slugifyBase drops
    // them — documenting the shared exporter convention rather than a bug.
    expect(slugifyChapter('अध्याय 2')).toBe('अध-य-य-2');
  });

  test('falls back to "chapter" when no letters/digits remain', () => {
    expect(slugifyChapter('!!!___###')).toBe('chapter');
    expect(slugifyChapter('')).toBe('chapter');
  });
});

describe('extractJsonValue', () => {
  test('parses bare JSON', () => {
    expect(extractJsonValue('{"summary":"hi"}')).toEqual({ summary: 'hi' });
  });

  test('parses JSON inside a ```json fenced block wrapped in prose', () => {
    const text = 'Sure! Here is the result:\n\n```json\n{"summary":"fenced"}\n```\nHope that helps.';
    expect(extractJsonValue(text)).toEqual({ summary: 'fenced' });
  });

  test('parses JSON embedded in surrounding prose without fences', () => {
    const text = 'The answer is {"questions":["a","b"]} — done.';
    expect(extractJsonValue(text)).toEqual({ questions: ['a', 'b'] });
  });

  test('returns undefined for unparseable text', () => {
    expect(extractJsonValue('no json here at all')).toBeUndefined();
  });
});

describe('coerceSummary', () => {
  test('valid JSON object -> summary field', () => {
    const { document, parsed } = coerceSummary(meta, '{"summary":"A tense council scene."}');
    expect(parsed).toBe(true);
    expect(document.summary).toBe('A tense council scene.');
    expect(document.raw).toBeUndefined();
    expect(document.chapter).toBe('content/chapter-01.md');
    expect(document.model).toBe('gpt-4o-mini');
  });

  test('JSON wrapped in markdown fences and prose', () => {
    const text = 'Here you go:\n```json\n{"summary":"Fenced synopsis."}\n```';
    const { document, parsed } = coerceSummary(meta, text);
    expect(parsed).toBe(true);
    expect(document.summary).toBe('Fenced synopsis.');
  });

  test('invalid response -> raw fallback', () => {
    const { document, parsed } = coerceSummary(meta, 'I could not produce JSON.');
    expect(parsed).toBe(false);
    expect(document.summary).toBeUndefined();
    expect(document.raw).toBe('I could not produce JSON.');
  });

  test('empty summary string -> raw fallback', () => {
    const { parsed, document } = coerceSummary(meta, '{"summary":"   "}');
    expect(parsed).toBe(false);
    expect(document.raw).toBe('{"summary":"   "}');
  });
});

describe('coercePlan', () => {
  test('valid scenes array', () => {
    const text = JSON.stringify({
      scenes: [
        { title: 'Arrival', purpose: 'Set the stakes', beats: ['They land', 'Guards appear'] },
        { title: 'Confrontation', purpose: 'Escalate', beats: ['Argument'] }
      ]
    });
    const { document, parsed } = coercePlan(meta, text);
    expect(parsed).toBe(true);
    expect(document.scenes).toHaveLength(2);
    expect(document.scenes?.[0]).toEqual({
      title: 'Arrival',
      purpose: 'Set the stakes',
      beats: ['They land', 'Guards appear']
    });
  });

  test('bare array of scenes (no wrapper object)', () => {
    const text = 'Plan:\n```json\n[{"title":"Only scene","beats":[]}]\n```';
    const { document, parsed } = coercePlan(meta, text);
    expect(parsed).toBe(true);
    expect(document.scenes?.[0].title).toBe('Only scene');
    expect(document.scenes?.[0].beats).toEqual([]);
  });

  test('scene missing beats coerces to empty beats list', () => {
    const { document, parsed } = coercePlan(meta, '{"scenes":[{"title":"No beats"}]}');
    expect(parsed).toBe(true);
    expect(document.scenes?.[0]).toEqual({ title: 'No beats', beats: [] });
  });

  test('invalid response -> raw fallback', () => {
    const { document, parsed } = coercePlan(meta, 'no plan');
    expect(parsed).toBe(false);
    expect(document.scenes).toBeUndefined();
    expect(document.raw).toBe('no plan');
  });
});

describe('coerceQuestions', () => {
  test('valid questions array', () => {
    const { document, parsed } = coerceQuestions(meta, '{"questions":["Why now?","What changed?"]}');
    expect(parsed).toBe(true);
    expect(document.questions).toEqual(['Why now?', 'What changed?']);
  });

  test('bare array wrapped in prose', () => {
    const { document, parsed } = coerceQuestions(meta, 'Questions: ["A?","B?"] end');
    expect(parsed).toBe(true);
    expect(document.questions).toEqual(['A?', 'B?']);
  });

  test('drops blank entries', () => {
    const { document, parsed } = coerceQuestions(meta, '{"questions":["Real?","   ",""]}');
    expect(parsed).toBe(true);
    expect(document.questions).toEqual(['Real?']);
  });

  test('empty questions array -> raw fallback', () => {
    const { document, parsed } = coerceQuestions(meta, '{"questions":[]}');
    expect(parsed).toBe(false);
    expect(document.raw).toBe('{"questions":[]}');
  });

  test('invalid response -> raw fallback', () => {
    const { document, parsed } = coerceQuestions(meta, 'no questions');
    expect(parsed).toBe(false);
    expect(document.questions).toBeUndefined();
    expect(document.raw).toBe('no questions');
  });
});
