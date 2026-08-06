import type { NarrativeOrigin } from '@ai-focused-editor/narrative-knowledge';
import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';

export const NarrativeGraphService = Symbol('NarrativeGraphService');
export const NarrativeGraphBackendService = Symbol('NarrativeGraphBackendService');
export const NarrativeGraphBackendServicePath = '/services/ai-focused-editor/narrative-graph';

/** How many entities the relation graph renders before it truncates (spec §5.2). */
export const NARRATIVE_GRAPH_NODE_CAP = 20;

/** One entity's appearance tally inside a single chapter. */
export interface NarrativeEntityAppearance {
  /** Normalized entity kind: character | term | artifact | location (or the raw tag kind). */
  kind: string;
  /** Entity id as written in the semantic tag (`[[kind:id|label]]`). */
  id: string;
  /** Display label resolved from the entity YAML card, else the tag label, else the id. */
  label: string;
  /** Number of semantic tags for this entity in the chapter. */
  count: number;
}

/** A chapter row in the timeline, in manifest content order. */
export interface NarrativeTimelineChapter {
  path: string;
  title: string;
  /** Zero-based position in manifest content order. */
  order: number;
  /** False when the chapter (or an ancestor) is `include: false` in the manifest. */
  buildIncluded: boolean;
  entities: NarrativeEntityAppearance[];
}

/** A single hop in an artifact's ownership chain (chronology follows list order). */
export interface NarrativeOwnershipEntry {
  /** Owner entity id as written in the YAML card. */
  owner: string;
  /** Owner label resolved from entity cards, else the raw owner id. */
  ownerLabel: string;
  /** Freeform story-time label for when this owner acquired the artifact. */
  from?: string;
  /** Freeform story-time label for when this owner relinquished the artifact. */
  to?: string;
  note?: string;
  /**
   * TASK-022 UR-044/UR-026: `explicit` (the author wrote this hop) or
   * `ai-candidate` (an agent proposed it; the author has not accepted or
   * rejected it yet) — an ownership relation is never `derived`, so those are
   * the only two values this ever takes. Every consumer of the ownership
   * chain (this list, and the graph edges in {@link NarrativeGraphSnapshot.authoredEdges})
   * must show the distinction rather than silently treating a candidate as
   * confirmed (UR-026's "разделение труда агент/автор").
   */
  origin: 'explicit' | 'ai-candidate';
}

/** Ownership/transfer history for one artifact card. */
export interface NarrativeOwnershipTransfer {
  artifactId: string;
  artifactLabel: string;
  path: string;
  entries: NarrativeOwnershipEntry[];
}

/** A node in the co-occurrence relation graph. */
export interface NarrativeRelationNode {
  /** Composite key `${kind}:${entityId}` — matches edge source/target. */
  id: string;
  kind: string;
  entityId: string;
  label: string;
  /** Total semantic-tag appearances across all chapters (ranking metric). */
  appearances: number;
}

/** A co-occurrence edge between two entities sharing chapters, OR (in
 *  {@link NarrativeGraphSnapshot.authoredEdges}) an authored ownership hop.
 *  The two uses share a shape because both are lines drawn between two graph
 *  nodes, but they are never mixed into the same array (see `authoredEdges`'s
 *  own doc comment for why). */
export interface NarrativeRelationEdge {
  /** Composite node key `${kind}:${entityId}`. */
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  /** Number of chapters both entities appear in. Fixed at `1` for an authored
   *  (ownership) edge — chapter overlap does not apply to it. */
  weight: number;
  /** Empty for an authored (ownership) edge — it has no chapter basis. */
  sharedChapters: string[];
  /**
   * TASK-022 UR-044/UR-026: this edge's provenance, for the Narrative Map's
   * visual distinction between authorial and machine-derived connections.
   * `relations` entries are always `derived` (co-occurrence, folded by this
   * package, never authored); `authoredEdges` entries are always `explicit`
   * or `ai-candidate`. Optional so existing `relations`-only construction
   * sites/fixtures (predating this field) stay valid; a reader that cares
   * defaults an absent value to `derived`.
   */
  origin?: NarrativeOrigin;
  /** Present only on an `authoredEdges` entry — the underlying relation type
   *  (e.g. `ownership`), so the UI can label the edge instead of guessing. */
  relType?: string;
}

export interface NarrativeGraphSnapshot {
  rootUri?: string;
  timeline: NarrativeTimelineChapter[];
  ownership: NarrativeOwnershipTransfer[];
  nodes: NarrativeRelationNode[];
  relations: NarrativeRelationEdge[];
  /**
   * TASK-022 UR-044/UR-026: authored (non-co-occurrence) graph edges —
   * ownership hops with `origin` `explicit` or `ai-candidate`. Kept SEPARATE
   * from `relations` on purpose: `relations-map.ts` (the Excalidraw "Generate
   * Relations Map" exporter) reads `relations`/`nodes` unconditionally, and
   * folding ownership edges into that array would silently change that
   * UNRELATED feature's export with no test asserting the new shape. Only the
   * Narrative Map widget reads this field. Optional for the same reason
   * `origin` above is optional — snapshot literals built before this field
   * existed (`relations-map.test.ts`) stay valid; absent means "none computed
   * for this snapshot", not "none exist".
   */
  authoredEdges?: NarrativeRelationEdge[];
  /**
   * Nodes referenced ONLY by `authoredEdges` — an owner/artifact entity with
   * a card but no chapter-prose mention (the real sample-book case: a prior
   * owner named in an artifact's YAML `ownership:` list who is never tagged
   * `[[character:id|label]]` in the text, so {@link nodes} never sees it).
   * `appearances` is always `0` here — there is nothing to tally. Never
   * duplicates an id already present in `nodes`; the co-occurrence node wins
   * when an entity is reachable both ways.
   */
  authoredNodes?: NarrativeRelationNode[];
  /** True when the node list was capped at NARRATIVE_GRAPH_NODE_CAP. */
  truncated: boolean;
  /** Total number of distinct entities before truncation. */
  totalEntities: number;
  diagnostics: WorkspaceDiagnostic[];
}

/** Frontend-facing service; resolves the workspace root before delegating. */
export interface NarrativeGraphService {
  getSnapshot(): Promise<NarrativeGraphSnapshot>;
  refresh(): Promise<NarrativeGraphSnapshot>;
}

/** Backend service reached over RPC. */
export interface NarrativeGraphBackendService {
  getSnapshot(rootUri?: string): Promise<NarrativeGraphSnapshot>;
  refresh(rootUri?: string): Promise<NarrativeGraphSnapshot>;
}
