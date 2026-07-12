import { describe, expect, test } from 'bun:test';
import {
  buildMentionIndex,
  mentionsForEntity,
  countMentions,
  mentionKey,
  type MentionTarget
} from './entity-mentions';

const krishna: MentionTarget = { kind: 'character', tagKind: 'char', id: 'krishna' };

describe('buildMentionIndex + mentionsForEntity', () => {
  test('indexes tags by kind+id with file + 1-based line + preview', () => {
    const files = [
      { path: 'content/ch1.md', text: 'Intro line\nHere [[char:krishna|Krishna]] speaks.\n\nAgain [[char:krishna]].' }
    ];
    const index = buildMentionIndex(files);
    const spots = mentionsForEntity(index, krishna);
    expect(spots).toEqual([
      { path: 'content/ch1.md', line: 2, preview: 'Here [[char:krishna|Krishna]] speaks.' },
      { path: 'content/ch1.md', line: 4, preview: 'Again [[char:krishna]].' }
    ]);
  });

  test('matches by type id, tag kind, and a bare [[id]]', () => {
    const files = [
      { path: 'a.md', text: '[[character:krishna]]' },
      { path: 'b.md', text: '[[char:krishna]]' },
      { path: 'c.md', text: 'bare [[krishna]] here' }
    ];
    const index = buildMentionIndex(files);
    expect(countMentions(index, krishna)).toBe(3);
  });

  test('is Unicode-aware (Cyrillic kind + id)', () => {
    const target: MentionTarget = { kind: 'персонаж', tagKind: 'персонаж', id: 'кришна' };
    const index = buildMentionIndex([{ path: 'ru.md', text: 'Вот [[персонаж:кришна|Кришна]].' }]);
    expect(countMentions(index, target)).toBe(1);
  });

  test('collapses repeats on one line to a single spot, sorts by path then line', () => {
    const files = [
      { path: 'z.md', text: '[[char:krishna]] and [[char:krishna]] twice' },
      { path: 'a.md', text: 'line1\nline2\n[[char:krishna]]' }
    ];
    const index = buildMentionIndex(files);
    const spots = mentionsForEntity(index, krishna);
    expect(spots).toEqual([
      { path: 'a.md', line: 3, preview: '[[char:krishna]]' },
      { path: 'z.md', line: 1, preview: '[[char:krishna]] and [[char:krishna]] twice' }
    ]);
  });

  test('unreferenced entity yields zero mentions', () => {
    const index = buildMentionIndex([{ path: 'a.md', text: '[[char:rama]]' }]);
    expect(countMentions(index, krishna)).toBe(0);
    expect(mentionsForEntity(index, krishna)).toEqual([]);
  });
});

describe('mentionKey', () => {
  test('lower-cases the kind and uses the null separator', () => {
    expect(mentionKey('Char', 'krishna')).toBe(`char${'\u0000'}krishna`);
    expect(mentionKey('', 'krishna')).toBe(`${'\u0000'}krishna`);
  });
});
