/**
 * The fold from the extraction's collision findings into the store's.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `narrative-extraction.test.ts`. That one
 * asserts what the extraction FINDS; this one asserts what survives the trip to
 * the storage layer, which is a different question and used to have a different
 * answer: the store's record could not name the winner at all, so the answer to
 * "which definition is in effect" was produced here and dropped at the
 * boundary. The last case is the one that would have caught that — it folds,
 * writes, reads back, and compares.
 */

import { describe, expect, test } from 'bun:test';
import { buildEntityCatalog, foldEntityDuplicates, type EntityDuplicate } from './entity-catalog';
import type { NarrativeEntity } from '../graph';
import { InMemoryNarrativeIndexStore } from '../in-memory-narrative-index-store';

const CHARACTER_CARD = 'entities/characters/krishna.yaml';
const LOCATION_CARD = 'entities/locations/krishna.yaml';
const CYRILLIC_CARD = 'entities/Ярость.yaml';

function entity(id: string, sourcePath: string, type = 'character'): NarrativeEntity {
  return {
    id,
    type,
    name: id,
    sourcePath,
    sourceUri: `file:///workspace/${sourcePath}`,
    origin: 'explicit',
    aliases: []
  };
}

function duplicate(entityId: string, sourcePath: string, keptSourcePath: string): EntityDuplicate {
  return { entityId, sourcePath, keptSourcePath };
}

describe('foldEntityDuplicates', () => {
  test('nothing folds to nothing — a healthy manuscript has no findings', () => {
    expect(foldEntityDuplicates([])).toEqual([]);
  });

  test('one loser folds to one record that names BOTH sides of the collision', () => {
    expect(foldEntityDuplicates([duplicate('krishna', LOCATION_CARD, CHARACTER_CARD)])).toEqual([
      { entityId: 'krishna', keptRelPath: CHARACTER_CARD, excludedRelPaths: [LOCATION_CARD] }
    ]);
  });

  test('THREE cards colliding is not lossy: one record, one winner, two losers', () => {
    // The case worth naming, because it is the one where a fold could quietly
    // keep only the last loser and still look like it worked.
    const folded = foldEntityDuplicates([
      duplicate('krishna', LOCATION_CARD, CHARACTER_CARD),
      duplicate('krishna', CYRILLIC_CARD, CHARACTER_CARD)
    ]);
    expect(folded).toEqual([
      {
        entityId: 'krishna',
        keptRelPath: CHARACTER_CARD,
        // Code-point order, which is what the store promises and what SQLite's
        // BINARY collation produces. The two paths first differ at `'l'`
        // (U+006C) against `'Я'` (U+042F), so the Latin one comes first — and
        // `localeCompare` would agree here, which is exactly why the CONTRACT
        // suite uses a pair where the two orders disagree.
        excludedRelPaths: [LOCATION_CARD, CYRILLIC_CARD]
      }
    ]);
  });

  test('the same losing card reported twice collapses — a set, not a tally', () => {
    expect(
      foldEntityDuplicates([
        duplicate('krishna', LOCATION_CARD, CHARACTER_CARD),
        duplicate('krishna', LOCATION_CARD, CHARACTER_CARD)
      ])
    ).toEqual([{ entityId: 'krishna', keptRelPath: CHARACTER_CARD, excludedRelPaths: [LOCATION_CARD] }]);
  });

  test('several colliding ids come back one record each, ordered by id', () => {
    const folded = foldEntityDuplicates([
      duplicate('krishna', CYRILLIC_CARD, CHARACTER_CARD),
      duplicate('arjuna', CYRILLIC_CARD, LOCATION_CARD)
    ]);
    expect(folded.map(record => record.entityId)).toEqual(['arjuna', 'krishna']);
    expect(folded.map(record => record.keptRelPath)).toEqual([LOCATION_CARD, CHARACTER_CARD]);
  });

  test('two different kept cards for ONE id is REFUSED, not resolved by picking one', () => {
    // This is the lossy case, and the reason the fold throws instead of
    // choosing: the store holds exactly one definition per id, so a caller
    // claiming two has already lost the information that would settle it, and
    // guessing would put a confident wrong path in front of the author.
    expect(() =>
      foldEntityDuplicates([
        duplicate('krishna', CYRILLIC_CARD, CHARACTER_CARD),
        duplicate('krishna', CYRILLIC_CARD, LOCATION_CARD)
      ])
    ).toThrow(/two different kept cards/);
  });

  test('a card recorded as having lost to ITSELF is REFUSED', () => {
    expect(() => foldEntityDuplicates([duplicate('krishna', CHARACTER_CARD, CHARACTER_CARD)])).toThrow(
      /lost a collision to its own card/
    );
  });

  test('what buildEntityCatalog produces folds and round-trips through a store unchanged', () => {
    // THE END-TO-END TOOTH. Extraction → fold → store → read, compared against
    // the fold. It fails if any layer drops the winner, mis-assigns it, or
    // orders the losers differently from the way the fold does.
    const cards = [
      entity('krishna', CHARACTER_CARD),
      entity('krishna', LOCATION_CARD, 'location'),
      entity('krishna', CYRILLIC_CARD, 'term')
    ];
    const built = buildEntityCatalog(cards, []);
    expect(built.entities).toHaveLength(1);
    expect(built.duplicates).toHaveLength(2);

    const folded = foldEntityDuplicates(built.duplicates);
    expect(folded).toEqual([
      {
        entityId: 'krishna',
        keptRelPath: CHARACTER_CARD,
        excludedRelPaths: [LOCATION_CARD, CYRILLIC_CARD]
      }
    ]);

    const store = new InMemoryNarrativeIndexStore();
    store.transaction(writer => {
      for (const card of cards) {
        writer.putDocument({
          relPath: card.sourcePath,
          kind: 'entity-card',
          sizeBytes: 1,
          mtimeMs: 1,
          contentHash: 'h',
          indexedAt: 1
        });
      }
      for (const kept of built.entities) {
        writer.putEntity(kept);
      }
      for (const record of folded) {
        for (const excluded of record.excludedRelPaths) {
          writer.putDuplicateEntity(record.entityId, excluded);
        }
      }
    });

    expect(store.getDuplicateEntities()).toEqual(folded);
  });
});
