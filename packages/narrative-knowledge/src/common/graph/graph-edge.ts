/**
 * The graph core's edge type (AD-6 / UR-029, TASK-022 WP-0).
 *
 * See `graph-node.ts` for the boundary rule this folder lives under. The same
 * consequence applies: ends are identified by plain `string`, never `URI`.
 */

import type { NarrativeGraphNode } from './graph-node';
import { graphNodeKey } from './graph-node';

/**
 * One directed edge of the narrative graph.
 *
 * Direction is STORED, not derived: (`source`, `target`) is an ORDERED pair.
 * Whether a given `relType` is semantically symmetric is a property of the
 * relation-type registry (gh#57), not of this type.
 *
 * `relType` is an OPAQUE string. Neither the core nor the index validates it
 * against a vocabulary — that is a separate layer (gh#57). It DOES take part
 * in edge identity: two edges between the same ends with different `relType`
 * are two edges.
 */
export interface NarrativeGraphEdge {
  /** The end the relation points FROM. */
  source: NarrativeGraphNode;
  /** The end the relation points TO. */
  target: NarrativeGraphNode;
  /** Opaque relation-type discriminator. Part of edge identity. */
  relType: string;
}

/**
 * Identity key of an edge: ordered ends plus `relType`. Two edges sharing the
 * same ends but carrying different `relType` values produce different keys —
 * they are two distinct edges, which is the contract WP-1 pins for
 * `NarrativeRelation`.
 */
export function graphEdgeKey(edge: NarrativeGraphEdge): string {
  return `${graphNodeKey(edge.source)}${edge.relType}${graphNodeKey(edge.target)}`;
}
