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
import { rangeEvidence, wholeFileEvidence, type NarrativeMention } from '../common';
import {
  NARRATIVE_MEMORY_DIAGNOSTIC_SOURCE,
  NARRATIVE_MEMORY_MARKER_OWNER,
  narrativeMarkerBatches
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
