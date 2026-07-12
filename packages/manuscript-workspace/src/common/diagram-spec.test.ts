import { describe, expect, test } from 'bun:test';
import {
  DIAGRAM_EDGE_ID_PREFIX,
  DIAGRAM_NODE_ID_PREFIX,
  DiagramSpecError,
  diagramSpecToSkeleton,
  validateDiagramSpec,
  type DiagramSpec
} from './diagram-spec';
import { AFE_ENTITY_LINK_SCHEME, parseEntityLink } from './relations-map';

function box(skeletons: Record<string, unknown>[], id: string): Record<string, unknown> {
  const found = skeletons.find(skeleton => skeleton.id === id);
  if (!found) {
    throw new Error(`no skeleton with id ${id}`);
  }
  return found;
}

describe('diagramSpecToSkeleton — layout', () => {
  test('is deterministic: same spec yields byte-identical skeletons', () => {
    const spec: DiagramSpec = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' }
      ],
      edges: [{ from: 'a', to: 'b' }],
      texts: [{ text: 'note' }]
    };
    const first = diagramSpecToSkeleton(spec);
    const second = diagramSpecToSkeleton(spec);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test('lays boxes out on a wrapping grid with no overlap and stable ids', () => {
    const nodes = Array.from({ length: 5 }, (_, index) => ({ id: `n${index}`, label: `N${index}` }));
    const { skeletons } = diagramSpecToSkeleton({ nodes }, { maxColumns: 2 });
    const boxes = skeletons.filter(skeleton => skeleton.type === 'rectangle');
    expect(boxes).toHaveLength(5);

    // Column 0 of row 0 and row 1 share an x; row 1 sits strictly below row 0.
    const first = box(skeletons, `${DIAGRAM_NODE_ID_PREFIX}n0-0`);
    const third = box(skeletons, `${DIAGRAM_NODE_ID_PREFIX}n2-2`);
    expect(third.x).toBe(first.x);
    expect(third.y as number).toBeGreaterThan(first.y as number);

    // No two boxes share the same (x, y) cell.
    const cells = new Set(boxes.map(b => `${b.x}:${b.y}`));
    expect(cells.size).toBe(5);
  });

  test('respects maxColumns so a single-column layout stacks vertically', () => {
    const nodes = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ];
    const { skeletons } = diagramSpecToSkeleton({ nodes }, { maxColumns: 1 });
    const a = box(skeletons, `${DIAGRAM_NODE_ID_PREFIX}a-0`);
    const b = box(skeletons, `${DIAGRAM_NODE_ID_PREFIX}b-1`);
    expect(b.x).toBe(a.x);
    expect(b.y as number).toBeGreaterThan(a.y as number);
  });
});

describe('diagramSpecToSkeleton — entity links', () => {
  test('an entity node carries an afe-entity link that round-trips', () => {
    const spec: DiagramSpec = {
      nodes: [{ id: 'krishna', label: 'Кришна', entity: { kind: 'character', id: 'krishna' } }]
    };
    const { skeletons, entityLinks } = diagramSpecToSkeleton(spec);
    const elementId = `${DIAGRAM_NODE_ID_PREFIX}krishna-0`;
    const rect = box(skeletons, elementId);
    expect(rect.link).toBe(`${AFE_ENTITY_LINK_SCHEME}character/krishna`);
    expect(parseEntityLink(rect.link as string)).toEqual({ kind: 'character', id: 'krishna' });

    expect(entityLinks).toEqual([{ elementId, link: `${AFE_ENTITY_LINK_SCHEME}character/krishna` }]);
  });

  test('a plain node has no link and is absent from entityLinks', () => {
    const { skeletons, entityLinks } = diagramSpecToSkeleton({ nodes: [{ id: 'a', label: 'A' }] });
    const rect = box(skeletons, `${DIAGRAM_NODE_ID_PREFIX}a-0`);
    expect(rect.link).toBeUndefined();
    expect(entityLinks).toHaveLength(0);
  });
});

describe('diagramSpecToSkeleton — edges', () => {
  test('resolves an edge to an arrow between the two node centers', () => {
    const spec: DiagramSpec = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' }
      ],
      edges: [{ from: 'a', to: 'b', label: 'loves' }]
    };
    const { skeletons } = diagramSpecToSkeleton(spec, { maxColumns: 2 });
    const arrow = box(skeletons, `${DIAGRAM_EDGE_ID_PREFIX}0`);
    const a = box(skeletons, `${DIAGRAM_NODE_ID_PREFIX}a-0`);
    const b = box(skeletons, `${DIAGRAM_NODE_ID_PREFIX}b-1`);

    const aCenter = { x: (a.x as number) + (a.width as number) / 2, y: (a.y as number) + (a.height as number) / 2 };
    const bCenter = { x: (b.x as number) + (b.width as number) / 2, y: (b.y as number) + (b.height as number) / 2 };
    expect(arrow.x).toBe(aCenter.x);
    expect(arrow.y).toBe(aCenter.y);
    expect(arrow.width).toBe(bCenter.x - aCenter.x);
    expect(arrow.height).toBe(bCenter.y - aCenter.y);
    expect(arrow.label).toEqual({ text: 'loves' });
  });

  test('arrows are emitted before boxes so they render behind the fills', () => {
    const spec: DiagramSpec = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' }
      ],
      edges: [{ from: 'a', to: 'b' }]
    };
    const { skeletons } = diagramSpecToSkeleton(spec);
    const firstBox = skeletons.findIndex(skeleton => skeleton.type === 'rectangle');
    const firstArrow = skeletons.findIndex(skeleton => skeleton.type === 'arrow');
    expect(firstArrow).toBeLessThan(firstBox);
  });
});

describe('diagramSpecToSkeleton — free texts', () => {
  test('auto-stacks coordinate-less texts below the grid and honours explicit coords', () => {
    const spec: DiagramSpec = {
      nodes: [{ id: 'a', label: 'A' }],
      texts: [{ text: 'auto' }, { text: 'fixed', x: 999, y: 5 }]
    };
    const { skeletons } = diagramSpecToSkeleton(spec);
    const texts = skeletons.filter(skeleton => skeleton.type === 'text');
    expect(texts).toHaveLength(2);
    const auto = texts.find(t => t.text === 'auto')!;
    const fixed = texts.find(t => t.text === 'fixed')!;
    const rect = box(skeletons, `${DIAGRAM_NODE_ID_PREFIX}a-0`);
    expect(auto.y as number).toBeGreaterThan((rect.y as number) + (rect.height as number));
    expect(fixed.x).toBe(999);
    expect(fixed.y).toBe(5);
  });
});

describe('validateDiagramSpec — invalid specs throw DiagramSpecError', () => {
  const cases: [string, unknown][] = [
    ['non-object spec', 42],
    ['null spec', null],
    ['array spec', []],
    ['missing nodes', {}],
    ['empty nodes', { nodes: [] }],
    ['node without id', { nodes: [{ label: 'A' }] }],
    ['node without label', { nodes: [{ id: 'a' }] }],
    ['blank node id', { nodes: [{ id: '   ', label: 'A' }] }],
    ['duplicate node ids', { nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }],
    ['invalid entity', { nodes: [{ id: 'a', label: 'A', entity: { kind: 'character' } }] }],
    ['edge to unknown node', { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'ghost' }] }],
    ['edge missing from', { nodes: [{ id: 'a', label: 'A' }], edges: [{ to: 'a' }] }],
    ['edges not an array', { nodes: [{ id: 'a', label: 'A' }], edges: {} }],
    ['text without text', { nodes: [{ id: 'a', label: 'A' }], texts: [{ x: 1 }] }],
    ['text with non-numeric coord', { nodes: [{ id: 'a', label: 'A' }], texts: [{ text: 't', x: 'nope' }] }]
  ];

  for (const [name, spec] of cases) {
    test(name, () => {
      expect(() => diagramSpecToSkeleton(spec)).toThrow(DiagramSpecError);
    });
  }

  test('a minimal valid spec passes and normalizes edges/texts to arrays', () => {
    const normalized = validateDiagramSpec({ nodes: [{ id: 'a', label: 'A' }] });
    expect(normalized.edges).toEqual([]);
    expect(normalized.texts).toEqual([]);
  });
});
