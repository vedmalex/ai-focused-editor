import { describe, expect, test } from 'bun:test';
import { rangeEvidence, wholeFileEvidence, type EntityAppearance, type IndexState, type NarrativeEntity } from '@ai-focused-editor/narrative-knowledge';
import { buildEntityCard, shouldFollowCursor } from './entity-card';

/**
 * NO DOM ANYWHERE IN THIS FILE, and that is a requirement rather than a
 * coincidence. `src/browser/typography/` runs in its own `test:typography`
 * lane because its happy-dom bootstrap installs process-wide globals; this
 * suite exists in `common/` precisely so the card's logic can be asserted in
 * the ordinary aggregated process without repeating that shape.
 */

const READY: IndexState = { state: 'ready', generation: 7, documents: 3, entities: 2, mentions: 4 } as IndexState;

function entity(overrides: Partial<NarrativeEntity> = {}): NarrativeEntity {
  return {
    id: 'krishna',
    type: 'character',
    name: 'Кришна',
    sourcePath: 'entities/characters/krishna.yaml',
    sourceUri: 'file:///w/entities/characters/krishna.yaml',
    origin: 'explicit',
    aliases: [],
    ...overrides
  };
}

function appearance(path: string, line: number, overrides: Partial<EntityAppearance> = {}): EntityAppearance {
  return {
    mention: {
      entityId: 'krishna',
      raw: `${path}:${line}`,
      resolved: true,
      evidence: rangeEvidence(path, { start: { line, character: 0 }, end: { line, character: 5 } })
    },
    ...overrides
  };
}

function base(overrides: Partial<Parameters<typeof buildEntityCard>[0]> = {}) {
  return buildEntityCard({
    entity: entity(),
    descending: [],
    chapterSpread: [],
    relations: [],
    indexState: READY,
    ...overrides
  });
}

describe('buildEntityCard — authored facts', () => {
  test('a field with nothing to say is ABSENT, not present and empty', () => {
    const card = base({ entity: entity({ summary: '   ', notes: '', speechPatterns: ['', '  '] }) });
    // The UX rule of gh#47 ("empty fields are hidden, not shown as a blank
    // questionnaire") is enforced by the MODEL, so a renderer cannot forget it.
    expect(card.explicitFacts).toEqual([]);
  });

  test('paired positive: fields that DO have a value survive, in schema order', () => {
    // Without this twin, a builder that dropped every fact would pass the case
    // above — the commonest way an "absent when empty" rule turns into "absent".
    const card = base({
      entity: entity({ notes: 'заметка', summary: 'кратко', speechPatterns: ['зовёт по имени'] })
    });
    expect(card.explicitFacts.map(fact => fact.field)).toEqual(['summary', 'speechPatterns', 'notes']);
    expect(card.explicitFacts[0].value).toBe('кратко');
    expect(card.explicitFacts[1].value).toEqual(['зовёт по имени']);
  });

  test('machinery is not a fact: id, paths, origin and evidence never appear', () => {
    const card = base({ entity: entity({ summary: 'кратко' }) });
    const fields = card.explicitFacts.map(fact => fact.field);
    for (const machinery of ['id', 'type', 'sourcePath', 'sourceUri', 'origin', 'evidence']) {
      expect(fields).not.toContain(machinery);
    }
  });
});

describe('buildEntityCard — names are merged without duplicating (AC of gh#47)', () => {
  test('the display name is not repeated among the other names', () => {
    const card = base({ entity: entity({ aliases: ['Кришна', 'Говинда'] }) });
    expect(card.otherNames).toEqual(['Говинда']);
  });

  test('an alias repeated as an epithet appears once', () => {
    const card = base({ entity: entity({ aliases: ['Говинда'], epithets: ['Говинда', 'Мадхава'] }) });
    expect(card.otherNames).toEqual(['Говинда', 'Мадхава']);
  });

  test('blank entries are dropped rather than rendered as gaps', () => {
    const card = base({ entity: entity({ aliases: ['', '  ', 'Говинда'] }) });
    expect(card.otherNames).toEqual(['Говинда']);
  });
});

describe('buildEntityCard — first and latest appearance mean the BUILT book', () => {
  /**
   * THE CASE THIS WHOLE SECTION EXISTS FOR. Unplaceable appearances trail the
   * ordered ones in both directions, so a list containing ONLY unplaceable ones
   * still has a first element. Taking `[0]` would report a chapter outside the
   * built book as where the entity first appears — the same defect the ordering
   * fix closed one layer down, arriving again at the layer that gives the value
   * its NAME.
   */
  test('an entity seen only outside the built book has appearances but NO first appearance', () => {
    const outside = [
      appearance('content/cut.md', 1, { orderExclusion: 'not-in-built-book' }),
      appearance('content/scratch.md', 2, { orderExclusion: 'no-chapter-order' })
    ];
    const card = base({ first: outside[0], descending: [...outside].reverse() });
    expect(card.firstAppearance).toBeUndefined();
    expect(card.latestAppearance).toBeUndefined();
    // Shown, not dropped — the rule is about ranking, not about hiding.
    expect(card.recentAppearances).toHaveLength(2);
  });

  test('paired positive: with one placeable appearance, it is both first and latest', () => {
    const placeable = appearance('content/ch-01.md', 3);
    const unplaceable = appearance('content/cut.md', 1, { orderExclusion: 'not-in-built-book' });
    const card = base({ first: placeable, descending: [placeable, unplaceable] });
    expect(card.firstAppearance?.mention.raw).toBe('content/ch-01.md:3');
    // The LATEST is omitted because it is the SAME PLACE — decided by evidence,
    // and asserted here so "one appearance" cannot render as two.
    expect(card.latestAppearance).toBeUndefined();
  });

  test('first comes from the ascending list and latest from the descending one', () => {
    const early = appearance('content/ch-01.md', 1);
    const late = appearance('content/ch-09.md', 1);
    const card = base({ first: early, descending: [late, early] });
    expect(card.firstAppearance?.mention.raw).toBe('content/ch-01.md:1');
    expect(card.latestAppearance?.mention.raw).toBe('content/ch-09.md:1');
  });
});

describe('buildEntityCard — honesty about what is not known', () => {
  test('the index state travels with the model, so an empty section can be explained', () => {
    const rebuilding = { state: 'stale', staleReason: 'rebuilding' } as unknown as IndexState;
    const card = base({ indexState: rebuilding });
    // "No relations" and "the index is rebuilding" are different claims. A model
    // that dropped the state would let a card render one as the other.
    expect(card.relations).toEqual([]);
    expect(card.indexState).toBe(rebuilding);
  });

  test('an unknown entity type is an absent descriptor, not an invented one', () => {
    const card = base({ entity: entity({ type: 'вид-которого-больше-нет' }) });
    expect(card.type).toBeUndefined();
    expect(card.entity.type).toBe('вид-которого-больше-нет');
  });

  test('chapterCount counts documents, not mentions', () => {
    const card = base({
      chapterSpread: [
        { relPath: 'content/ch-01.md', chapterOrder: 0, mentionCount: 3 },
        { relPath: 'content/ch-02.md', chapterOrder: 1, mentionCount: 1 }
      ]
    });
    expect(card.chapterCount).toBe(2);
  });

  test('a whole-file appearance is carried, and it is not a first appearance', () => {
    const wholeFile: EntityAppearance = {
      mention: {
        entityId: 'krishna',
        raw: 'front-matter',
        resolved: true,
        evidence: wholeFileEvidence('content/ch-01.md')
      },
      orderExclusion: 'no-position'
    };
    const card = base({ first: wholeFile, descending: [wholeFile] });
    expect(card.recentAppearances).toHaveLength(1);
    expect(card.firstAppearance).toBeUndefined();
  });
});

describe('shouldFollowCursor — pinning resists the cursor, not the author', () => {
  test('pinned: the caret moving to another entity does NOT replace the card', () => {
    expect(shouldFollowCursor(true, 'krishna', 'arjuna')).toBe(false);
  });

  test('PAIRED POSITIVE: unpinned, the same move DOES replace it', () => {
    // Without this twin the case above is satisfied by a card that never
    // updates at all — which is the likeliest way "pinning works" gets shipped
    // broken, and it would look identical in a screenshot.
    expect(shouldFollowCursor(false, 'krishna', 'arjuna')).toBe(true);
  });

  test('unpinned but the caret is still on the entity already shown: no re-query', () => {
    expect(shouldFollowCursor(false, 'krishna', 'krishna')).toBe(false);
  });

  test('nothing shown yet: the first entity under the caret is taken', () => {
    expect(shouldFollowCursor(false, undefined, 'krishna')).toBe(true);
  });
});

describe('first vs latest is decided by WHERE, never by the tag text', () => {
  /**
   * THE CASE A REALISTIC FIXTURE IS REQUIRED FOR, and the reason the earlier
   * fixtures in this file are not enough: they give every mention a unique
   * `raw` (`path:line`), which is convenient and WRONG. `NarrativeMention.raw`
   * is the whole tag — `[[персонаж:кришна|Кришна]]` — so an author who writes
   * the same reference in chapter 1 and chapter 9 produces two mentions with
   * IDENTICAL `raw`. An implementation comparing `raw` drops the latest
   * appearance in the commonest case there is, and a unique-`raw` fixture hides
   * it completely. This one uses the real shape.
   */
  const TAG = '[[персонаж:кришна|Кришна]]';

  function at(path: string, line: number): EntityAppearance {
    return {
      mention: {
        entityId: 'krishna',
        raw: TAG,
        resolved: true,
        evidence: rangeEvidence(path, { start: { line, character: 0 }, end: { line, character: TAG.length } })
      }
    };
  }

  test('the same tag text in two chapters still yields BOTH a first and a latest', () => {
    const first = at('content/ch-01.md', 4);
    const latest = at('content/ch-09.md', 2);
    const card = base({ first, descending: [latest, first] });
    expect(card.firstAppearance?.mention.evidence.path).toBe('content/ch-01.md');
    expect(card.latestAppearance?.mention.evidence.path).toBe('content/ch-09.md');
  });

  test('PAIRED NEGATIVE: one appearance is not reported twice', () => {
    const only = at('content/ch-01.md', 4);
    const card = base({ first: only, descending: [only] });
    expect(card.firstAppearance).toBeDefined();
    expect(card.latestAppearance).toBeUndefined();
  });

  test('two mentions on the same LINE but different columns are different places', () => {
    const first = at('content/ch-01.md', 4);
    const second: EntityAppearance = {
      mention: {
        entityId: 'krishna',
        raw: TAG,
        resolved: true,
        evidence: rangeEvidence('content/ch-01.md', {
          start: { line: 4, character: 40 },
          end: { line: 4, character: 40 + TAG.length }
        })
      }
    };
    const card = base({ first, descending: [second, first] });
    expect(card.latestAppearance?.mention.evidence.range?.start.character).toBe(40);
  });
});
