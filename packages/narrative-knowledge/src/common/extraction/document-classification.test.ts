/**
 * The fifth kind's boundary, and the `knowledge/**` invariant around it
 * (gh#48 WP-3).
 *
 * EVERY REFUSAL HERE IS PAIRED WITH AN ACCEPTANCE IN THE SAME TEST. A file
 * asserting only "these paths are not timeline files" passes perfectly against a
 * `classifyDocument` that never returns `timeline` at all — which is the exact
 * shape of the nine defects this family of issues has already paid for. So each
 * `undefined` assertion sits beside the one-character-different path that MUST
 * classify, and a rule too narrow fails the positive half while a rule too wide
 * fails the negative half.
 */

import { describe, expect, test } from 'bun:test';
import { BASE_ENTITY_TYPES } from '../entity-type-registry';
import {
  classifyDocument,
  isTimelineDocumentPath,
  narrativeIndexMayReadUnder,
  TIMELINE_DIRECTORY
} from './document-classification';

const TYPES = BASE_ENTITY_TYPES;

describe('the fifth document kind', () => {
  test('a timeline file classifies, and its near-misses do not', () => {
    // POSITIVE, first and in the same test as every refusal below.
    expect(classifyDocument('knowledge/timeline/main.yaml', TYPES)).toEqual({ kind: 'timeline' });
    expect(classifyDocument('knowledge/timeline/act-one.yml', TYPES)).toEqual({ kind: 'timeline' });

    // NESTED: the plan's named negative. An arbitrary-depth rule passes the two
    // lines above and fails here.
    expect(classifyDocument('knowledge/timeline/nested/dir/events.yaml', TYPES)).toBeUndefined();
    // The DIRECTORY is the boundary, not the word.
    expect(classifyDocument('knowledge/timeline.yaml', TYPES)).toBeUndefined();
    expect(classifyDocument('timeline/main.yaml', TYPES)).toBeUndefined();
    // Right directory, wrong extension: events are YAML.
    expect(classifyDocument('knowledge/timeline/notes.md', TYPES)).toBeUndefined();
    expect(classifyDocument('knowledge/timeline/decisions.jsonl', TYPES)).toBeUndefined();
    // The directory itself is not a document.
    expect(classifyDocument(TIMELINE_DIRECTORY, TYPES)).toBeUndefined();
  });

  test('the rest of knowledge/ stays invisible, beside a timeline file that does not', () => {
    // The paths gh#50 and gh#52 anchor their own teeth on.
    expect(classifyDocument('knowledge/plans/act-1.yaml', TYPES)).toBeUndefined();
    expect(classifyDocument('knowledge/consistency/decisions.jsonl', TYPES)).toBeUndefined();
    expect(classifyDocument('knowledge/research/run-7/candidates.jsonl', TYPES)).toBeUndefined();
    // PAIRED POSITIVE: the exemption is real, so "knowledge/** is invisible"
    // cannot be satisfied by refusing everything under `knowledge/`.
    expect(classifyDocument('knowledge/timeline/main.yaml', TYPES)).toEqual({ kind: 'timeline' });
  });

  test('the four older kinds are untouched by the fifth', () => {
    expect(classifyDocument('manifest.yaml', TYPES)).toEqual({ kind: 'manifest' });
    expect(classifyDocument('entities/types.yaml', TYPES)).toEqual({ kind: 'entity-types' });
    expect(classifyDocument('content/ch-01.md', TYPES)).toEqual({ kind: 'chapter' });
    expect(classifyDocument('entities/characters/ivan.yaml', TYPES)?.kind).toBe('entity-card');
    // Still nothing, and still for the older reason (relation source 5).
    expect(classifyDocument('sources/citations.yaml', TYPES)).toBeUndefined();
  });

  test('a leading ./ and backslashes normalize before the rule applies', () => {
    expect(classifyDocument('./knowledge/timeline/main.yaml', TYPES)).toEqual({ kind: 'timeline' });
    expect(classifyDocument('knowledge\\timeline\\main.yaml', TYPES)).toEqual({ kind: 'timeline' });
    // And normalization does not smuggle a nested file in.
    expect(classifyDocument('./knowledge/timeline/nested/x.yaml', TYPES)).toBeUndefined();
  });
});

describe('what the walk may skip (F-12)', () => {
  test('the skip rule and the classification rule agree, both ways', () => {
    // A path the walk skips must never classify — otherwise the index would
    // refuse a document it is supposed to hold, and no classification test
    // would see it.
    const skipped = [
      'knowledge/plans/act-1.yaml',
      'knowledge/consistency/decisions.jsonl',
      'knowledge/research/run-7/candidates.jsonl',
      'knowledge/timeline/nested/dir/events.yaml',
      'knowledge/timeline/notes.md'
    ];
    for (const path of skipped) {
      expect(narrativeIndexMayReadUnder(path)).toBe(false);
      expect(classifyDocument(path, TYPES)).toBeUndefined();
    }

    // PAIRED POSITIVE: everything the index reads is reachable by the walk.
    const kept = [
      'manifest.yaml',
      'entities/types.yaml',
      'entities/characters/ivan.yaml',
      'content/ch-01.md',
      'knowledge/timeline/main.yaml'
    ];
    for (const path of kept) {
      expect(narrativeIndexMayReadUnder(path)).toBe(true);
    }
  });

  test('no classifiable path is ever skipped — the two rules cannot disagree', () => {
    // THE DANGEROUS DIRECTION, asserted as an implication rather than as a
    // list. A file the walk skips but classification accepts is a document kind
    // that is dead in the product: every unit test of `classifyDocument` stays
    // green while the file never reaches the pipeline at all. Written this way
    // the assertion survives a change to EITHER rule — widen the classifier
    // without widening the walk and this fails, which is the whole point.
    const everyShape = [
      'manifest.yaml',
      'entities/types.yaml',
      'entities/characters/ivan.yaml',
      'content/ch-01.md',
      'knowledge/timeline/main.yaml',
      'knowledge/timeline/act-one.yml',
      'knowledge/timeline/nested/dir/events.yaml',
      'knowledge/timeline/notes.md',
      'knowledge/timeline.yaml',
      'knowledge/plans/act-1.yaml',
      'knowledge/consistency/decisions.jsonl',
      'sources/citations.yaml'
    ];
    for (const path of everyShape) {
      if (classifyDocument(path, TYPES) !== undefined) {
        expect(narrativeIndexMayReadUnder(path)).toBe(true);
      }
    }
    // PAIRED POSITIVE: the loop above is vacuously true if nothing classifies,
    // so pin the count it is actually quantifying over.
    expect(everyShape.filter(path => classifyDocument(path, TYPES) !== undefined).length).toBe(6);
  });

  test('sources/** still ARRIVES, so its refusal stays a fact about the pipeline', () => {
    // The liberal-walk doctrine is narrowed by F-12, not abandoned: relation
    // source 5's tooth ("a fixture with non-empty citations yields not one
    // relation row") is only meaningful while these files really reach the
    // classifier.
    expect(narrativeIndexMayReadUnder('sources/citations.yaml')).toBe(true);
    expect(narrativeIndexMayReadUnder('sources/excerpts.jsonl')).toBe(true);
  });
});

describe('isTimelineDocumentPath', () => {
  test('accepts both YAML spellings and rejects a bare directory-looking leaf', () => {
    expect(isTimelineDocumentPath('knowledge/timeline/a.yaml')).toBe(true);
    expect(isTimelineDocumentPath('knowledge/timeline/a.YML')).toBe(true);
    expect(isTimelineDocumentPath('knowledge/timeline/')).toBe(false);
    expect(isTimelineDocumentPath('knowledge/timeline')).toBe(false);
  });
});
