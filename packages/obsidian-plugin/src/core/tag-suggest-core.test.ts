import { expect, test, describe } from 'bun:test';
import { activeTagContext, rankEntities, rankTagKinds, buildTagInsertion } from './tag-suggest-core';
import type { EntityIndexEntry } from './book-model';

function entity(partial: Partial<EntityIndexEntry> & Pick<EntityIndexEntry, 'id' | 'label'>): EntityIndexEntry {
  return {
    kind: partial.kind ?? 'character',
    tagKind: partial.tagKind ?? 'char',
    id: partial.id,
    label: partial.label,
    path: partial.path ?? `entities/characters/${partial.id}.yaml`,
    aliases: partial.aliases ?? []
  };
}

describe('activeTagContext', () => {
  test('entity phase after kind + colon', () => {
    const line = 'text [[char:kr';
    const ctx = activeTagContext(line, line.length);
    expect(ctx).toMatchObject({ phase: 'entity', kind: 'char', query: 'kr' });
    expect(line.slice(ctx!.tokenStart)).toBe('[[char:kr');
  });

  test('entity phase with empty query right after colon', () => {
    const line = '[[term:';
    expect(activeTagContext(line, line.length)).toMatchObject({ phase: 'entity', kind: 'term', query: '' });
  });

  test('kind phase while typing an identifier run', () => {
    const line = 'x [[per';
    expect(activeTagContext(line, line.length)).toMatchObject({ phase: 'kind', query: 'per' });
  });

  test('Cyrillic kind phase', () => {
    const line = '[[перс';
    expect(activeTagContext(line, line.length)).toMatchObject({ phase: 'kind', query: 'перс' });
  });

  test('no context for a plain wikilink with a space (does not fight Obsidian)', () => {
    const line = '[[My Note';
    expect(activeTagContext(line, line.length)).toBeNull();
  });

  test('no context once the tag is closed', () => {
    const line = '[[char:krishna|Krishna]] rest';
    expect(activeTagContext(line, line.length)).toBeNull();
  });

  test('no context after a pipe (typing the label)', () => {
    const line = '[[char:krishna|Kri';
    expect(activeTagContext(line, line.length)).toBeNull();
  });

  test('no context with no open bracket', () => {
    expect(activeTagContext('plain text', 10)).toBeNull();
  });

  test('picks the nearest unclosed [[ ', () => {
    const line = '[[char:a|A]] then [[term:dh';
    const ctx = activeTagContext(line, line.length);
    expect(ctx).toMatchObject({ phase: 'entity', kind: 'term', query: 'dh' });
  });
});

describe('rankTagKinds', () => {
  test('prefix filter, shortest first', () => {
    expect(rankTagKinds(['term', 'char', 'artifact', 'location'], 'c')).toEqual(['char']);
  });
  test('empty query returns all', () => {
    expect(rankTagKinds(['char', 'term'], '')).toEqual(['char', 'term']);
  });
});

describe('rankEntities', () => {
  const entities: EntityIndexEntry[] = [
    entity({ id: 'krishna', label: 'Krishna', aliases: ['Govinda', 'Madhava'] }),
    entity({ id: 'arjuna', label: 'Arjuna', aliases: ['Partha'] }),
    entity({ id: 'dharma', label: 'dharma', kind: 'term', tagKind: 'term' })
  ];

  test('filters to the requested tag kind', () => {
    const ranked = rankEntities(entities, 'char', '');
    expect(ranked.map(r => r.entry.id).sort()).toEqual(['arjuna', 'krishna']);
  });

  test('prefix on id beats fuzzy', () => {
    const ranked = rankEntities(entities, 'char', 'kr');
    expect(ranked[0].entry.id).toBe('krishna');
  });

  test('matches by alias', () => {
    const ranked = rankEntities(entities, 'char', 'govi');
    expect(ranked[0].entry.id).toBe('krishna');
  });

  test('fuzzy subsequence match', () => {
    const ranked = rankEntities(entities, 'char', 'arn'); // a..r..n in arjuna
    expect(ranked.map(r => r.entry.id)).toContain('arjuna');
  });

  test('non-matches are dropped', () => {
    expect(rankEntities(entities, 'char', 'zzz')).toHaveLength(0);
  });

  test('empty query returns all of the kind, alphabetical', () => {
    expect(rankEntities(entities, 'char', '').map(r => r.entry.label)).toEqual(['Arjuna', 'Krishna']);
  });

  test('resolves an author type by its tag kind (Cyrillic)', () => {
    const authored: EntityIndexEntry[] = [
      entity({ id: 'krishna', label: 'Кришна', kind: 'person', tagKind: 'персонаж' })
    ];
    const ranked = rankEntities(authored, 'персонаж', 'криш');
    expect(ranked[0].entry.id).toBe('krishna');
  });

  test('resolves when the kind is written as the type id', () => {
    const ranked = rankEntities(entities, 'character', 'kr');
    expect(ranked[0].entry.id).toBe('krishna');
  });
});

describe('buildTagInsertion', () => {
  test('emits [[kind:id|label]]', () => {
    expect(buildTagInsertion('char', entity({ id: 'krishna', label: 'Krishna' }))).toBe('[[char:krishna|Krishna]]');
  });
});
