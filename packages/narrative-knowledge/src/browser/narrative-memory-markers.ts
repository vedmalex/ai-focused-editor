import { nls } from '@theia/core/lib/common/nls';
import URI from '@theia/core/lib/common/uri';
import {
  Diagnostic,
  DiagnosticSeverity
} from '@theia/core/shared/vscode-languageserver-protocol';
import {
  isRangeEvidence,
  isRelationBroken,
  type DuplicateEntityRecord,
  type NarrativeMention,
  type NarrativeRelation
} from '../common';

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
 *
 * ONE OWNER, THREE SOURCES. gh#46's "Commands and UX" asks for diagnostics on
 * both broken semantic links AND duplicate entity ids, and this file builds
 * markers for THREE defects under that one owner: an unresolved prose mention
 * ({@link narrativeMarkerBatches}), a structurally broken relation end —
 * `ownership.owner` naming an id no card defines, WP-2's `relation_broken`
 * ({@link narrativeRelationMarkerBatches}) — and a duplicated entity id
 * ({@link narrativeDuplicateEntityMarkerBatches}). They are three functions
 * rather than one, because each reads a different shape off the wire
 * (`NarrativeMention[]`, `NarrativeRelation[]`, `DuplicateEntityRecord[]`) and
 * each earned its own test suite for the same reason the mention one did; the
 * contribution combines their output with {@link mergeMarkerBatches} before
 * ever calling `setMarkers`, because that call REPLACES the whole set for a
 * (uri, owner) pair and three sequential calls for the same file would leave
 * only the last category on screen.
 */
export const NARRATIVE_MEMORY_MARKER_OWNER = 'ai-focused-editor.narrativeMemory';

/** The `source` shown next to each problem in the Problems view. */
export const NARRATIVE_MEMORY_DIAGNOSTIC_SOURCE = 'narrative-memory';

/** One document's worth of markers, keyed by the URI they are published under. */
export interface NarrativeMarkerBatch {
  readonly uri: string;
  readonly diagnostics: Diagnostic[];
}

/** The Problems view has no "whole file" affordance, so a fact with no
 *  computed position is pinned to the very start of the file — the same
 *  compromise every category below makes, and the reason each one says so in
 *  its own message rather than presenting 0:0 as a real coordinate (ISS-320). */
const WHOLE_FILE_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/**
 * Turn unresolved PROSE mentions into markers, grouped by document (source 1
 * of 3 — see the module note).
 *
 * THE URI IS DERIVED FROM THE RELATIVE PATH, NOT TAKEN FROM THE INDEX, and
 * that is a decision rather than a convenience, and it applies to every
 * function in this file. `EvidenceRef.path` is a workspace-relative string by
 * construction — the graph core may not import `@theia/core`, so it cannot
 * hold a URI at all — and this layer is the first one that knows the
 * workspace root. Resolving here also side-steps a live defect: `entity.sourceUri`
 * is NOT repaired when a file is renamed (`moveDocument` fixes the denormalized
 * `sourcePath` in both adapters and leaves the URI pointing at the old
 * location), so any navigation built on that field sends the user to a file
 * that no longer exists. Nothing in this module reads it.
 *
 * A `whole-file` evidence gets a DIFFERENT MESSAGE, not a zeroed range with
 * the same one (ISS-320). Prose mentions carry ranges, so this branch is not
 * expected to fire today; it exists because the alternative to handling it is
 * fabricating coordinates.
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
    const range = isRangeEvidence(mention.evidence) ? mention.evidence.range : WHOLE_FILE_RANGE;
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

/**
 * Turn broken STRUCTURAL relation ends into markers (source 2 of 3 — see the
 * module note). `ownership.owner` naming an id no card defines is the case the
 * plan names; any other relation source that can produce an unresolved end
 * (`isRelationBroken`) is covered the same way.
 *
 * THE MARKER SITS ON THE OWNING CARD, `relation.ownerPath` — never on the
 * unresolved end, which by definition has no card to put a marker on. This is
 * also where its EVIDENCE comes from: the entry in `relation.evidence` whose
 * `path` equals `ownerPath`, not `evidence[0]` blindly, because a relation
 * restated in a second document (a real case for co-occurrence, which is
 * never broken) could otherwise point this function at the wrong file.
 *
 * TWO THINGS BELOW ARE UNREACHABLE TODAY, GIVEN THE INVARIANTS THIS PACKAGE
 * ALREADY MAINTAINS, AND HANDLED BY SKIPPING RATHER THAN BY A NON-NULL
 * ASSERTION OR A CRASH:
 *
 *   - `ownerPath === undefined`. It is absent only for a `derived` relation
 *     (the schema's `CHECK (origin = 'derived' OR doc_id IS NOT NULL)`), and
 *     `foldCoOccurrenceRelations` builds every derived relation from mentions
 *     that already resolved — "у derived-рёбер `source_resolved`/
 *     `target_resolved` всегда 1". So `isRelationBroken(relation)` and
 *     `ownerPath === undefined` cannot both hold under any writer this
 *     package ships today.
 *   - No evidence entry at `ownerPath`. `extractCardRelations` always seeds
 *     `evidence` with `wholeFileEvidence(card.document.path)` — the same path
 *     as `ownerPath` — for every relation it produces.
 *
 * If a future writer breaks either invariant, skipping is still the honest
 * choice: there is no card the index can name for the marker, and guessing one
 * would be exactly the fabrication ISS-320 exists to forbid. It would also be a
 * silent loss of a real defect, which is why both branches are named here
 * rather than left as an unexplained early return.
 */
export function narrativeRelationMarkerBatches(
  rootUri: string,
  relations: readonly NarrativeRelation[]
): NarrativeMarkerBatch[] {
  const root = new URI(rootUri);
  const byUri = new Map<string, Diagnostic[]>();

  for (const relation of relations) {
    if (!isRelationBroken(relation) || relation.ownerPath === undefined) {
      continue;
    }
    const ownerEvidence = relation.evidence.find(item => item.path === relation.ownerPath);
    if (ownerEvidence === undefined) {
      continue;
    }
    const uri = root.resolve(relation.ownerPath).toString();
    // The id AT THE CENTRE of the finding is the UNRESOLVED one; when both
    // ends are unresolved, the target is reported — for `ownership`, that is
    // `ownership.owner`, the field an author is most likely to have mistyped.
    // Mirrors `NarrativeIndexSession`'s own `collectFindings`
    // (`narrative-index-session.ts`): only the source-only-broken case reports
    // `sourceId`; target-only-broken AND both-broken both report `targetId`.
    const brokenId =
      !relation.sourceResolved && relation.targetResolved ? relation.sourceId : relation.targetId;
    const range = isRangeEvidence(ownerEvidence) ? ownerEvidence.range : WHOLE_FILE_RANGE;
    const message = isRangeEvidence(ownerEvidence)
      ? nls.localize(
          'ai-focused-editor/narrative-memory/diagnostic-broken-relation',
          'The "{0}" relation names an entity "{1}" that is not defined in this manuscript.',
          relation.relType,
          brokenId
        )
      : nls.localize(
          'ai-focused-editor/narrative-memory/diagnostic-broken-relation-whole-file',
          'The "{0}" relation names an entity "{1}" that is not defined in this manuscript. The reference has no position, so this marker points at the start of the file.',
          relation.relType,
          brokenId
        );

    const bucket = byUri.get(uri) ?? [];
    bucket.push({
      // WARNING, for the same reason as every other category here: a broken
      // structural link is an ordinary state of a manuscript in progress.
      severity: DiagnosticSeverity.Warning,
      source: NARRATIVE_MEMORY_DIAGNOSTIC_SOURCE,
      message,
      range
    });
    byUri.set(uri, bucket);
  }

  return [...byUri.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics }));
}

/**
 * Turn duplicated entity ids into markers, ONE PER EXCLUDED CARD (source 3 of
 * 3 — see the module note).
 *
 * NEVER ON THE WINNING CARD. This mirrors `NarrativeIndexSession`'s own
 * `collectFindings` (`narrative-index-session.ts`), which made the identical
 * choice for the identical defect in `getContextForDocument`'s findings, and
 * for the identical reason stated there: "pointing at the winner would send
 * them to the one that is already in effect". The winning card is exactly
 * right as written; there is nothing on it for the author to fix. The
 * EXCLUDED card is where the actionable defect lives, and its own message
 * names the file that currently wins — so an author who lands on the losing
 * card, which is the only place a marker exists, still sees both sides of the
 * conflict without a second marker on the file that has nothing wrong with it.
 *
 * This is a considered departure from having a marker on every claimant: two
 * publishers of the same package disagreeing about where one defect lives —
 * `getContextForDocument` naming only the loser, this file naming both — would
 * be a worse outcome than either choice made once and kept.
 *
 * ALWAYS WHOLE-FILE. `DuplicateEntityRecord` carries only `keptRelPath` and
 * `excludedRelPaths` — plain paths, never an `EvidenceRef` — so there is no
 * range to report even in principle, and no dual-message branch is needed the
 * way the other two categories need one.
 */
export function narrativeDuplicateEntityMarkerBatches(
  rootUri: string,
  duplicates: readonly DuplicateEntityRecord[]
): NarrativeMarkerBatch[] {
  const root = new URI(rootUri);
  const byUri = new Map<string, Diagnostic[]>();

  for (const duplicate of duplicates) {
    for (const excludedRelPath of duplicate.excludedRelPaths) {
      const uri = root.resolve(excludedRelPath).toString();
      const bucket = byUri.get(uri) ?? [];
      bucket.push({
        severity: DiagnosticSeverity.Warning,
        source: NARRATIVE_MEMORY_DIAGNOSTIC_SOURCE,
        message: nls.localize(
          'ai-focused-editor/narrative-memory/diagnostic-duplicate-entity',
          'Entity id "{0}" is defined by more than one card. The definition in effect is in "{1}". This card\'s definition is not used until the id is made unique.',
          duplicate.entityId,
          duplicate.keptRelPath
        ),
        range: WHOLE_FILE_RANGE
      });
      byUri.set(uri, bucket);
    }
  }

  return [...byUri.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics }));
}

/**
 * Combine several categories' batches into one per URI.
 *
 * THE REASON THIS EXISTS AT ALL: `ProblemManager.setMarkers(uri, owner,
 * diagnostics)` REPLACES the whole diagnostic set for that (uri, owner) pair —
 * it is not additive. This package now publishes markers from three
 * independent sources under ONE owner (see the module note), so calling
 * `setMarkers` once per source for the same file would leave only the LAST
 * call's diagnostics visible, silently discarding the other two categories'
 * findings for that document. Every caller MUST merge before publishing, and
 * this is the one place that merge is computed, so a fourth category added
 * later goes through it too rather than re-deriving the same fix inline in the
 * contribution.
 */
export function mergeMarkerBatches(
  ...batchLists: readonly (readonly NarrativeMarkerBatch[])[]
): NarrativeMarkerBatch[] {
  const byUri = new Map<string, Diagnostic[]>();
  for (const batches of batchLists) {
    for (const batch of batches) {
      const bucket = byUri.get(batch.uri) ?? [];
      bucket.push(...batch.diagnostics);
      byUri.set(batch.uri, bucket);
    }
  }
  return [...byUri.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics }));
}
