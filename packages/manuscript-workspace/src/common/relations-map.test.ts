import { describe, expect, test } from 'bun:test';
import type { NarrativeGraphSnapshot, NarrativeRelationEdge, NarrativeRelationNode } from './narrative-graph-protocol';
import {
  AFE_ENTITY_LINK_SCHEME,
  MAP_NODE_ID_PREFIX,
  buildEntityLink,
  layoutRelationsMap,
  mapEdgeElementId,
  mapNodeElementId,
  mergeRelationsMap,
  parseEntityLink,
  type MapElement,
  type RelationsMapLayout
} from './relations-map';

function node(kind: string, entityId: string, label = `${entityId}!`, appearances = 1): NarrativeRelationNode {
  return { id: `${kind}:${entityId}`, kind, entityId, label, appearances };
}

function edge(source: string, target: string, weight = 1): NarrativeRelationEdge {
  return { source, target, sourceLabel: source, targetLabel: target, weight, sharedChapters: [] };
}

function snapshot(
  nodes: NarrativeRelationNode[],
  relations: NarrativeRelationEdge[] = []
): NarrativeGraphSnapshot {
  return {
    timeline: [],
    ownership: [],
    nodes,
    relations,
    truncated: false,
    totalEntities: nodes.length,
    diagnostics: []
  };
}

function overlaps(a: { x: number; y: number; width: number; height: number },
                  b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('buildEntityLink / parseEntityLink', () => {
  test('round-trips a simple kind/id', () => {
    const link = buildEntityLink('character', 'john');
    expect(link).toBe(`${AFE_ENTITY_LINK_SCHEME}character/john`);
    expect(parseEntityLink(link)).toEqual({ kind: 'character', id: 'john' });
  });

  test('round-trips ids with reserved characters via percent-encoding', () => {
    const link = buildEntityLink('term', 'a/b c:d');
    expect(parseEntityLink(link)).toEqual({ kind: 'term', id: 'a/b c:d' });
  });

  test('tolerates an already-percent-encoded link', () => {
    expect(parseEntityLink(`${AFE_ENTITY_LINK_SCHEME}character/j%20doe`))
      .toEqual({ kind: 'character', id: 'j doe' });
  });

  test('returns undefined for non-entity links', () => {
    expect(parseEntityLink('https://example.com')).toBeUndefined();
    expect(parseEntityLink('mailto:a@b.c')).toBeUndefined();
    expect(parseEntityLink('')).toBeUndefined();
    expect(parseEntityLink(null)).toBeUndefined();
    expect(parseEntityLink(`${AFE_ENTITY_LINK_SCHEME}nokind`)).toBeUndefined();
    expect(parseEntityLink(`${AFE_ENTITY_LINK_SCHEME}kind/`)).toBeUndefined();
    expect(parseEntityLink(`${AFE_ENTITY_LINK_SCHEME}/id`)).toBeUndefined();
  });
});

describe('stable element ids', () => {
  test('mapNodeElementId sanitizes the composite key', () => {
    expect(mapNodeElementId('kind:entityId')).toBe('afe-map-node-kind-entityId');
    expect(mapNodeElementId('character:jon snow')).toBe('afe-map-node-character-jon-snow');
  });

  test('mapEdgeElementId keeps the two sides separable with __', () => {
    expect(mapEdgeElementId('character:a', 'term:b')).toBe('afe-map-edge-character-a__term-b');
  });

  test('edge ids are deterministic for the same pair', () => {
    expect(mapEdgeElementId('character:a', 'term:b')).toBe(mapEdgeElementId('character:a', 'term:b'));
  });
});

describe('layoutRelationsMap', () => {
  test('is deterministic — same input yields identical positions', () => {
    const snap = snapshot(
      [node('character', 'b'), node('character', 'a'), node('term', 'x')],
      [edge('character:a', 'term:x')]
    );
    expect(layoutRelationsMap(snap)).toEqual(layoutRelationsMap(snap));
  });

  test('clusters nodes by kind in registry order (character before term)', () => {
    const layout = layoutRelationsMap(snapshot([node('term', 'x'), node('character', 'a')]));
    const character = layout.nodes.find(n => n.key === 'character:a')!;
    const term = layout.nodes.find(n => n.key === 'term:x')!;
    // character zone sits left of the term zone
    expect(character.x).toBeLessThan(term.x);
  });

  test('nodes inside a kind grid never overlap', () => {
    const nodes = Array.from({ length: 7 }, (_, i) => node('character', `c${i}`));
    const layout = layoutRelationsMap(snapshot(nodes));
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        expect(overlaps(layout.nodes[i], layout.nodes[j])).toBe(false);
      }
    }
  });

  test('every edge references existing nodes and carries center coordinates', () => {
    const layout = layoutRelationsMap(snapshot(
      [node('character', 'a'), node('term', 'x')],
      [edge('character:a', 'term:x')]
    ));
    const ids = new Set(layout.nodes.map(n => n.id));
    expect(layout.edges).toHaveLength(1);
    for (const e of layout.edges) {
      expect(ids.has(e.fromId)).toBe(true);
      expect(ids.has(e.toId)).toBe(true);
    }
    const a = layout.nodes.find(n => n.key === 'character:a')!;
    expect(layout.edges[0].start).toEqual({ x: a.x + a.width / 2, y: a.y + a.height / 2 });
  });

  test('drops edges whose endpoints are not both present', () => {
    const layout = layoutRelationsMap(snapshot(
      [node('character', 'a')],
      [edge('character:a', 'term:missing')]
    ));
    expect(layout.edges).toHaveLength(0);
  });

  test('each node carries its afe-entity link', () => {
    const layout = layoutRelationsMap(snapshot([node('character', 'a')]));
    expect(layout.nodes[0].link).toBe(buildEntityLink('character', 'a'));
  });
});

describe('mergeRelationsMap', () => {
  const baseLayout = (): RelationsMapLayout => layoutRelationsMap(snapshot(
    [node('character', 'a'), node('term', 'x')],
    [edge('character:a', 'term:x')]
  ));

  function asElements(layout: RelationsMapLayout): MapElement[] {
    return [
      ...layout.nodes.map(n => ({ id: n.id, type: 'rectangle', x: n.x, y: n.y, width: n.width, height: n.height })),
      ...layout.edges.map(e => ({ id: e.id, type: 'arrow', x: e.start.x, y: e.start.y, width: 0, height: 0 }))
    ];
  }

  test('into an empty scene, adds every node and edge at natural coordinates', () => {
    const layout = baseLayout();
    const result = mergeRelationsMap([], layout);
    expect(result.added.nodes).toHaveLength(2);
    expect(result.added.edges).toHaveLength(1);
    expect(result.missingFromBook).toEqual([]);
    // offset 0 for an empty scene
    expect(result.added.nodes[0].y).toBe(layout.nodes[0].y);
  });

  test('is idempotent — merging into a scene already holding the layout adds nothing', () => {
    const layout = baseLayout();
    const existing = asElements(layout);
    const result = mergeRelationsMap(existing, layout);
    expect(result.added.nodes).toHaveLength(0);
    expect(result.added.edges).toHaveLength(0);
    expect(result.missingFromBook).toEqual([]);
  });

  test('appends new nodes BELOW the bounding box of existing content', () => {
    // Existing scene: a user drawing far down the canvas + only the first node.
    const layout = baseLayout();
    const userDrawing: MapElement = { id: 'user-1', type: 'rectangle', x: 0, y: 1000, width: 300, height: 200 };
    const existing: MapElement[] = [
      userDrawing,
      { id: layout.nodes[0].id, type: 'rectangle', x: layout.nodes[0].x, y: layout.nodes[0].y, width: layout.nodes[0].width, height: layout.nodes[0].height }
    ];
    const result = mergeRelationsMap(existing, layout);
    // The second node is new and must land below y=1200 (drawing bottom).
    expect(result.added.nodes).toHaveLength(1);
    for (const n of result.added.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(1200);
    }
  });

  test('a new edge connects to an existing (hand-moved) node at its real position', () => {
    const layout = baseLayout();
    const movedFirst: MapElement = {
      id: layout.nodes[0].id, type: 'rectangle', x: 5000, y: 5000, width: 100, height: 40
    };
    const result = mergeRelationsMap([movedFirst], layout);
    const newEdge = result.added.edges.find(e => e.fromId === layout.nodes[0].id || e.toId === layout.nodes[0].id)!;
    const endpoint = newEdge.fromId === layout.nodes[0].id ? newEdge.start : newEdge.end;
    // center of the moved element
    expect(endpoint).toEqual({ x: 5050, y: 5020 });
  });

  test('reports removed entities in missingFromBook without purging them', () => {
    const layout = baseLayout();
    const ghostId = mapNodeElementId('character:ghost');
    const existing: MapElement[] = [
      ...asElements(layout),
      { id: ghostId, type: 'rectangle', x: 10, y: 10, width: 100, height: 40 }
    ];
    const result = mergeRelationsMap(existing, layout);
    expect(result.missingFromBook).toEqual([ghostId]);
    expect(ghostId.startsWith(MAP_NODE_ID_PREFIX)).toBe(true);
    // nothing added; the ghost is reported, not removed (caller keeps existing)
    expect(result.added.nodes).toHaveLength(0);
  });

  test('non-map user elements are never reported as missing', () => {
    const layout = baseLayout();
    const existing: MapElement[] = [
      ...asElements(layout),
      { id: 'freehand-42', type: 'freedraw', x: 0, y: 0, width: 10, height: 10 }
    ];
    const result = mergeRelationsMap(existing, layout);
    expect(result.missingFromBook).toEqual([]);
  });
});
