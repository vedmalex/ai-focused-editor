import { expect, test, describe } from 'bun:test';
import { scanSemanticTags, tagAtPosition } from './tag-at-position';

describe('scanSemanticTags', () => {
  test('parses labeled built-in tags with offsets', () => {
    const line = 'On the field [[char:krishna|Krishna]] reins the chariot.';
    const tags = scanSemanticTags(line);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ kind: 'char', id: 'krishna', label: 'Krishna' });
    expect(line.slice(tags[0].start, tags[0].end)).toBe('[[char:krishna|Krishna]]');
  });

  test('parses multiple tags in source order', () => {
    const tags = scanSemanticTags('[[char:arjuna|Arjuna]] asks [[term:dharma|dharma]].');
    expect(tags.map(t => t.id)).toEqual(['arjuna', 'dharma']);
  });

  test('parses a bare [[kind:id]] without label', () => {
    const tags = scanSemanticTags('see [[sloka:bg-2-47]] here');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ kind: 'sloka', id: 'bg-2-47' });
    expect(tags[0].label).toBeUndefined();
  });

  test('parses a bare [[id]] with no kind', () => {
    const tags = scanSemanticTags('note [[krishna]] alone');
    expect(tags[0]).toMatchObject({ kind: '', id: 'krishna' });
  });

  test('parses an author type with a Cyrillic tag kind', () => {
    const tags = scanSemanticTags('здесь [[персонаж:кришна|Кришна]] говорит');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ kind: 'персонаж', id: 'кришна', label: 'Кришна' });
  });

  test('ignores an unclosed tag', () => {
    expect(scanSemanticTags('open [[char:krishna without close')).toHaveLength(0);
  });

  test('ignores empty brackets', () => {
    expect(scanSemanticTags('nothing [[]] here')).toHaveLength(0);
  });
});

describe('tagAtPosition', () => {
  const line = 'a [[char:krishna|Krishna]] b';
  const start = line.indexOf('[[');
  const end = line.indexOf(']]') + 2;

  test('returns the tag when the cursor is inside', () => {
    const tag = tagAtPosition(line, start + 5);
    expect(tag?.id).toBe('krishna');
  });

  test('includes both boundaries', () => {
    expect(tagAtPosition(line, start)?.id).toBe('krishna');
    expect(tagAtPosition(line, end)?.id).toBe('krishna');
  });

  test('returns null outside any tag', () => {
    expect(tagAtPosition(line, 0)).toBeNull();
    expect(tagAtPosition(line, line.length)).toBeNull();
  });

  test('resolves the correct tag among several', () => {
    const multi = '[[char:arjuna|Arjuna]] and [[char:krishna|Krishna]]';
    const second = multi.lastIndexOf('[[');
    expect(tagAtPosition(multi, second + 4)?.id).toBe('krishna');
  });

  test('works for a Cyrillic author tag', () => {
    const ru = 'текст [[персонаж:кришна|Кришна]] ещё';
    const at = ru.indexOf('кришна');
    expect(tagAtPosition(ru, at)?.kind).toBe('персонаж');
  });
});
