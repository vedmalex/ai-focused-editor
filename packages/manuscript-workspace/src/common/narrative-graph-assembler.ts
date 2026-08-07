/**
 * Pure assembly of a {@link NarrativeGraphSnapshot} from narrative-knowledge
 * index primitives (TASK-022 WP-7, tech_spec TECH_SPEC WP-7 §7).
 *
 * WHY THIS FILE IS THEIA-FREE. `NodeNarrativeGraphService` (the one caller
 * today) reads the manuscript through `NarrativeKnowledgeService`
 * (`@ai-focused-editor/narrative-knowledge`) instead of scanning `entities/**`
 * and calling `parseSemanticMarkdown` itself — that migration is the whole
 * point of this file, and it is what closes readiness check #5 ("no
 * independent FS scan") for the Narrative Map consumer. Everything BELOW the
 * fetch — turning entities/mentions/relations into the exact shape
 * `narrative-map-widget.ts` renders — is a fold over already-fetched plain
 * data, so it is written the same way `foldCoOccurrenceRelations` is: no
 * filesystem, no URI construction, no Theia, no clock. That is what lets it be
 * exercised directly by a fixture-fed unit test, the same technique the sibling
 * package uses for its own bun-only lane.
 *
 * WHY IT DOES NOT USE `getRelations({origin:'derived', relType:'co-occurrence'})`
 * FOR NODES/EDGES, DEVIATING FROM THE §7 SKETCH. `foldCoOccurrenceRelations`
 * (narrative-knowledge/graph) folds ONLY resolved mentions — tech_spec ОВ-1's
 * own invariant is that a derived edge is resolved on both ends. But the OLD
 * Narrative Map graph, which `narrative-consumer-baseline.test.ts` pins, draws
 * a node/edge for EVERY LABELLED semantic tag, resolved or not — that is the
 * whole reason a bare Cyrillic `[[персонаж:krishna|Кришна]]` tag (unresolved:
 * `персонаж` is not a registered tag spelling of `character`) still gets its
 * own node and its own co-occurrence edges in the baseline. Reusing the
 * pre-materialized derived relations would silently DROP every such node and
 * edge. This module instead folds co-occurrence itself from the SAME
 * per-chapter, label-filtered mentions it already needs for the timeline —
 * mirroring `NodeNarrativeGraphService`'s pre-migration algorithm exactly, just
 * sourcing mentions from the index instead of `parseSemanticMarkdown`.
 *
 * `sharedChapters` STAYS POSITIONAL (`'0'`, `'1'`, …), NOT
 * `relation.evidence.map(e => e.path)` as the §7 sketch also floated: nothing
 * outside this package's own protocol type reads the field (verified by grep,
 * `narrative-graph-protocol.ts:74` is its only production reference besides
 * this file and `node-narrative-graph-service.ts`), so there is no consumer to
 * satisfy by changing format, and the position is cheaper to reproduce than a
 * synthesized evidence array would be. The position counts only PRESENT
 * chapters — a manifest chapter with no indexed document contributes no index
 * to this sequence, exactly as the pre-migration algorithm's `continue` before
 * `chapterEntitySets.push` did.
 */

import {
  compareEntitiesForDisplay,
  isRangeEvidence,
  NARRATIVE_TOOL_COLLATION_LOCALE,
  type ManifestProblem,
  type NarrativeEntity,
  type NarrativeMention,
  type NarrativeOrigin,
  type NarrativeRelation
} from '@ai-focused-editor/narrative-knowledge';
import {
  NARRATIVE_GRAPH_NODE_CAP,
  type NarrativeEntityAppearance,
  type NarrativeGraphSnapshot,
  type NarrativeOwnershipEntry,
  type NarrativeOwnershipTransfer,
  type NarrativeRelationEdge,
  type NarrativeRelationNode,
  type NarrativeTimelineChapter
} from './narrative-graph-protocol';
import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';

/** One manifest-and-index-agreed chapter, with its already-fetched mentions. */
export interface NarrativeGraphChapterInput {
  /** Workspace-relative path. */
  path: string;
  title: string;
  /** Position in the FULL manifest walk (gaps where a chapter is missing). */
  order: number;
  buildIncluded: boolean;
  /** `getMentions(rootUri, { relPath: path })`'s result, unfiltered. */
  mentions: readonly NarrativeMention[];
}

export interface AssembleNarrativeGraphSnapshotInput {
  rootUri?: string;
  manifestPresent: boolean;
  /** `ManifestProblem[]` from `getManifestChapters` — malformed manifest only. */
  manifestProblems: readonly ManifestProblem[];
  /** Manifest-listed chapters WITH a matching indexed document, in manifest order. */
  presentChapters: readonly NarrativeGraphChapterInput[];
  /** Manifest-listed chapter paths with NO matching indexed document, in manifest order. */
  missingChapterPaths: readonly string[];
  /** `findEntities(rootUri)`'s result — id is unique across the whole index
   *  (`buildEntityCatalog` dedupes by id alone), so a flat map is lossless. */
  entities: readonly NarrativeEntity[];
  /**
   * `getRelations(rootUri, { relType: <ownership> })`'s result, ALL origins
   * (TASK-022 UR-044/UR-026). Previously the caller filtered this to
   * `origin: 'explicit'` only, which silently discarded every `ai-candidate`
   * ownership hop from EVERY consumer of this module — including the
   * Narrative Map, whose whole point is to make agent-proposed vs
   * author-confirmed knowledge visually distinguishable. `buildOwnership`
   * and the authored-edge builder below both read `relation.origin` per row
   * rather than assuming `explicit`.
   */
  ownershipRelations: readonly NarrativeRelation[];
  /**
   * Builds a navigable URI for a workspace-relative path, when the caller can.
   *
   * OPTIONAL, AND THE ONLY PLACE A URI EVER ENTERS THIS MODULE: constructing
   * one needs `FileUri`/`@theia/core`, which this file may not import (see the
   * module note). `NodeNarrativeGraphService`, which already imports `FileUri`
   * for its own `rootUri` field, supplies this; a caller that cannot (or a
   * test) simply omits it and gets diagnostics without a `uri`.
   */
  toUri?: (relPath: string) => string | undefined;
}

const DIAGNOSTIC_SOURCE = 'narrative-graph';

/** Order two graph nodes/appearances the way a reader expects (standing rule:
 *  `Intl.Collator` with an explicit locale, never a bare `localeCompare()`). */
function compareByLabel(left: { entityId: string; label: string }, right: { entityId: string; label: string }): number {
  return compareEntitiesForDisplay(
    { id: left.entityId, name: left.label },
    { id: right.entityId, name: right.label }
  );
}

const edgeLabelCollator = new Intl.Collator(NARRATIVE_TOOL_COLLATION_LOCALE, {
  numeric: true,
  sensitivity: 'variant'
});

/** Assemble a {@link NarrativeGraphSnapshot} from already-fetched index data. */
export function assembleNarrativeGraphSnapshot(
  input: AssembleNarrativeGraphSnapshotInput
): NarrativeGraphSnapshot {
  const diagnostics: WorkspaceDiagnostic[] = [];
  const uriField = (relPath: string): { uri: string } | Record<string, never> => {
    const uri = input.toUri?.(relPath);
    return uri !== undefined ? { uri } : {};
  };

  if (!input.manifestPresent) {
    diagnostics.push({
      severity: 'warning',
      source: DIAGNOSTIC_SOURCE,
      message: 'Missing manifest.yaml; the timeline needs a manifest to order chapters.',
      ...uriField('manifest.yaml')
    });
  } else {
    for (const problem of input.manifestProblems) {
      diagnostics.push({
        severity: problem.code === 'invalid-yaml' ? 'error' : 'warning',
        source: DIAGNOSTIC_SOURCE,
        message: problem.message,
        ...uriField('manifest.yaml')
      });
    }
  }

  for (const path of input.missingChapterPaths) {
    diagnostics.push({
      severity: 'warning',
      source: DIAGNOSTIC_SOURCE,
      message: `Skipping missing chapter file: ${path}`,
      ...uriField(path)
    });
  }

  const entityById = new Map(input.entities.map(entity => [entity.id, entity]));

  const timeline: NarrativeTimelineChapter[] = [];
  /** Per-PRESENT-chapter entity key sets, positionally indexed — the index IS
   *  `sharedChapters`' unit, and it counts only chapters actually processed. */
  const chapterEntitySets: Set<string>[] = [];
  const nodeTotals = new Map<string, NarrativeRelationNode>();

  for (const chapter of input.presentChapters) {
    const counts = new Map<string, NarrativeEntityAppearance>();
    for (const mention of chapter.mentions) {
      // Only prose, labelled tags count (tech_spec TECH_SPEC WP-7 §7.3): a
      // structural/front-matter mention has no range, and the bare `[[id]]`
      // form has no label — both are invisible to the graph, matching the
      // pre-migration `parseSemanticMarkdown(text).tags` reader exactly.
      if (!isRangeEvidence(mention.evidence) || mention.label === undefined) {
        continue;
      }
      const resolvedEntity = mention.resolved ? entityById.get(mention.entityId) : undefined;
      const kind = resolvedEntity !== undefined ? resolvedEntity.type : (mention.kind ?? '');
      const label = resolvedEntity !== undefined ? resolvedEntity.name : mention.label;
      const key = `${kind}:${mention.entityId}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { kind, id: mention.entityId, label, count: 1 });
      }
    }

    const entities = [...counts.values()].sort((left, right) =>
      right.count - left.count || compareByLabel({ entityId: left.id, label: left.label }, { entityId: right.id, label: right.label }));
    timeline.push({
      path: chapter.path,
      title: chapter.title,
      order: chapter.order,
      buildIncluded: chapter.buildIncluded,
      entities
    });

    chapterEntitySets.push(new Set(counts.keys()));
    for (const [key, appearance] of counts) {
      const node = nodeTotals.get(key);
      if (node) {
        node.appearances += appearance.count;
      } else {
        nodeTotals.set(key, {
          id: key,
          kind: appearance.kind,
          entityId: appearance.id,
          label: appearance.label,
          appearances: appearance.count
        });
      }
    }
  }

  const ownership = buildOwnership(input.ownershipRelations, entityById);
  const { nodes, relations, truncated, totalEntities } = buildRelations(nodeTotals, chapterEntitySets);
  const { authoredEdges, authoredNodes } = buildAuthoredGraph(
    input.ownershipRelations,
    entityById,
    new Set(nodes.map(node => node.id))
  );

  return {
    ...(input.rootUri !== undefined ? { rootUri: input.rootUri } : {}),
    timeline,
    ownership,
    nodes,
    relations,
    authoredEdges,
    authoredNodes,
    truncated,
    totalEntities,
    diagnostics
  };
}

/** Narrow a relation's origin to the two values an ownership relation may
 *  actually carry, dropping anything else (defensive: `derived` is produced
 *  exclusively by THIS module's own co-occurrence fold, never by a stored
 *  ownership row — WP-8 cards only ever write `explicit` or `ai-candidate` —
 *  but nothing enforces that at the type level once the origin filter is
 *  gone, so a stray row is skipped rather than mis-labelled). */
function authoredOrigin(origin: NarrativeOrigin): 'explicit' | 'ai-candidate' | undefined {
  return origin === 'explicit' || origin === 'ai-candidate' ? origin : undefined;
}

/**
 * Ownership chains (tech_spec TECH_SPEC WP-7 §7.4): group by `sourceId` (the
 * artifact card that owns the relation), keep list order via `listPosition`.
 *
 * ALL AUTHORED ORIGINS, NOT JUST `explicit` (TASK-022 UR-044/UR-026 — this
 * used to be scoped to `explicit` by the caller's query, which made every
 * `ai-candidate` ownership hop invisible here; the caller now passes every
 * origin and this function classifies per row instead). A candidate entry is
 * INCLUDED, tagged `origin: 'ai-candidate'` on its {@link NarrativeOwnershipEntry}
 * — UR-026's "разделение труда агент/автор" requires it be shown, distinctly
 * from a confirmed hop, rather than either dropped or silently conflated.
 *
 * TRANSFER ORDER ACROSS ARTIFACTS IS THE ONE THING THIS FIXTURE CANNOT PIN — it
 * seeds exactly one artifact. Sorted by `artifactId` (code point) for a
 * deterministic, reproducible answer; this is a chosen convention, not a
 * verified one.
 */
function buildOwnership(
  relations: readonly NarrativeRelation[],
  entityById: ReadonlyMap<string, NarrativeEntity>
): NarrativeOwnershipTransfer[] {
  const bySource = new Map<string, NarrativeRelation[]>();
  for (const relation of relations) {
    if (authoredOrigin(relation.origin) === undefined) {
      continue;
    }
    const list = bySource.get(relation.sourceId) ?? [];
    list.push(relation);
    bySource.set(relation.sourceId, list);
  }

  const transfers: NarrativeOwnershipTransfer[] = [];
  for (const [artifactId, artifactRelations] of bySource) {
    const artifactEntity = entityById.get(artifactId);
    const ordered = [...artifactRelations].sort((left, right) =>
      (left.listPosition ?? 0) - (right.listPosition ?? 0));
    const entries: NarrativeOwnershipEntry[] = ordered.map(relation => {
      const ownerEntity = relation.targetResolved ? entityById.get(relation.targetId) : undefined;
      const entry: NarrativeOwnershipEntry = {
        owner: relation.targetId,
        ownerLabel: ownerEntity?.name ?? relation.targetId,
        // Filtered to authoredOrigin() !== undefined above.
        origin: authoredOrigin(relation.origin)!
      };
      if (relation.storyTimeFrom !== undefined) {
        entry.from = relation.storyTimeFrom;
      }
      if (relation.storyTimeTo !== undefined) {
        entry.to = relation.storyTimeTo;
      }
      if (relation.note !== undefined) {
        entry.note = relation.note;
      }
      return entry;
    });
    if (entries.length === 0) {
      continue;
    }
    transfers.push({
      artifactId,
      artifactLabel: artifactEntity?.name ?? artifactId,
      path: artifactEntity?.sourcePath ?? '',
      entries
    });
  }

  return transfers.sort((left, right) => (left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0));
}

/** Build co-occurrence nodes/edges, capped at the top NARRATIVE_GRAPH_NODE_CAP
 *  by appearances — byte-identical algorithm to the pre-migration
 *  `NodeNarrativeGraphService.buildRelations`, folding the SAME per-chapter
 *  entity key sets this module already built for the timeline. */
function buildRelations(
  nodeTotals: Map<string, NarrativeRelationNode>,
  chapterEntitySets: Set<string>[]
): {
  nodes: NarrativeRelationNode[];
  relations: NarrativeRelationEdge[];
  truncated: boolean;
  totalEntities: number;
} {
  const ranked = [...nodeTotals.values()].sort((left, right) =>
    right.appearances - left.appearances || compareByLabel(left, right));
  const totalEntities = ranked.length;
  const truncated = totalEntities > NARRATIVE_GRAPH_NODE_CAP;
  const nodes = ranked.slice(0, NARRATIVE_GRAPH_NODE_CAP);
  const kept = new Set(nodes.map(node => node.id));

  // Accumulate shared chapters per unordered entity pair. The pairing order
  // (which composite key becomes `source` vs `target`) is a plain code-point
  // sort — internal bookkeeping, not the user-visible label order below — kept
  // identical to the pre-migration algorithm so `source`/`target` assignment
  // does not shift.
  const edges = new Map<string, NarrativeRelationEdge>();
  for (const [chapterIndex, entitySet] of chapterEntitySets.entries()) {
    const keys = [...entitySet].filter(key => kept.has(key)).sort();
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const source = keys[i];
        const target = keys[j];
        const edgeKey = `${source}|${target}`;
        const edge = edges.get(edgeKey);
        if (edge) {
          edge.weight += 1;
          edge.sharedChapters.push(String(chapterIndex));
        } else {
          edges.set(edgeKey, {
            source,
            target,
            sourceLabel: nodeTotals.get(source)!.label,
            targetLabel: nodeTotals.get(target)!.label,
            weight: 1,
            sharedChapters: [String(chapterIndex)],
            origin: 'derived'
          });
        }
      }
    }
  }

  const relations = [...edges.values()].sort((left, right) =>
    right.weight - left.weight
    || edgeLabelCollator.compare(left.sourceLabel, right.sourceLabel)
    || edgeLabelCollator.compare(left.targetLabel, right.targetLabel));

  return { nodes, relations, truncated, totalEntities };
}

/** Resolve one relation end (an entity id) to the graph's composite node key
 *  and a display label, the same fallback `buildOwnership` already uses for
 *  an id with no card: raw id as both the label and (with an empty `kind`)
 *  the key prefix. */
function resolveGraphEnd(
  id: string,
  entityById: ReadonlyMap<string, NarrativeEntity>
): { key: string; kind: string; entityId: string; label: string } {
  const entity = entityById.get(id);
  const kind = entity?.type ?? '';
  return { key: `${kind}:${id}`, kind, entityId: id, label: entity?.name ?? id };
}

/**
 * Build the Narrative Map's authored (ownership) graph edges/nodes (TASK-022
 * UR-044/UR-026) — a SEPARATE fold over the same `relations` `buildOwnership`
 * reads, because the two outputs serve different consumers (the ownership
 * TEXT chain vs. this package's graph) and, per `NarrativeGraphSnapshot
 * .authoredEdges`'s doc comment, must never be merged into `relations` itself.
 *
 * ONE EDGE PER RELATION ROW, star-shaped from the artifact (`sourceId`) to
 * each owner (`targetId`) — matching the data as stored, not a reconstructed
 * owner-to-owner sequence. `NarrativeRelation` only ever records
 * artifact-owns-owner; inventing a chronological owner-to-owner edge would be
 * presenting a relationship the index does not have (the boundary this task
 * draws: representation only, no new data).
 *
 * NODE UNION, CO-OCCURRENCE WINS: `presentNodeIds` (the FINAL, already
 * truncated `nodes` list) is checked first, so an entity that already has a
 * ring position from co-occurrence never gets a second, duplicate node here —
 * only an end absent from `nodes` (never mentioned in chapter prose, e.g. a
 * mythic prior owner with a card but no `[[character:id|label]]` tag
 * anywhere) gets a synthesized `authoredNodes` entry.
 */
function buildAuthoredGraph(
  relations: readonly NarrativeRelation[],
  entityById: ReadonlyMap<string, NarrativeEntity>,
  presentNodeIds: ReadonlySet<string>
): {
  authoredEdges: NarrativeRelationEdge[];
  authoredNodes: NarrativeRelationNode[];
} {
  const authoredEdges: NarrativeRelationEdge[] = [];
  const authoredNodeByKey = new Map<string, NarrativeRelationNode>();

  for (const relation of relations) {
    const origin = authoredOrigin(relation.origin);
    if (origin === undefined) {
      continue;
    }
    const source = resolveGraphEnd(relation.sourceId, entityById);
    const target = resolveGraphEnd(relation.targetId, entityById);
    authoredEdges.push({
      source: source.key,
      target: target.key,
      sourceLabel: source.label,
      targetLabel: target.label,
      weight: 1,
      sharedChapters: [],
      origin,
      relType: relation.relType
    });
    for (const end of [source, target]) {
      if (presentNodeIds.has(end.key) || authoredNodeByKey.has(end.key)) {
        continue;
      }
      authoredNodeByKey.set(end.key, {
        id: end.key,
        kind: end.kind,
        entityId: end.entityId,
        label: end.label,
        appearances: 0
      });
    }
  }

  authoredEdges.sort((left, right) =>
    edgeLabelCollator.compare(left.sourceLabel, right.sourceLabel)
    || edgeLabelCollator.compare(left.targetLabel, right.targetLabel)
    || (left.origin ?? '').localeCompare(right.origin ?? ''));
  const authoredNodes = [...authoredNodeByKey.values()].sort(compareByLabel);

  return { authoredEdges, authoredNodes };
}
