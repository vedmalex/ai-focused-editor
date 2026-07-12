/**
 * Pure, framework-free builder for the "entity relations map" that is rendered
 * into an `.excalidraw` scene (see `browser/relations-map-contribution.ts`).
 *
 * Like `common/excalidraw-canvas-ops`, this module is deliberately Theia- AND
 * Excalidraw-free: it takes a {@link NarrativeGraphSnapshot} and returns plain
 * DATA describing where each entity node sits and which nodes an edge connects.
 * The browser contribution turns that data into real Excalidraw elements via
 * `convertToExcalidrawElements` and merges it into the file. Keeping the layout,
 * the stable-id scheme, the `afe-entity://` link scheme, and the manual-layout
 * -preserving merge here makes all of it unit-testable without a DOM.
 */

import { ENTITY_KIND_IDS } from './entity-type-registry';
import { boundingBox, centerOf, type CanvasElement, type Point } from './excalidraw-canvas-ops';
import type { NarrativeGraphSnapshot } from './narrative-graph-protocol';

/** URI scheme used for the `element.link` of a map node so a click can navigate to the entity. */
export const AFE_ENTITY_LINK_SCHEME = 'afe-entity://';

/** Prefix of every generated map-node element id (used to detect map nodes on re-generation). */
export const MAP_NODE_ID_PREFIX = 'afe-map-node-';

/** Prefix of every generated map-edge element id. */
export const MAP_EDGE_ID_PREFIX = 'afe-map-edge-';

/** Parsed form of an {@link AFE_ENTITY_LINK_SCHEME} link. */
export interface ParsedEntityLink {
  kind: string;
  id: string;
}

/**
 * Build the navigable link stored on a map node's `element.link`:
 * `afe-entity://<kind>/<id>`. Both components are percent-encoded so ids/kinds
 * with reserved characters round-trip through {@link parseEntityLink}.
 */
export function buildEntityLink(kind: string, id: string): string {
  return `${AFE_ENTITY_LINK_SCHEME}${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

/**
 * Parse an {@link AFE_ENTITY_LINK_SCHEME} link back into `{ kind, id }`, or
 * `undefined` for anything that is not one of our entity links (external URLs,
 * `mailto:`, a blank/relative path, …). Tolerates percent-encoding on both
 * components; a malformed escape falls back to the raw segment rather than
 * throwing, so a click never explodes.
 */
export function parseEntityLink(url: string | null | undefined): ParsedEntityLink | undefined {
  if (typeof url !== 'string' || !url.startsWith(AFE_ENTITY_LINK_SCHEME)) {
    return undefined;
  }
  const rest = url.slice(AFE_ENTITY_LINK_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) {
    return undefined;
  }
  const kind = safeDecode(rest.slice(0, slash));
  const id = safeDecode(rest.slice(slash + 1));
  if (!kind || !id) {
    return undefined;
  }
  return { kind, id };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Collapse any run of non-alphanumeric characters into a single `-` for a stable, JSON-safe id. */
function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Deterministic, stable element id for a node given its composite entity key
 * (`kind:entityId`): e.g. `character:john` → `afe-map-node-character-john`. The
 * id is stable across regenerations so the merge can tell existing nodes from
 * new ones and never duplicates a node.
 */
export function mapNodeElementId(key: string): string {
  return `${MAP_NODE_ID_PREFIX}${sanitizeIdPart(key)}`;
}

/**
 * Deterministic, stable element id for an edge between two composite entity
 * keys. The two sides are sanitized independently and joined with `__` so the
 * separator can never collide with a sanitized key (which never contains `__`).
 */
export function mapEdgeElementId(source: string, target: string): string {
  return `${MAP_EDGE_ID_PREFIX}${sanitizeIdPart(source)}__${sanitizeIdPart(target)}`;
}

/** A positioned node in the relations map. */
export interface RelationsMapNodeSpec {
  /** Stable element id (`afe-map-node-…`). */
  id: string;
  /** Composite entity key `kind:entityId` (matches the graph node/edge keys). */
  key: string;
  /** Normalized entity kind (e.g. `character`), used to pick a fill color. */
  kind: string;
  /** Entity id as written in the semantic tag. */
  entityId: string;
  /** Display label rendered as the node's bound text. */
  label: string;
  /** `afe-entity://kind/id` link stored on the element for click navigation. */
  link: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A positioned edge (arrow) between two node centers in the relations map. */
export interface RelationsMapEdgeSpec {
  /** Stable element id (`afe-map-edge-…`). */
  id: string;
  /** Source composite entity key. */
  from: string;
  /** Target composite entity key. */
  to: string;
  /** Source node element id. */
  fromId: string;
  /** Target node element id. */
  toId: string;
  /** Center of the source node. */
  start: Point;
  /** Center of the target node. */
  end: Point;
}

/** The full deterministic layout produced by {@link layoutRelationsMap}. */
export interface RelationsMapLayout {
  nodes: RelationsMapNodeSpec[];
  edges: RelationsMapEdgeSpec[];
}

/** Tunable geometry for {@link layoutRelationsMap}; every field has a default. */
export interface RelationsMapLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  /** Horizontal gap between the kind zones. */
  columnGap?: number;
  /** Gap between cells inside a kind's grid (both axes). */
  cellGap?: number;
  /** Max columns inside one kind's grid before it wraps to a new row. */
  innerColumns?: number;
  /** Top/left origin of the whole map. */
  margin?: number;
}

const DEFAULT_LAYOUT: Required<RelationsMapLayoutOptions> = {
  nodeWidth: 170,
  nodeHeight: 60,
  columnGap: 90,
  cellGap: 40,
  innerColumns: 3,
  margin: 60
};

/**
 * Order index for a kind: registry kinds first (in registry order), unknown
 * kinds after, so the column order is stable and deterministic.
 */
function kindOrder(kind: string): number {
  const index = (ENTITY_KIND_IDS as readonly string[]).indexOf(kind);
  return index === -1 ? ENTITY_KIND_IDS.length : index;
}

/**
 * Lay the graph out as one vertical zone per entity kind (registry order, empty
 * kinds skipped so there are no gaps), each zone an `innerColumns`-wide grid of
 * node cells. Positions are fully deterministic (no randomness); nodes never
 * overlap inside a zone (distinct grid cells) and zones never overlap (each is
 * offset past the previous zone's width plus `columnGap`). Edges connect the
 * centers of existing nodes; an edge whose endpoints are not both present is
 * dropped.
 */
export function layoutRelationsMap(
  snapshot: NarrativeGraphSnapshot,
  options?: RelationsMapLayoutOptions
): RelationsMapLayout {
  const opts = { ...DEFAULT_LAYOUT, ...options };
  const { nodeWidth, nodeHeight, columnGap, cellGap, innerColumns, margin } = opts;

  // Group nodes by kind. Within a kind, order by entityId for a stable grid.
  const byKind = new Map<string, typeof snapshot.nodes>();
  for (const node of snapshot.nodes) {
    const list = byKind.get(node.kind) ?? [];
    list.push(node);
    byKind.set(node.kind, list);
  }
  const kinds = [...byKind.keys()].sort((a, b) => kindOrder(a) - kindOrder(b) || a.localeCompare(b));

  const nodes: RelationsMapNodeSpec[] = [];
  const nodeById = new Map<string, RelationsMapNodeSpec>();
  let zoneX = margin;

  for (const kind of kinds) {
    const group = [...(byKind.get(kind) ?? [])].sort((a, b) => a.entityId.localeCompare(b.entityId));
    const cols = Math.min(innerColumns, Math.max(1, group.length));
    for (let i = 0; i < group.length; i++) {
      const node = group[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const spec: RelationsMapNodeSpec = {
        id: mapNodeElementId(node.id),
        key: node.id,
        kind: node.kind,
        entityId: node.entityId,
        label: node.label,
        link: buildEntityLink(node.kind, node.entityId),
        x: zoneX + col * (nodeWidth + cellGap),
        y: margin + row * (nodeHeight + cellGap),
        width: nodeWidth,
        height: nodeHeight
      };
      nodes.push(spec);
      nodeById.set(spec.key, spec);
    }
    const zoneWidth = cols * nodeWidth + (cols - 1) * cellGap;
    zoneX += zoneWidth + columnGap;
  }

  const edges: RelationsMapEdgeSpec[] = [];
  const seenEdge = new Set<string>();
  for (const relation of snapshot.relations) {
    const from = nodeById.get(relation.source);
    const to = nodeById.get(relation.target);
    if (!from || !to) {
      continue;
    }
    const id = mapEdgeElementId(relation.source, relation.target);
    if (seenEdge.has(id)) {
      continue;
    }
    seenEdge.add(id);
    edges.push({
      id,
      from: relation.source,
      to: relation.target,
      fromId: from.id,
      toId: to.id,
      start: nodeCenter(from),
      end: nodeCenter(to)
    });
  }

  return { nodes, edges };
}

function nodeCenter(spec: RelationsMapNodeSpec): Point {
  return { x: spec.x + spec.width / 2, y: spec.y + spec.height / 2 };
}

/** Loose view of an already-materialized scene element the merge reads for id + geometry. */
export interface MapElement extends Partial<CanvasElement> {
  id?: string;
}

/** Gap (px) inserted between existing content and the freshly-appended map block. */
const APPEND_GAP = 80;

/** Result of {@link mergeRelationsMap}. */
export interface MergeRelationsMapResult {
  /**
   * The nodes/edges to ADD to the scene, with final (offset) coordinates. Empty
   * on an idempotent re-run where every generated id already exists.
   */
  added: RelationsMapLayout;
  /**
   * Element ids of map nodes present in the scene but NO LONGER in the book's
   * graph (removed entities). They are reported, never purged — the merge only
   * ever appends.
   */
  missingFromBook: string[];
}

/**
 * Merge a freshly-computed {@link RelationsMapLayout} into the elements already
 * on the `.excalidraw` scene, PRESERVING every existing element (including the
 * user's own drawings and any manually-moved map nodes) untouched.
 *
 * Rules:
 * - Only nodes/edges whose stable id is ABSENT from the scene are added.
 * - New nodes are shifted down as a block so they land in free space BELOW the
 *   bounding box of the existing content (offset from {@link boundingBox}).
 * - A new edge's endpoints follow the CURRENT position of each endpoint node:
 *   an existing (possibly hand-moved) node's real center, else the new node's
 *   offset center — so edges connect to where the nodes actually are.
 * - Existing map nodes for entities no longer in the graph are reported in
 *   `missingFromBook`, never removed.
 *
 * Re-running with the same graph is idempotent: every id already exists, so
 * `added` is empty and nothing moves.
 */
export function mergeRelationsMap(
  existingElements: readonly MapElement[],
  layout: RelationsMapLayout
): MergeRelationsMapResult {
  const existingById = new Map<string, MapElement>();
  for (const element of existingElements) {
    if (typeof element.id === 'string') {
      existingById.set(element.id, element);
    }
  }

  const offsetY = appendOffsetY(existingElements, layout);

  // New nodes: absent ids, shifted down by offsetY as a block.
  const addedNodes: RelationsMapNodeSpec[] = [];
  for (const node of layout.nodes) {
    if (existingById.has(node.id)) {
      continue;
    }
    addedNodes.push({ ...node, y: node.y + offsetY });
  }
  const addedNodeById = new Map<string, RelationsMapNodeSpec>();
  for (const node of addedNodes) {
    addedNodeById.set(node.id, node);
  }

  // Resolve a node element id to its CURRENT center: existing element's real
  // center, else the freshly-offset new node's center.
  const centerOfNode = (elementId: string): Point | undefined => {
    const existing = existingById.get(elementId);
    if (existing && isPositioned(existing)) {
      return centerOf(existing as CanvasElement);
    }
    const added = addedNodeById.get(elementId);
    return added ? nodeCenter(added) : undefined;
  };

  const addedEdges: RelationsMapEdgeSpec[] = [];
  for (const edge of layout.edges) {
    if (existingById.has(edge.id)) {
      continue;
    }
    const start = centerOfNode(edge.fromId);
    const end = centerOfNode(edge.toId);
    if (!start || !end) {
      continue;
    }
    addedEdges.push({ ...edge, start, end });
  }

  // Removed entities: map nodes in the scene whose id is not in the new layout.
  const layoutNodeIds = new Set(layout.nodes.map(node => node.id));
  const missingFromBook: string[] = [];
  for (const element of existingElements) {
    if (typeof element.id === 'string'
      && element.id.startsWith(MAP_NODE_ID_PREFIX)
      && !layoutNodeIds.has(element.id)) {
      missingFromBook.push(element.id);
    }
  }

  return { added: { nodes: addedNodes, edges: addedEdges }, missingFromBook };
}

function isPositioned(element: MapElement): boolean {
  return typeof element.x === 'number' && typeof element.y === 'number'
    && typeof element.width === 'number' && typeof element.height === 'number';
}

/**
 * Vertical offset that drops the new layout block below the existing content. If
 * the scene has no positioned elements, the block stays at its natural top
 * (offset 0); otherwise it starts `APPEND_GAP` below the existing bounding box.
 */
function appendOffsetY(existingElements: readonly MapElement[], layout: RelationsMapLayout): number {
  const positioned = existingElements.filter(isPositioned) as CanvasElement[];
  if (positioned.length === 0 || layout.nodes.length === 0) {
    return 0;
  }
  const existingBox = boundingBox(positioned);
  const layoutTop = Math.min(...layout.nodes.map(node => node.y));
  return existingBox.y + existingBox.height + APPEND_GAP - layoutTop;
}
