/**
 * Pure, framework-free summarizer that renders an Excalidraw scene (`.excalidraw`
 * JSON) as compact TEXT for a language model. An `.excalidraw` file is binary-ish
 * structured data the model cannot read directly, so — like the server-side text
 * extraction behind `#source` — we distil it into a readable outline:
 *
 *  - the free-standing text elements (labels, annotations);
 *  - the shape "nodes" and their bound labels, with any `afe-entity://` link
 *    parsed back to its `kind:id` entity reference (so a relations-map node is
 *    tied to the entity card it points at);
 *  - the arrows as `A -> B` connections, resolved from an arrow's start/end
 *    bindings when present, else by the nearest labelled shape/text to each
 *    endpoint (the generated relations-map arrows carry geometry, not bindings);
 *  - a per-shape-type tally.
 *
 * The module is deliberately Theia- AND Excalidraw-free: it takes the parsed JSON
 * (an object with `elements`, or a bare element array) and returns a capped
 * string, so the whole thing is unit-testable with plain `bun test`.
 */

import { parseEntityLink } from './relations-map';

/** Loosely-typed view of one Excalidraw element; only read fields are modelled. */
export interface DiagramElement {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Text content (present on `text` elements). */
  text?: string;
  /** Id of the container a bound-text label belongs to. */
  containerId?: string | null;
  /** Elements bound to this one (e.g. a container's bound text). */
  boundElements?: ReadonlyArray<{ id?: string; type?: string } | null> | null;
  /** Arrow endpoint bindings. */
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  /** Arrow/line relative point path (`[[0,0],[dx,dy],…]`). */
  points?: ReadonlyArray<ReadonlyArray<number>> | null;
  /** Navigable link stored on a shape (e.g. `afe-entity://kind/id`). */
  link?: string | null;
  /** Excalidraw skeleton-API label form (tolerated in addition to bound text). */
  label?: { text?: string } | null;
}

/** Tunable caps for {@link summarizeExcalidrawScene}; every field has a default. */
export interface DiagramSummaryOptions {
  /** Optional heading (typically the file path), rendered as `# Diagram: …`. */
  title?: string;
  maxNodes?: number;
  maxConnections?: number;
  maxTexts?: number;
  /** Per-text-item truncation length. */
  maxTextLength?: number;
  /** Hard cap on the whole returned string. */
  maxChars?: number;
}

const DEFAULTS: Required<Omit<DiagramSummaryOptions, 'title'>> = {
  maxNodes: 80,
  maxConnections: 80,
  maxTexts: 60,
  maxTextLength: 140,
  maxChars: 12000
};

/** Shape element types treated as diagram "nodes". */
const SHAPE_TYPES: ReadonlySet<string> = new Set(['rectangle', 'ellipse', 'diamond']);

interface Point {
  x: number;
  y: number;
}

interface NodeInfo {
  id: string;
  name?: string;
  center: Point;
  link?: string;
}

/**
 * Summarize a parsed `.excalidraw` scene as capped, model-readable text. Accepts
 * the whole file object (`{ elements: [...] }`) or a bare element array; anything
 * without recognizable elements yields a short "empty diagram" note (still with
 * the title header when provided).
 */
export function summarizeExcalidrawScene(scene: unknown, options: DiagramSummaryOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };
  const elements = extractElements(scene);
  const header = options.title ? `# Diagram: ${options.title}` : '# Diagram';

  if (elements.length === 0) {
    return `${header}\n\n(The diagram is empty — no elements.)`;
  }

  const byId = new Map<string, DiagramElement>();
  for (const element of elements) {
    if (typeof element.id === 'string') {
      byId.set(element.id, element);
    }
  }

  // Container id -> its bound-text label. Materialized scenes bind a label via
  // the text element's `containerId`; the skeleton `label.text` form is also
  // tolerated on the container itself.
  const labelByContainer = new Map<string, string>();
  const boundTextIds = new Set<string>();
  for (const element of elements) {
    if (element.type === 'text' && typeof element.containerId === 'string') {
      boundTextIds.add(element.id ?? '');
      const text = normalizeText(element.text);
      if (text && !labelByContainer.has(element.containerId)) {
        labelByContainer.set(element.containerId, text);
      }
    }
  }

  const labelOf = (element: DiagramElement): string | undefined => {
    const bound = element.id ? labelByContainer.get(element.id) : undefined;
    if (bound) {
      return bound;
    }
    const skeleton = normalizeText(element.label?.text);
    if (skeleton) {
      return skeleton;
    }
    if (element.type === 'text') {
      return normalizeText(element.text);
    }
    return undefined;
  };

  // Nodes: shapes, plus anything carrying a bound label or a link. Named nodes
  // (and free text) form the pool arrow endpoints snap to by nearest-center.
  const nodes: { element: DiagramElement; label?: string }[] = [];
  const namedPool: NodeInfo[] = [];
  for (const element of elements) {
    const label = labelOf(element);
    const isShape = typeof element.type === 'string' && SHAPE_TYPES.has(element.type);
    const isNode = isShape || (element.type !== 'arrow' && element.type !== 'line' && element.type !== 'text'
      && (label !== undefined || typeof element.link === 'string'));
    if (isNode && (label !== undefined || typeof element.link === 'string')) {
      nodes.push({ element, label });
      namedPool.push({ id: element.id ?? '', name: label, center: centerOf(element), link: element.link ?? undefined });
    }
  }
  // Free-standing text also anchors nearest-matching for arrows.
  for (const element of elements) {
    if (element.type === 'text' && !boundTextIds.has(element.id ?? '')) {
      const text = normalizeText(element.text);
      if (text) {
        namedPool.push({ id: element.id ?? '', name: text, center: centerOf(element) });
      }
    }
  }

  const nearestName = (point: Point): string | undefined => {
    let best: NodeInfo | undefined;
    let bestDistance = Infinity;
    for (const candidate of namedPool) {
      if (!candidate.name) {
        continue;
      }
      const distance = squaredDistance(candidate.center, point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best?.name;
  };

  const bindingName = (binding: { elementId?: string } | null | undefined): string | undefined => {
    const id = binding?.elementId;
    if (typeof id !== 'string') {
      return undefined;
    }
    const element = byId.get(id);
    return element ? labelOf(element) : undefined;
  };

  // Connections from arrows (and lines): prefer explicit bindings, else snap
  // each endpoint to the nearest labelled shape/text.
  const connections: string[] = [];
  for (const element of elements) {
    if (element.type !== 'arrow' && element.type !== 'line') {
      continue;
    }
    const { start, end } = endpointsOf(element);
    const from = bindingName(element.startBinding) ?? nearestName(start);
    const to = bindingName(element.endBinding) ?? nearestName(end);
    if (!from || !to) {
      continue;
    }
    const relation = labelOf(element);
    connections.push(relation ? `${from} -> ${to} (${relation})` : `${from} -> ${to}`);
  }

  // Free-standing texts (annotations that are not a container/arrow label).
  const texts: string[] = [];
  for (const element of elements) {
    if (element.type === 'text' && !boundTextIds.has(element.id ?? '')) {
      const text = normalizeText(element.text);
      if (text) {
        texts.push(cap(text, opts.maxTextLength));
      }
    }
  }

  const counts = tallyByType(elements);

  // Assemble.
  const lines: string[] = [header, '', `Elements: ${elements.length} (${counts})`];

  if (nodes.length > 0) {
    lines.push('', `## Nodes (${nodes.length})`);
    for (const { element, label } of nodes.slice(0, opts.maxNodes)) {
      lines.push(`- ${formatNode(label, element.link)}`);
    }
    if (nodes.length > opts.maxNodes) {
      lines.push(`- …and ${nodes.length - opts.maxNodes} more`);
    }
  }

  if (connections.length > 0) {
    lines.push('', `## Connections (${connections.length})`);
    for (const connection of connections.slice(0, opts.maxConnections)) {
      lines.push(`- ${connection}`);
    }
    if (connections.length > opts.maxConnections) {
      lines.push(`- …and ${connections.length - opts.maxConnections} more`);
    }
  }

  if (texts.length > 0) {
    lines.push('', `## Text (${texts.length})`);
    for (const text of texts.slice(0, opts.maxTexts)) {
      lines.push(`- ${text}`);
    }
    if (texts.length > opts.maxTexts) {
      lines.push(`- …and ${texts.length - opts.maxTexts} more`);
    }
  }

  return cap(lines.join('\n'), opts.maxChars);
}

function formatNode(label: string | undefined, link: string | null | undefined): string {
  const name = label ?? '(unlabeled)';
  if (typeof link !== 'string' || link.length === 0) {
    return name;
  }
  const entity = parseEntityLink(link);
  if (entity) {
    return `${name} (→ ${entity.kind}:${entity.id})`;
  }
  return `${name} (link: ${link})`;
}

function tallyByType(elements: readonly DiagramElement[]): string {
  const counts = new Map<string, number>();
  for (const element of elements) {
    const type = typeof element.type === 'string' && element.type ? element.type : 'unknown';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ');
}

/** Pull the element array out of a scene object, a bare array, or nothing. */
function extractElements(scene: unknown): DiagramElement[] {
  if (Array.isArray(scene)) {
    return scene.filter(isElement);
  }
  if (scene && typeof scene === 'object') {
    const elements = (scene as { elements?: unknown }).elements;
    if (Array.isArray(elements)) {
      return elements.filter(isElement);
    }
  }
  return [];
}

function isElement(value: unknown): value is DiagramElement {
  return typeof value === 'object' && value !== null;
}

function centerOf(element: DiagramElement): Point {
  const x = num(element.x);
  const y = num(element.y);
  return { x: x + num(element.width) / 2, y: y + num(element.height) / 2 };
}

/** Absolute start/end points of an arrow/line from its point path, else its bbox diagonal. */
function endpointsOf(element: DiagramElement): { start: Point; end: Point } {
  const x = num(element.x);
  const y = num(element.y);
  const points = Array.isArray(element.points) ? element.points : undefined;
  if (points && points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    return {
      start: { x: x + num(first?.[0]), y: y + num(first?.[1]) },
      end: { x: x + num(last?.[0]), y: y + num(last?.[1]) }
    };
  }
  return { start: { x, y }, end: { x: x + num(element.width), y: y + num(element.height) } };
}

function squaredDistance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : undefined;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[...truncated]` : text;
}
