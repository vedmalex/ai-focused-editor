import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import {
  Diagnostic,
  DiagnosticSeverity
} from '@theia/core/shared/vscode-languageserver-protocol';
import { isRangeEvidence, type NarrativeMention } from '../common';

/**
 * The marker owner of this package (TASK-022 WP-5).
 *
 * ITS OWN OWNER, never shared. `ProblemManager.setMarkers(uri, owner, [])` is
 * how a publisher withdraws its own markers, and the withdrawal is scoped by
 * the owner string alone — so two publishers sharing one would delete each
 * other's problems. The editor already runs three distinct owners for this
 * reason (`ai-focused-editor.live`, `ai-focused-editor.consistency`,
 * `ai-focused-editor.workspace` — grep those strings); this is the fourth, and
 * the plan fixes it deliberately ("marker-owner диагностик" is in AD-5's
 * "зафиксировано намеренно" list).
 */
export const NARRATIVE_MEMORY_MARKER_OWNER = 'ai-focused-editor.narrativeMemory';

/** The `source` shown next to each problem in the Problems view. */
export const NARRATIVE_MEMORY_DIAGNOSTIC_SOURCE = 'narrative-memory';

/** One document's worth of markers, keyed by the URI they are published under. */
export interface NarrativeMarkerBatch {
  readonly uri: string;
  readonly diagnostics: Diagnostic[];
}

/**
 * Turn unresolved mentions into markers, grouped by document.
 *
 * WHAT AN UNRESOLVED MENTION IS: half (а) of the plan's "битые ссылки" row —
 * a reference IN PROSE whose target entity does not exist, i.e.
 * `mention.resolved === false`. Half (б), a broken end of a STRUCTURAL YAML
 * relation, is a different record with a different owner (WP-2's
 * `relation_broken`) and is deliberately not published here.
 *
 * THE URI IS DERIVED FROM THE RELATIVE PATH, NOT TAKEN FROM THE INDEX, and
 * that is a decision rather than a convenience. `EvidenceRef.path` is a
 * workspace-relative string by construction — the graph core may not import
 * `@theia/core`, so it cannot hold a URI at all — and this layer is the first
 * one that knows the workspace root. Resolving here also side-steps a live
 * defect: `entity.sourceUri` is NOT repaired when a file is renamed
 * (`moveDocument` fixes the denormalized `sourcePath` in both adapters and
 * leaves the URI pointing at the old location), so any navigation built on
 * that field sends the user to a file that no longer exists. Nothing in this
 * module reads it.
 *
 * A `whole-file` evidence gets a DIFFERENT MESSAGE, not a zeroed range with
 * the same one (ISS-320). The Problems view has no "whole file" affordance, so
 * the marker must sit at line 0 either way — but a marker that SAYS it has no
 * position is honest, whereas one that silently claims 0:0 is indistinguishable
 * from a real reference at the top of the file. Prose mentions carry ranges, so
 * this branch is not expected to fire today; it exists because the alternative
 * to handling it is fabricating coordinates.
 */
export function narrativeMarkerBatches(
  rootUri: string,
  mentions: readonly NarrativeMention[]
): NarrativeMarkerBatch[] {
  const root = new URI(rootUri);
  const byUri = new Map<string, Diagnostic[]>();

  for (const mention of mentions) {
    if (mention.resolved) {
      continue;
    }
    const uri = root.resolve(mention.evidence.path).toString();
    const name = mention.label ?? mention.raw;
    const range = isRangeEvidence(mention.evidence)
      ? mention.evidence.range
      : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const message = isRangeEvidence(mention.evidence)
      ? nls.localize(
          'ai-focused-editor/narrative-memory/diagnostic-broken-mention',
          'No entity named "{0}" is defined in this manuscript.',
          name
        )
      : nls.localize(
          'ai-focused-editor/narrative-memory/diagnostic-broken-mention-whole-file',
          'No entity named "{0}" is defined in this manuscript. The reference has no position, so this marker points at the start of the file.',
          name
        );

    const bucket = byUri.get(uri) ?? [];
    bucket.push({
      // WARNING, NOT ERROR. A reference to a character not yet written down is
      // an ordinary state of a manuscript in progress, and an error tone on it
      // teaches the author to ignore the Problems view.
      severity: DiagnosticSeverity.Warning,
      source: NARRATIVE_MEMORY_DIAGNOSTIC_SOURCE,
      message,
      range
    });
    byUri.set(uri, bucket);
  }

  return [...byUri.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics }));
}
