/**
 * What the diagnostics publisher actually PUTS on screen (TASK-022 WP-5).
 *
 * The sibling suite `narrative-memory-presentation.test.ts` decides WHETHER to
 * publish in each of the six states; this one decides WHAT a published marker
 * says and where it points. They are separate because they fail for separate
 * reasons — a wrong state rule hides real problems, a wrong URI sends the
 * author to a file that has nothing wrong with it.
 *
 * IT RUNS IN THE ORDINARY LANE. `@theia/core/lib/common/nls`,
 * `@theia/core/lib/common/uri` and
 * `@theia/core/shared/vscode-languageserver-protocol` all load under `bun`;
 * `@theia/core/lib/browser` and `@theia/markers/lib/browser/...` do not, which
 * is why this module holds the marker construction and the contribution holds
 * only the `setMarkers` calls.
 */

import { describe, expect, test } from 'bun:test';
import { DiagnosticSeverity } from '@theia/core/shared/vscode-languageserver-protocol';
import {
  rangeEvidence,
  wholeFileEvidence,
  type DuplicateEntityRecord,
  type NarrativeMention,
  type NarrativeRelation
} from '../common';
import {
  NARRATIVE_MEMORY_DIAGNOSTIC_SOURCE,
  NARRATIVE_MEMORY_MARKER_OWNER,
  mergeMarkerBatches,
  narrativeDuplicateEntityMarkerBatches,
  narrativeMarkerBatches,
  narrativeRelationMarkerBatches,
  type NarrativeMarkerBatch
} from './narrative-memory-markers';

const ROOT = 'file:///manuscripts/book';

function mention(overrides: Partial<NarrativeMention> & Pick<NarrativeMention, 'evidence'>): NarrativeMention {
  return {
    entityId: 'arjuna',
    raw: '[[Арджуна]]',
    resolved: false,
    ...overrides
  } as NarrativeMention;
}

describe('WP-5 diagnostics — what a published marker says', () => {
  test('an unresolved prose mention becomes ONE warning at its own range', () => {
    const evidence = rangeEvidence('chapters/01.md', {
      start: { line: 4, character: 10 },
      end: { line: 4, character: 20 }
    });
    const batches = narrativeMarkerBatches(ROOT, [mention({ evidence, label: 'Арджуна' })]);

    expect(batches).toHaveLength(1);
    expect(batches[0].uri).toBe('file:///manuscripts/book/chapters/01.md');
    expect(batches[0].diagnostics).toHaveLength(1);
    const marker = batches[0].diagnostics[0];
    // WARNING, not error: a reference to a character not yet written down is an
    // ordinary state of a manuscript in progress, and an error tone on it
    // teaches the author to ignore the Problems view.
    expect(marker.severity).toBe(DiagnosticSeverity.Warning);
    expect(marker.source).toBe(NARRATIVE_MEMORY_DIAGNOSTIC_SOURCE);
    expect(marker.range).toEqual({
      start: { line: 4, character: 10 },
      end: { line: 4, character: 20 }
    });
    expect(marker.message).toContain('Арджуна');
  });

  test('a RESOLVED mention produces nothing — the publisher reports broken links only', () => {
    const evidence = rangeEvidence('chapters/01.md', {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 }
    });
    expect(narrativeMarkerBatches(ROOT, [mention({ evidence, resolved: true })])).toEqual([]);
  });

  test('the URI is DERIVED from the workspace root and the relative path', () => {
    // `EvidenceRef.path` is workspace-relative by construction — the graph core
    // may not import `@theia/core`, so it cannot hold a URI — and this layer is
    // the first that knows the root. Deriving here also avoids `entity.sourceUri`
    // entirely, which `moveDocument` does NOT repair on a rename: a marker built
    // from that field would point at where the file used to live.
    const evidence = rangeEvidence('parts/ii/ch-09.md', {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 3 }
    });
    const [batch] = narrativeMarkerBatches('file:///a b/книга', [mention({ evidence })]);
    expect(batch.uri).toBe('file:///a%20b/%D0%BA%D0%BD%D0%B8%D0%B3%D0%B0/parts/ii/ch-09.md');
  });

  test('mentions in one file are grouped into ONE batch, and two files into two', () => {
    // `setMarkers(uri, owner, markers)` REPLACES the whole set for that uri, so
    // a publisher that emitted one batch per mention would leave each document
    // showing only its last problem.
    const at = (path: string, line: number) =>
      mention({
        evidence: rangeEvidence(path, {
          start: { line, character: 0 },
          end: { line, character: 4 }
        })
      });
    const batches = narrativeMarkerBatches(ROOT, [
      at('chapters/01.md', 1),
      at('chapters/01.md', 9),
      at('chapters/02.md', 3)
    ]);
    expect(batches).toHaveLength(2);
    expect(batches.find(batch => batch.uri.endsWith('01.md'))!.diagnostics).toHaveLength(2);
    expect(batches.find(batch => batch.uri.endsWith('02.md'))!.diagnostics).toHaveLength(1);
  });

  test('whole-file evidence SAYS it has no position instead of faking 0:0 (ISS-320)', () => {
    const [batch] = narrativeMarkerBatches(ROOT, [
      mention({ evidence: wholeFileEvidence('entities/arjuna.md'), label: 'Арджуна' })
    ]);
    const marker = batch.diagnostics[0];
    const [ranged] = narrativeMarkerBatches(ROOT, [
      mention({
        evidence: rangeEvidence('entities/arjuna.md', {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 }
        }),
        label: 'Арджуна'
      })
    ]);
    // The two markers sit at the SAME coordinates — the Problems view has no
    // "whole file" affordance, so line 0 is forced. What must differ is what
    // they SAY, or a reference with no position is indistinguishable from a
    // real one at the top of the file.
    expect(marker.range).toEqual(ranged.diagnostics[0].range);
    expect(marker.message).not.toBe(ranged.diagnostics[0].message);
  });

  test('the label is preferred over the raw text, and raw is the fallback', () => {
    const evidence = rangeEvidence('chapters/01.md', {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    });
    const labelled = narrativeMarkerBatches(ROOT, [mention({ evidence, label: 'Кришна' })]);
    const bare = narrativeMarkerBatches(ROOT, [mention({ evidence, raw: '[[krsna]]' })]);
    expect(labelled[0].diagnostics[0].message).toContain('Кришна');
    expect(bare[0].diagnostics[0].message).toContain('[[krsna]]');
  });

  test('the owner is this package\'s alone', () => {
    // The withdrawal path (`setMarkers(uri, owner, [])`) is scoped by the owner
    // string and nothing else, so sharing one with another publisher would make
    // each capable of deleting the other's problems.
    expect(NARRATIVE_MEMORY_MARKER_OWNER).toBe('ai-focused-editor.narrativeMemory');
    expect(NARRATIVE_MEMORY_MARKER_OWNER).not.toBe('ai-focused-editor.workspace');
  });
});

function relation(overrides: Partial<NarrativeRelation> = {}): NarrativeRelation {
  return {
    sourceId: 'arjuna',
    targetId: 'ghost-owner',
    relType: 'ownership',
    origin: 'explicit',
    ownerPath: 'entities/arjuna.md',
    sourceResolved: true,
    targetResolved: false,
    evidence: [wholeFileEvidence('entities/arjuna.md')],
    ...overrides
  };
}

describe('ISS-353 (а) — a broken end of a structural relation', () => {
  test('becomes ONE warning on the OWNING card, at whole-file position', () => {
    const batches = narrativeRelationMarkerBatches(ROOT, [relation()]);

    expect(batches).toHaveLength(1);
    expect(batches[0].uri).toBe('file:///manuscripts/book/entities/arjuna.md');
    expect(batches[0].diagnostics).toHaveLength(1);
    const marker = batches[0].diagnostics[0];
    expect(marker.severity).toBe(DiagnosticSeverity.Warning);
    expect(marker.source).toBe(NARRATIVE_MEMORY_DIAGNOSTIC_SOURCE);
    expect(marker.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
    expect(marker.message).toContain('ownership');
    expect(marker.message).toContain('ghost-owner');
  });

  test('a relation with BOTH ends resolved produces nothing', () => {
    expect(
      narrativeRelationMarkerBatches(ROOT, [relation({ sourceResolved: true, targetResolved: true })])
    ).toEqual([]);
  });

  test('a broken TARGET (the common ownership.owner typo) names the target id', () => {
    const [batch] = narrativeRelationMarkerBatches(
      ROOT,
      [relation({ sourceResolved: true, targetResolved: false, sourceId: 'arjuna', targetId: 'nonexistent' })]
    );
    expect(batch.diagnostics[0].message).toContain('nonexistent');
    expect(batch.diagnostics[0].message).not.toContain('"arjuna"');
  });

  test('a broken SOURCE names the source id', () => {
    const [batch] = narrativeRelationMarkerBatches(
      ROOT,
      [relation({ sourceResolved: false, targetResolved: true, sourceId: 'ghost-source', targetId: 'krishna' })]
    );
    expect(batch.diagnostics[0].message).toContain('ghost-source');
    expect(batch.diagnostics[0].message).not.toContain('"krishna"');
  });

  test('BOTH ends broken names the TARGET, matching NarrativeIndexSession.collectFindings', () => {
    // `narrative-index-session.ts`'s own `collectFindings` reports the target
    // when both ends are unresolved. Two publishers of the same defect
    // disagreeing about which id is "the" broken one would be worse than
    // either choice, so this mirrors it exactly.
    const [batch] = narrativeRelationMarkerBatches(
      ROOT,
      [relation({ sourceResolved: false, targetResolved: false, sourceId: 'ghost-source', targetId: 'ghost-target' })]
    );
    expect(batch.diagnostics[0].message).toContain('ghost-target');
    expect(batch.diagnostics[0].message).not.toContain('"ghost-source"');
  });

  test('RANGE evidence at the owning card produces a range marker with a DIFFERENT message than whole-file (ISS-320)', () => {
    const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } };
    const [ranged] = narrativeRelationMarkerBatches(
      ROOT,
      [relation({ evidence: [rangeEvidence('entities/arjuna.md', range)] })]
    );
    const [wholeFile] = narrativeRelationMarkerBatches(ROOT, [relation()]);
    expect(ranged.diagnostics[0].range).toEqual(range);
    expect(ranged.diagnostics[0].message).not.toBe(wholeFile.diagnostics[0].message);
  });

  test('a relation with no owning card (no `ownerPath`) is skipped, not crashed on', () => {
    // Unreachable via any writer this package ships today — a relation with no
    // `ownerPath` is always `derived`, and every derived relation is built from
    // already-resolved mentions (`foldCoOccurrenceRelations`), so it can never
    // be broken. The guard is still exercised here because a silent future
    // regression of that invariant must not crash the publisher.
    const broken = relation({ sourceResolved: false, targetResolved: false });
    const { ownerPath: _ownerPath, ...withoutOwner } = broken;
    expect(narrativeRelationMarkerBatches(ROOT, [withoutOwner as NarrativeRelation])).toEqual([]);
  });

  test('a relation whose evidence does not include the owning card is skipped, not mis-placed', () => {
    expect(
      narrativeRelationMarkerBatches(
        ROOT,
        [relation({ ownerPath: 'entities/arjuna.md', evidence: [wholeFileEvidence('entities/someone-else.md')] })]
      )
    ).toEqual([]);
  });
});

function duplicate(overrides: Partial<DuplicateEntityRecord> = {}): DuplicateEntityRecord {
  return {
    entityId: 'krishna',
    keptRelPath: 'entities/krishna.md',
    excludedRelPaths: ['entities/krishna-old.md'],
    ...overrides
  };
}

describe('ISS-353 (б) — every duplicate entity id, its own marker', () => {
  test('a duplicate becomes a warning on its EXCLUDED card, never the kept one', () => {
    const batches = narrativeDuplicateEntityMarkerBatches(ROOT, [duplicate()]);

    expect(batches).toHaveLength(1);
    expect(batches[0].uri).toBe('file:///manuscripts/book/entities/krishna-old.md');
    expect(batches[0].uri).not.toContain('krishna.md/');
    const marker = batches[0].diagnostics[0];
    expect(marker.severity).toBe(DiagnosticSeverity.Warning);
    expect(marker.source).toBe(NARRATIVE_MEMORY_DIAGNOSTIC_SOURCE);
    expect(marker.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
    expect(marker.message).toContain('krishna');
    // Names the file currently in effect, so an author standing on the losing
    // card still sees the other side of the conflict.
    expect(marker.message).toContain('entities/krishna.md');
  });

  test('several excluded cards for the same id EACH get their own marker', () => {
    const batches = narrativeDuplicateEntityMarkerBatches(
      ROOT,
      [duplicate({ excludedRelPaths: ['entities/krishna-a.md', 'entities/krishna-b.md'] })]
    );
    expect(batches).toHaveLength(2);
    expect(batches.map(batch => batch.uri).sort()).toEqual([
      'file:///manuscripts/book/entities/krishna-a.md',
      'file:///manuscripts/book/entities/krishna-b.md'
    ]);
    for (const batch of batches) {
      expect(batch.diagnostics).toHaveLength(1);
    }
  });

  test('no duplicates produces nothing', () => {
    expect(narrativeDuplicateEntityMarkerBatches(ROOT, [])).toEqual([]);
  });
});

describe('WP-5 — merging three categories under one owner', () => {
  test('two categories on the SAME uri merge into ONE batch, not the last write winning', () => {
    // `ProblemManager.setMarkers(uri, owner, diagnostics)` REPLACES the whole
    // set for a (uri, owner) pair. Publishing mentions, then relations, then
    // duplicates as THREE separate `setMarkers` calls for the same file would
    // leave only the last category visible — this is the guard against that.
    const mentionBatches: NarrativeMarkerBatch[] = [
      { uri: 'file:///manuscripts/book/entities/arjuna.md', diagnostics: [{ severity: 2, source: 'x', message: 'mention', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] }
    ];
    const relationBatches: NarrativeMarkerBatch[] = [
      { uri: 'file:///manuscripts/book/entities/arjuna.md', diagnostics: [{ severity: 2, source: 'x', message: 'relation', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] }
    ];
    const merged = mergeMarkerBatches(mentionBatches, relationBatches);
    expect(merged).toHaveLength(1);
    expect(merged[0].diagnostics).toHaveLength(2);
    expect(merged[0].diagnostics.map(d => d.message).sort()).toEqual(['mention', 'relation']);
  });

  test('distinct uris across categories stay SEPARATE batches', () => {
    const a: NarrativeMarkerBatch[] = [
      { uri: 'file:///manuscripts/book/a.md', diagnostics: [{ severity: 2, source: 'x', message: 'a', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] }
    ];
    const b: NarrativeMarkerBatch[] = [
      { uri: 'file:///manuscripts/book/b.md', diagnostics: [{ severity: 2, source: 'x', message: 'b', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] }
    ];
    const merged = mergeMarkerBatches(a, b);
    expect(merged).toHaveLength(2);
  });

  test('an END-TO-END mix (a mention AND a relation break on the same file) merges via the real builders', () => {
    const mention: NarrativeMention = {
      entityId: 'ghost',
      raw: '[[ghost]]',
      resolved: false,
      evidence: rangeEvidence('entities/arjuna.md', { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } })
    };
    const brokenRelation = relation({ ownerPath: 'entities/arjuna.md', evidence: [wholeFileEvidence('entities/arjuna.md')] });

    const merged = mergeMarkerBatches(
      narrativeMarkerBatches(ROOT, [mention]),
      narrativeRelationMarkerBatches(ROOT, [brokenRelation])
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].uri).toBe('file:///manuscripts/book/entities/arjuna.md');
    expect(merged[0].diagnostics).toHaveLength(2);
  });
});
