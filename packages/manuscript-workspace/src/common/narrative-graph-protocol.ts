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

/** A co-occurrence edge between two entities sharing chapters. */
export interface NarrativeRelationEdge {
  /** Composite node key `${kind}:${entityId}`. */
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  /** Number of chapters both entities appear in. */
  weight: number;
  sharedChapters: string[];
}

export interface NarrativeGraphSnapshot {
  rootUri?: string;
  timeline: NarrativeTimelineChapter[];
  ownership: NarrativeOwnershipTransfer[];
  nodes: NarrativeRelationNode[];
  relations: NarrativeRelationEdge[];
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
