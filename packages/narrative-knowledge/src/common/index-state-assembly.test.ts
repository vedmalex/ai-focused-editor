/**
 * `assembleIndexState` and the co-occurrence fold — the two PURE pieces of
 * WP-4a (TASK-022).
 *
 * THEY ARE HERE AND NOT IN THE CONTRACT CORE BECAUSE THEY TOUCH NO STORE. A
 * contract case's whole purpose is to be run against both adapters; a function
 * that takes four booleans and a number has no adapter to disagree about, and
 * putting it there would only slow the node run down.
 */

import { describe, expect, test } from 'bun:test';
import { assembleIndexState } from './index-state-assembly';
import { foldCoOccurrenceRelations, wholeFileEvidence, rangeEvidence } from './graph';
import type { NarrativeIndexStoreLifecycle, NarrativeMention } from './graph';

function lifecycle(overrides: Partial<NarrativeIndexStoreLifecycle> = {}): NarrativeIndexStoreLifecycle {
  return { generation: 7, readOnly: false, corrupted: false, foreignWriter: false, ...overrides };
}

describe('assembleIndexState', () => {
  test('a written, writable, unremarkable store is ready', () => {
    expect(assembleIndexState({ lifecycle: lifecycle() })).toEqual({ state: 'ready', generation: 7 });
  });

  test('generation 0 means NOT BUILT — derived from the store, not remembered', () => {
    // It is why corruption recovery needs no branch of its own: a recovered
    // store is an empty store, and an empty store has never been written.
    expect(assembleIndexState({ lifecycle: lifecycle({ generation: 0 }) })).toEqual({
      state: 'absent',
      generation: 0,
      cause: 'not-built'
    });
  });

  test('no-manuscript outranks not-built, because it is a different answer entirely', () => {
    expect(
      assembleIndexState({ lifecycle: lifecycle({ generation: 0 }), absent: 'no-manuscript' })
    ).toEqual({ state: 'absent', generation: 0, cause: 'no-manuscript' });
  });

  test('a failure outranks everything below it', () => {
    const reason = { code: 'storage-corrupted' as const, incidentId: 'i-1', occurrences: 2 };
    expect(
      assembleIndexState({
        lifecycle: lifecycle({ readOnly: true }),
        rebuilding: true,
        stale: { reason: 'watcher-lost', since: 5 },
        failure: reason
      })
    ).toEqual({ state: 'failed', generation: 7, reason });
  });

  test('the FIRST build reports rebuilding, not absent', () => {
    // The ordering claim: at generation 0 with a pass in flight, `absent` would
    // make a consumer render "there is no index" for the whole first build.
    expect(assembleIndexState({ lifecycle: lifecycle({ generation: 0 }), rebuilding: true })).toEqual({
      state: 'rebuilding',
      generation: 0
    });
  });

  test('READ-ONLY selects stale/foreign-writer even when foreignWriter is false', () => {
    // THE REJECTING CASE FOR THE MAPPING ITSELF. `{readOnly: true,
    // foreignWriter: false}` is exactly the in-memory adapter's read-only
    // shape, so an assembly keyed on `foreignWriter` reports `ready` here — a
    // store that may not write, claiming to be current.
    expect(
      assembleIndexState({
        lifecycle: lifecycle({ readOnly: true, foreignWriter: false }),
        readOnlySince: 1234
      })
    ).toEqual({ state: 'stale', generation: 7, staleReason: 'foreign-writer', staleSince: 1234 });
  });

  test('a service-side staleness travels with its reason and its moment', () => {
    expect(
      assembleIndexState({ lifecycle: lifecycle(), stale: { reason: 'partial-update-failed', since: 99 } })
    ).toEqual({ state: 'stale', generation: 7, staleReason: 'partial-update-failed', staleSince: 99 });
  });

  test('the surfaced generation is the store WRITE counter, verbatim', () => {
    // Decision recorded in `index-state.ts`: this number is not a count of
    // rebuilds, and nothing here recomputes or rescales it.
    for (const generation of [1, 2, 41]) {
      expect(assembleIndexState({ lifecycle: lifecycle({ generation }) }).generation).toBe(generation);
    }
  });
});

describe('foldCoOccurrenceRelations', () => {
  function mention(entityId: string, path: string, resolved = true): NarrativeMention {
    return { entityId, raw: `[[${entityId}]]`, resolved, evidence: wholeFileEvidence(path) };
  }

  test('two entities in one chapter make one undirected edge, ends in code-point order', () => {
    const [edge, ...rest] = foldCoOccurrenceRelations([
      mention('krishna', 'content/ch-01.md'),
      mention('arjuna', 'content/ch-01.md')
    ]);
    expect(rest).toEqual([]);
    expect(edge!.sourceId).toBe('arjuna');
    expect(edge!.targetId).toBe('krishna');
    expect(edge!.relType).toBe('co-occurrence');
    expect(edge!.origin).toBe('derived');
    expect(edge!.ownerPath).toBeUndefined();
    expect(edge!.evidence.map(item => item.path)).toEqual(['content/ch-01.md']);
  });

  test('the WEIGHT is the evidence: one whole-file ref per shared chapter, in path order', () => {
    const edge = foldCoOccurrenceRelations([
      mention('krishna', 'content/ch-02.md'),
      mention('arjuna', 'content/ch-02.md'),
      mention('arjuna', 'content/ch-01.md'),
      mention('krishna', 'content/ch-01.md')
    ])[0]!;
    expect(edge.evidence.map(item => item.path)).toEqual(['content/ch-01.md', 'content/ch-02.md']);
    for (const evidence of edge.evidence) {
      expect(evidence.evidenceKind).toBe('whole-file');
    }
  });

  test('an UNRESOLVED reference never becomes an end — the rejecting case', () => {
    // A fold that ignored `resolved` would produce an edge to an entity no card
    // defines, and `relation_broken` would then fire on correct data.
    expect(
      foldCoOccurrenceRelations([
        mention('krishna', 'content/ch-01.md'),
        mention('nobody', 'content/ch-01.md', false)
      ])
    ).toEqual([]);
  });

  test('an entity does not co-occur with itself, however many times it appears', () => {
    expect(
      foldCoOccurrenceRelations([
        { ...mention('krishna', 'content/ch-01.md') },
        {
          entityId: 'krishna',
          raw: '[[krishna]]',
          resolved: true,
          evidence: rangeEvidence('content/ch-01.md', {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 11 }
          })
        }
      ])
    ).toEqual([]);
  });

  test('entities in DIFFERENT chapters do not co-occur', () => {
    expect(
      foldCoOccurrenceRelations([
        mention('krishna', 'content/ch-01.md'),
        mention('arjuna', 'content/ch-02.md')
      ])
    ).toEqual([]);
  });
});
