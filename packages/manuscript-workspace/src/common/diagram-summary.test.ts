import { describe, expect, test } from 'bun:test';
import { summarizeExcalidrawScene, type DiagramElement } from './diagram-summary';
import { buildEntityLink } from './relations-map';

/**
 * A relations-map-shaped fixture: two rectangle nodes, each with a bound text
 * label and an `afe-entity://` link, connected by a geometric arrow (start/end
 * from center to center, NO bindings — exactly what the generator writes).
 */
function relationsMapScene(): { elements: DiagramElement[] } {
  const krishnaCenter = { x: 100, y: 100 };
  const arjunaCenter = { x: 400, y: 100 };
  return {
    elements: [
      {
        id: 'afe-map-node-character-krishna',
        type: 'rectangle',
        x: krishnaCenter.x - 85,
        y: krishnaCenter.y - 30,
        width: 170,
        height: 60,
        link: buildEntityLink('character', 'krishna'),
        boundElements: [{ id: 'label-krishna', type: 'text' }]
      },
      {
        id: 'label-krishna',
        type: 'text',
        x: 40,
        y: 90,
        width: 120,
        height: 20,
        text: 'Krishna',
        containerId: 'afe-map-node-character-krishna'
      },
      {
        id: 'afe-map-node-character-arjuna',
        type: 'rectangle',
        x: arjunaCenter.x - 85,
        y: arjunaCenter.y - 30,
        width: 170,
        height: 60,
        link: buildEntityLink('character', 'arjuna'),
        boundElements: [{ id: 'label-arjuna', type: 'text' }]
      },
      {
        id: 'label-arjuna',
        type: 'text',
        x: 340,
        y: 90,
        width: 120,
        height: 20,
        text: 'Arjuna',
        containerId: 'afe-map-node-character-arjuna'
      },
      {
        id: 'afe-map-edge',
        type: 'arrow',
        x: krishnaCenter.x,
        y: krishnaCenter.y,
        width: arjunaCenter.x - krishnaCenter.x,
        height: arjunaCenter.y - krishnaCenter.y,
        points: [[0, 0], [arjunaCenter.x - krishnaCenter.x, arjunaCenter.y - krishnaCenter.y]]
      }
    ]
  };
}

describe('summarizeExcalidrawScene — relations-map-shaped scene', () => {
  const summary = summarizeExcalidrawScene(relationsMapScene(), { title: 'sources/relations-map.excalidraw' });

  test('renders the title header', () => {
    expect(summary).toContain('# Diagram: sources/relations-map.excalidraw');
  });

  test('lists node labels with their afe-entity refs', () => {
    expect(summary).toContain('Krishna (→ character:krishna)');
    expect(summary).toContain('Arjuna (→ character:arjuna)');
  });

  test('resolves the unbound arrow to A -> B by nearest node center', () => {
    expect(summary).toContain('Krishna -> Arjuna');
  });

  test('counts elements by shape type', () => {
    expect(summary).toContain('rectangle: 2');
    expect(summary).toContain('text: 2');
    expect(summary).toContain('arrow: 1');
  });

  test('does not surface bound labels as free-standing text', () => {
    expect(summary).not.toContain('## Text');
  });
});

describe('summarizeExcalidrawScene — bound arrow with a relation label', () => {
  const scene: { elements: DiagramElement[] } = {
    elements: [
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
      { id: 'a-label', type: 'text', x: 10, y: 10, width: 80, height: 20, text: 'Start', containerId: 'a' },
      { id: 'b', type: 'ellipse', x: 300, y: 0, width: 100, height: 50 },
      { id: 'b-label', type: 'text', x: 310, y: 10, width: 80, height: 20, text: 'End', containerId: 'b' },
      {
        id: 'edge',
        type: 'arrow',
        x: 100,
        y: 25,
        width: 200,
        height: 0,
        startBinding: { elementId: 'a' },
        endBinding: { elementId: 'b' },
        boundElements: [{ id: 'edge-label', type: 'text' }]
      },
      { id: 'edge-label', type: 'text', x: 180, y: 15, width: 40, height: 20, text: 'leads to', containerId: 'edge' }
    ]
  };
  const summary = summarizeExcalidrawScene(scene);

  test('uses the explicit bindings and shows the arrow relation label', () => {
    expect(summary).toContain('Start -> End (leads to)');
  });

  test('the arrow label is not listed as free-standing text', () => {
    expect(summary).not.toContain('- leads to');
  });
});

describe('summarizeExcalidrawScene — free-standing text and mixed shapes', () => {
  const scene: { elements: DiagramElement[] } = {
    elements: [
      { id: 't1', type: 'text', x: 0, y: 0, width: 200, height: 20, text: 'Chapter outline' },
      { id: 't2', type: 'text', x: 0, y: 40, width: 200, height: 20, text: '  spaced   note  ' },
      { id: 'd1', type: 'diamond', x: 0, y: 80, width: 100, height: 60, link: 'https://example.com' }
    ]
  };
  const summary = summarizeExcalidrawScene(scene);

  test('lists free-standing text, whitespace-normalized', () => {
    expect(summary).toContain('## Text (2)');
    expect(summary).toContain('- Chapter outline');
    expect(summary).toContain('- spaced note');
  });

  test('shows an external link on an unlabeled shape as a plain link', () => {
    expect(summary).toContain('(link: https://example.com)');
  });
});

describe('summarizeExcalidrawScene — degenerate inputs', () => {
  test('empty scene object', () => {
    expect(summarizeExcalidrawScene({ elements: [] }, { title: 'x.excalidraw' }))
      .toBe('# Diagram: x.excalidraw\n\n(The diagram is empty — no elements.)');
  });

  test('non-scene input', () => {
    expect(summarizeExcalidrawScene(null)).toContain('empty');
    expect(summarizeExcalidrawScene('nope')).toContain('empty');
  });

  test('accepts a bare element array', () => {
    const summary = summarizeExcalidrawScene([
      { id: 'r', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }
    ]);
    expect(summary).toContain('rectangle: 1');
  });

  test('caps total output length', () => {
    const elements: DiagramElement[] = [];
    for (let i = 0; i < 500; i++) {
      elements.push({ id: `t${i}`, type: 'text', x: 0, y: i * 10, width: 100, height: 20, text: `line ${i}` });
    }
    const summary = summarizeExcalidrawScene({ elements }, { maxChars: 500 });
    expect(summary.length).toBeLessThanOrEqual(520);
    expect(summary).toContain('[...truncated]');
  });
});
