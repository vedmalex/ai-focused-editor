/**
 * Pure, framework-free translator from a STRUCTURED diagram description (the
 * `spec` an AI agent authors through the `manuscript_create_diagram` tool) into
 * `convertToExcalidrawElements` skeletons.
 *
 * Like `common/relations-map` and `common/excalidraw-canvas-ops`, this module is
 * deliberately Theia- AND Excalidraw-free: it takes plain DATA (nodes, edges,
 * free texts) and returns plain skeleton records + the entity links to re-assert
 * after conversion. The browser tool turns those skeletons into real Excalidraw
 * elements via `convertToExcalidrawElements({ regenerateIds: false })` and writes
 * the `.excalidraw` scene. Keeping the deterministic grid layout, the stable-id
 * scheme, the `afe-entity://` linking, and the spec validation here makes all of
 * it unit-testable without a DOM.
 */

import { boundingBox, type CanvasElement, type Point } from './excalidraw-canvas-ops';
import { buildEntityLink } from './relations-map';

/** Prefix of every generated diagram-node element id. */
export const DIAGRAM_NODE_ID_PREFIX = 'afe-diagram-node-';

/** Prefix of every generated diagram-edge element id. */
export const DIAGRAM_EDGE_ID_PREFIX = 'afe-diagram-edge-';

/** Optional reference binding a diagram node to a knowledge-base entity. */
export interface DiagramEntityRef {
  /** Entity kind (e.g. `character`, `term`, `location`, `artifact`). */
  kind: string;
  /** Entity id as written in the entity YAML / semantic tag. */
  id: string;
}

/** One box in the diagram. `entity` turns the box into a clickable world-map node. */
export interface DiagramNode {
  /** Author-chosen id, referenced by edges' `from`/`to`. Must be unique. */
  id: string;
  /** Text rendered inside the box. */
  label: string;
  /** When set, the box links to `afe-entity://kind/id` (strengthens the world map). */
  entity?: DiagramEntityRef;
}

/** A directed arrow between two node ids, with an optional mid-arrow label. */
export interface DiagramEdge {
  /** Source node id (must match a `DiagramNode.id`). */
  from: string;
  /** Target node id (must match a `DiagramNode.id`). */
  to: string;
  /** Optional label rendered on the arrow. */
  label?: string;
}

/** A free-floating text element. Coordinates are optional (auto-placed below the grid). */
export interface DiagramText {
  text: string;
  x?: number;
  y?: number;
}

/** The structured scene description an agent authors. */
export interface DiagramSpec {
  nodes: DiagramNode[];
  edges?: DiagramEdge[];
  texts?: DiagramText[];
}

/** Tunable geometry for {@link diagramSpecToSkeleton}; every field has a default. */
export interface DiagramLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  /** Horizontal gap between grid cells. */
  gapX?: number;
  /** Vertical gap between grid cells. */
  gapY?: number;
  /** Top/left origin of the whole diagram. */
  margin?: number;
  /** Max columns before the grid wraps to a new row. */
  maxColumns?: number;
  /** Vertical gap between the node grid and the first auto-placed free text. */
  textGap?: number;
  /** Line advance (px) between consecutive auto-placed free texts. */
  textLineHeight?: number;
}

const DEFAULT_LAYOUT: Required<DiagramLayoutOptions> = {
  nodeWidth: 180,
  nodeHeight: 72,
  gapX: 60,
  gapY: 60,
  margin: 80,
  maxColumns: 4,
  textGap: 60,
  textLineHeight: 28
};

/**
 * Soft fill per entity kind, matching the relations-map accents. A plain
 * (non-entity) node gets the neutral fill; an unknown kind falls back to it too.
 */
const KIND_BACKGROUND: Record<string, string> = {
  character: '#ede0f7',
  term: '#e3f4e0',
  artifact: '#f7ecd9',
  location: '#fbe0dd'
};
const DEFAULT_BACKGROUND = '#f1f3f5';

/** Thrown by {@link diagramSpecToSkeleton} for a structurally invalid spec. */
export class DiagramSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagramSpecError';
  }
}

/** A node placed on the deterministic grid, with its stable element id and center. */
export interface PositionedDiagramNode {
  elementId: string;
  node: DiagramNode;
  x: number;
  y: number;
  width: number;
  height: number;
  center: Point;
  /** `afe-entity://kind/id` link when the node carries an entity, else `undefined`. */
  link?: string;
}

/** Result of {@link diagramSpecToSkeleton}: skeletons + the links to re-assert post-conversion. */
export interface DiagramSkeletonResult {
  /** Skeleton records for `convertToExcalidrawElements` (arrows first, then boxes, then texts). */
  skeletons: Record<string, unknown>[];
  /** `{ elementId, link }` for each entity node, so the tool can re-assert `link` after conversion. */
  entityLinks: { elementId: string; link: string }[];
}

/** Collapse any run of non-alphanumeric characters into a single `-` for a JSON-safe id part. */
function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate a spec and lay its nodes out on a deterministic grid. Throws a
 * {@link DiagramSpecError} for any structural problem: a non-object spec, an
 * empty/invalid node list, a node missing `id`/`label`, duplicate node ids, a
 * malformed `entity`, or an edge/text with the wrong shape or an edge whose
 * `from`/`to` does not resolve to a declared node.
 */
export function validateDiagramSpec(spec: unknown): Required<Pick<DiagramSpec, 'nodes' | 'edges' | 'texts'>> {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new DiagramSpecError('Diagram spec must be an object with a "nodes" array.');
  }
  const candidate = spec as Partial<DiagramSpec>;
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length === 0) {
    throw new DiagramSpecError('Diagram spec must have a non-empty "nodes" array.');
  }

  const seen = new Set<string>();
  for (const node of candidate.nodes) {
    if (typeof node !== 'object' || node === null) {
      throw new DiagramSpecError('Each node must be an object with "id" and "label".');
    }
    if (!isNonEmptyString(node.id)) {
      throw new DiagramSpecError('Each node needs a non-empty string "id".');
    }
    if (!isNonEmptyString(node.label)) {
      throw new DiagramSpecError(`Node "${node.id}" needs a non-empty string "label".`);
    }
    if (seen.has(node.id)) {
      throw new DiagramSpecError(`Duplicate node id "${node.id}".`);
    }
    seen.add(node.id);
    if (node.entity !== undefined) {
      if (typeof node.entity !== 'object' || node.entity === null
        || !isNonEmptyString(node.entity.kind) || !isNonEmptyString(node.entity.id)) {
        throw new DiagramSpecError(`Node "${node.id}" has an invalid "entity" (needs string "kind" and "id").`);
      }
    }
  }

  const edges = candidate.edges ?? [];
  if (!Array.isArray(edges)) {
    throw new DiagramSpecError('"edges" must be an array when present.');
  }
  for (const edge of edges) {
    if (typeof edge !== 'object' || edge === null) {
      throw new DiagramSpecError('Each edge must be an object with "from" and "to".');
    }
    if (!isNonEmptyString(edge.from) || !isNonEmptyString(edge.to)) {
      throw new DiagramSpecError('Each edge needs non-empty string "from" and "to".');
    }
    if (!seen.has(edge.from)) {
      throw new DiagramSpecError(`Edge references unknown node id "${edge.from}".`);
    }
    if (!seen.has(edge.to)) {
      throw new DiagramSpecError(`Edge references unknown node id "${edge.to}".`);
    }
    if (edge.label !== undefined && typeof edge.label !== 'string') {
      throw new DiagramSpecError('Edge "label" must be a string when present.');
    }
  }

  const texts = candidate.texts ?? [];
  if (!Array.isArray(texts)) {
    throw new DiagramSpecError('"texts" must be an array when present.');
  }
  for (const text of texts) {
    if (typeof text !== 'object' || text === null || !isNonEmptyString(text.text)) {
      throw new DiagramSpecError('Each text needs a non-empty string "text".');
    }
    if ((text.x !== undefined && typeof text.x !== 'number')
      || (text.y !== undefined && typeof text.y !== 'number')) {
      throw new DiagramSpecError('Text "x"/"y" must be numbers when present.');
    }
  }

  return { nodes: candidate.nodes, edges, texts };
}

/**
 * Lay the validated nodes out on a deterministic `maxColumns`-wide grid (registry
 * order preserved; no randomness), assign each a stable element id, and compute
 * its center for edge routing.
 */
function layoutDiagramNodes(nodes: DiagramNode[], opts: Required<DiagramLayoutOptions>): PositionedDiagramNode[] {
  const cols = Math.min(opts.maxColumns, Math.max(1, nodes.length));
  return nodes.map((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = opts.margin + col * (opts.nodeWidth + opts.gapX);
    const y = opts.margin + row * (opts.nodeHeight + opts.gapY);
    const elementId = `${DIAGRAM_NODE_ID_PREFIX}${sanitizeIdPart(node.id) || 'node'}-${index}`;
    return {
      elementId,
      node,
      x,
      y,
      width: opts.nodeWidth,
      height: opts.nodeHeight,
      center: { x: x + opts.nodeWidth / 2, y: y + opts.nodeHeight / 2 },
      link: node.entity ? buildEntityLink(node.entity.kind, node.entity.id) : undefined
    };
  });
}

/**
 * Translate a diagram spec into `convertToExcalidrawElements` skeletons. Boxes are
 * laid on a deterministic grid; arrows connect node centers; free texts sit at
 * their given coordinates or are auto-stacked below the grid. Entity nodes carry
 * an `afe-entity://kind/id` link (returned in `entityLinks` so the caller can
 * re-assert it after conversion strips it onto a bound-text child).
 *
 * @throws {DiagramSpecError} for a structurally invalid spec (see {@link validateDiagramSpec}).
 */
export function diagramSpecToSkeleton(spec: unknown, options?: DiagramLayoutOptions): DiagramSkeletonResult {
  const opts = { ...DEFAULT_LAYOUT, ...options };
  const { nodes, edges, texts } = validateDiagramSpec(spec);

  const positioned = layoutDiagramNodes(nodes, opts);
  const byNodeId = new Map(positioned.map(item => [item.node.id, item]));

  const arrowSkeletons: Record<string, unknown>[] = edges.map((edge, index) => {
    const from = byNodeId.get(edge.from)!;
    const to = byNodeId.get(edge.to)!;
    const dx = to.center.x - from.center.x;
    const dy = to.center.y - from.center.y;
    const skeleton: Record<string, unknown> = {
      type: 'arrow',
      id: `${DIAGRAM_EDGE_ID_PREFIX}${index}`,
      x: from.center.x,
      y: from.center.y,
      width: dx,
      height: dy,
      points: [[0, 0], [dx, dy]]
    };
    if (edge.label) {
      skeleton.label = { text: edge.label };
    }
    return skeleton;
  });

  const entityLinks: { elementId: string; link: string }[] = [];
  const boxSkeletons: Record<string, unknown>[] = positioned.map(item => {
    const skeleton: Record<string, unknown> = {
      type: 'rectangle',
      id: item.elementId,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      backgroundColor: item.node.entity
        ? (KIND_BACKGROUND[item.node.entity.kind] ?? DEFAULT_BACKGROUND)
        : DEFAULT_BACKGROUND,
      fillStyle: 'solid',
      roundness: { type: 3 },
      label: { text: item.node.label }
    };
    if (item.link) {
      skeleton.link = item.link;
      entityLinks.push({ elementId: item.elementId, link: item.link });
    }
    return skeleton;
  });

  // Auto-place free texts below the node grid (only for those without coordinates).
  const nodeBoxes: CanvasElement[] = positioned.map(item => ({
    type: 'rectangle',
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height
  }));
  const box = boundingBox(nodeBoxes);
  const autoBaseY = box.y + box.height + opts.textGap;
  let autoRow = 0;
  const textSkeletons: Record<string, unknown>[] = texts.map(text => ({
    type: 'text',
    x: text.x ?? opts.margin,
    y: text.y ?? autoBaseY + (autoRow++) * opts.textLineHeight,
    text: text.text
  }));

  return {
    // Arrows first (behind the box fills), then boxes, then free texts.
    skeletons: [...arrowSkeletons, ...boxSkeletons, ...textSkeletons],
    entityLinks
  };
}
