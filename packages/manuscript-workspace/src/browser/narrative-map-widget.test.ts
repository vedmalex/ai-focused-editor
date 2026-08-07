import { afterAll, describe, expect, test } from 'bun:test';
import type {
  NarrativeGraphSnapshot,
  NarrativeOwnershipEntry,
  NarrativeOwnershipTransfer,
  NarrativeRelationEdge,
  NarrativeRelationNode
} from '../common';

/**
 * TASK-022 UR-044/UR-026 — the "зуб" (breaking teeth) for the Narrative Map's
 * origin distinction and its "show co-mentions" toggle.
 *
 * WHY THE SHIM BELOW, AND WHY THIS FILE RUNS SEPARATELY (`test:widget`, not
 * `test:packages`). `narrative-map-widget.ts` extends `ReactWidget`, which
 * pulls in Lumino, which touches `document` AT MODULE LOAD — bun has no DOM,
 * so without these globals the module cannot even be IMPORTED, never mind
 * instantiated. Same root cause and same fix `welcome-widget.test.ts` and
 * `narrative-consumer-baseline.test.ts` already use for their own widgets;
 * this file is added to `test:widget`'s explicit list and excluded from
 * `test:packages`'s glob for the identical reason those two are (a shared
 * `bun test packages` process breaks on Theia's inversify-decorated barrel
 * load order, independent of this widget's own correctness).
 *
 * TECHNIQUE: `Object.create(NarrativeMapWidget.prototype)` typed `any` —
 * bypasses Inversify entirely, no real `StorageService`/DOM/mounted node.
 * `render()`/`computeVisibleGraph()` return plain React-element-tree objects
 * (`{type, props}`), which this file walks directly; nothing here mounts into
 * the shimmed `document`. Where a method under test calls `this.update()`
 * (the real one needs a mounted node this fixture never creates), the fixture
 * stubs it to a no-op instance property.
 */

const stubElement = (): Record<string, unknown> => {
  const node: any = {
    style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    dataset: {},
    children: [],
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    appendChild(child: unknown) { node.children.push(child); return child; },
    append(...items: unknown[]) { node.children.push(...items); },
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    matches: () => false,
    remove() {},
    focus() {},
    blur() {},
    cloneNode: () => stubElement(),
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 })
  };
  return node;
};

const stubDocument: any = {
  createElement: stubElement,
  createElementNS: stubElement,
  createTextNode: (text: string) => ({ text }),
  createDocumentFragment: stubElement,
  body: stubElement(),
  head: stubElement(),
  documentElement: stubElement(),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  queryCommandSupported: () => false,
  execCommand: () => false,
  hasFocus: () => false,
  getSelection: () => null,
  activeElement: null
};

const globals = globalThis as any;
globals.document = globals.document ?? stubDocument;
globals.window = globals.window ?? globalThis;
globals.location = globals.location ?? { href: 'http://localhost/' };
globals.navigator = globals.navigator ?? { userAgent: 'bun', platform: 'bun', language: 'en' };
globals.localStorage = globals.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globals.getComputedStyle = globals.getComputedStyle ?? (() => ({ getPropertyValue: () => '' }));
globals.matchMedia = globals.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
globals.MutationObserver = globals.MutationObserver ?? class { observe() {} disconnect() {} takeRecords() { return []; } };
globals.ResizeObserver = globals.ResizeObserver ?? class { observe() {} disconnect() {} unobserve() {} };
globals.requestAnimationFrame = globals.requestAnimationFrame ?? ((fn: () => void) => setTimeout(fn, 0) as unknown as number);
globals.cancelAnimationFrame = globals.cancelAnimationFrame ?? ((handle: number) => clearTimeout(handle));
for (const name of [
  'DragEvent', 'MouseEvent', 'KeyboardEvent', 'UIEvent', 'FocusEvent', 'WheelEvent', 'TouchEvent',
  'PointerEvent', 'CustomEvent', 'Event', 'InputEvent', 'ClipboardEvent', 'DataTransfer', 'DOMRect',
  'Range', 'Selection', 'Text', 'Document', 'DocumentFragment', 'HTMLElement', 'Element', 'Node',
  'HTMLDivElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLIFrameElement',
  'HTMLImageElement', 'SVGElement', 'CSSStyleDeclaration', 'StorageEvent', 'MessageEvent'
]) {
  if (globals[name] === undefined) {
    globals[name] = class {};
  }
}

// `@theia/workspace` reads the frontend application config at module load
// (reached transitively via `WorkspaceService`, which `narrative-map-widget.ts`
// injects). `FrontendApplicationConfigProvider` is a PROCESS-WIDE singleton
// whose `.set()` throws on a second call — under `test:widget`'s shared
// `bun test` process this file runs alongside three others that ALSO set it
// (`narrative-consumer-baseline.test.ts`, `semantic-link-contribution.test.ts`,
// `ai-write-provenance-tools.test.ts`), so this uses their SAME protocol:
// `.get()` first, `.set()` only in the catch, clean up only if WE set it.
const { FrontendApplicationConfigProvider } =
  await import('@theia/core/lib/browser/frontend-application-config-provider');
let weSetTheFrontendConfig = false;
try {
  FrontendApplicationConfigProvider.get();
} catch {
  FrontendApplicationConfigProvider.set({ applicationName: 'test' } as never);
  weSetTheFrontendConfig = true;
}
afterAll(() => {
  if (!weSetTheFrontendConfig) {
    return;
  }
  const win = globals.window as Record<string | symbol, unknown>;
  for (const symbol of Object.getOwnPropertySymbols(win)) {
    if (symbol.description === 'FrontendApplicationConfigProvider') {
      delete win[symbol];
    }
  }
});

const { NarrativeMapWidget } = await import('./narrative-map-widget');

function node(kind: string, entityId: string, appearances: number, label = `${entityId}!`): NarrativeRelationNode {
  return { id: `${kind}:${entityId}`, kind, entityId, label, appearances };
}

function derivedEdge(source: string, target: string, weight: number, sourceLabel = source, targetLabel = target): NarrativeRelationEdge {
  return { source, target, sourceLabel, targetLabel, weight, sharedChapters: ['0'], origin: 'derived' };
}

function authoredEdge(
  source: string,
  target: string,
  origin: 'explicit' | 'ai-candidate',
  sourceLabel = source,
  targetLabel = target
): NarrativeRelationEdge {
  return { source, target, sourceLabel, targetLabel, weight: 1, sharedChapters: [], origin, relType: 'ownership' };
}

/**
 * Mirrors the REAL shape `node-narrative-graph-service.test.ts` proves at the
 * assembler layer: `gandiva` (artifact) and `arjuna` (character) are BOTH
 * co-occurrence nodes (mentioned in prose) AND authored-edge endpoints;
 * `krishna` is co-occurrence-ONLY (never an ownership endpoint) — the node
 * that must disappear when the toggle is off; `varuna`/`bhima` are
 * authored-ONLY (no card, no prose mention) — the nodes `authoredNodes`
 * synthesizes so their edges have somewhere to draw to. `varuna` is
 * `explicit`, `bhima` is `ai-candidate` — one of each non-derived origin.
 */
function buildSnapshot(): NarrativeGraphSnapshot {
  const gandiva = node('artifact', 'gandiva', 3);
  const arjuna = node('character', 'arjuna', 2);
  const krishna = node('character', 'krishna', 2);
  const varuna: NarrativeRelationNode = { id: ':varuna', kind: '', entityId: 'varuna', label: 'Varuna', appearances: 0 };
  const bhima: NarrativeRelationNode = { id: ':bhima', kind: '', entityId: 'bhima', label: 'Bhima', appearances: 0 };

  return {
    timeline: [],
    ownership: [],
    nodes: [gandiva, arjuna, krishna],
    relations: [
      derivedEdge('artifact:gandiva', 'character:arjuna', 2, 'Gandiva', 'Arjuna'),
      derivedEdge('character:arjuna', 'character:krishna', 1, 'Arjuna', 'Krishna'),
      derivedEdge('artifact:gandiva', 'character:krishna', 1, 'Gandiva', 'Krishna')
    ],
    authoredEdges: [
      authoredEdge('artifact:gandiva', ':varuna', 'explicit', 'Gandiva', 'Varuna'),
      authoredEdge('artifact:gandiva', 'character:arjuna', 'explicit', 'Gandiva', 'Arjuna'),
      authoredEdge('artifact:gandiva', ':bhima', 'ai-candidate', 'Gandiva', 'Bhima')
    ],
    authoredNodes: [varuna, bhima],
    truncated: false,
    totalEntities: 3,
    diagnostics: []
  };
}

function buildWidget(overrides: Record<string, unknown> = {}): any {
  const widget: any = Object.create(NarrativeMapWidget.prototype);
  widget.loading = false;
  widget.showCoOccurrence = false;
  Object.assign(widget, overrides);
  return widget;
}

/** Depth-first collect of every element in a React-createElement tree whose
 *  `.type` matches (e.g. `'line'`, `'circle'`, `'input'`). */
function collectByType(tree: unknown, type: string, out: { props: Record<string, unknown> }[] = []): { props: Record<string, unknown> }[] {
  if (tree === null || tree === undefined || tree === false || typeof tree !== 'object') {
    return out;
  }
  if (Array.isArray(tree)) {
    for (const child of tree) {
      collectByType(child, type, out);
    }
    return out;
  }
  const element = tree as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === type && element.props) {
    out.push({ props: element.props });
  }
  if (element.props?.children !== undefined) {
    collectByType(element.props.children, type, out);
  }
  return out;
}

describe('NarrativeMapWidget.computeVisibleGraph — node/edge set by toggle (UR-044b)', () => {
  test('toggle OFF: only authored edges/nodes — derived (co-occurrence) is fully absent, explicit/ai-candidate are present', () => {
    const widget = buildWidget({ showCoOccurrence: false });
    const { nodes, edges } = widget.computeVisibleGraph(buildSnapshot());

    const origins = edges.map((edge: { origin: string }) => edge.origin).sort();
    expect(origins).toEqual(['ai-candidate', 'explicit', 'explicit']);
    expect(edges.some((edge: { origin: string }) => edge.origin === 'derived')).toBe(false);

    const nodeIds = new Set(nodes.map((item: NarrativeRelationNode) => item.id));
    expect(nodeIds.has('artifact:gandiva')).toBe(true);
    expect(nodeIds.has('character:arjuna')).toBe(true);
    expect(nodeIds.has(':varuna')).toBe(true);
    expect(nodeIds.has(':bhima')).toBe(true);
    // The co-occurrence-only node MUST NOT survive a clean ("только
    // авторское") map — this is UR-044b's actual behavioural content, not a
    // count that would pass just as well if the whole filter were missing.
    expect(nodeIds.has('character:krishna')).toBe(false);
    expect(nodes.length).toBe(4);
  });

  test('toggle ON (same snapshot, same widget): derived reappears alongside explicit/ai-candidate — proves OFF was a real filter, not an empty fixture', () => {
    const widget = buildWidget({ showCoOccurrence: true });
    const { nodes, edges } = widget.computeVisibleGraph(buildSnapshot());

    const originCounts = { derived: 0, explicit: 0, 'ai-candidate': 0 } as Record<string, number>;
    for (const edge of edges as { origin: string }[]) {
      originCounts[edge.origin] += 1;
    }
    expect(originCounts.derived).toBe(3);
    expect(originCounts.explicit).toBe(2);
    expect(originCounts['ai-candidate']).toBe(1);

    const nodeIds = new Set(nodes.map((item: NarrativeRelationNode) => item.id));
    expect(nodeIds.has('character:krishna')).toBe(true);
    expect(nodes.length).toBe(5);
    // No duplicate: gandiva/arjuna are endpoints of BOTH a derived and an
    // authored edge, but each appears in `nodes` exactly once.
    expect(nodes.filter((item: NarrativeRelationNode) => item.id === 'artifact:gandiva').length).toBe(1);
  });
});

describe('NarrativeMapWidget.render — origin is distinguishable by a non-colour attribute (UR-044a)', () => {
  test('toggle OFF: rendered <line> elements are only explicit/ai-candidate, each with a DIFFERENT strokeDasharray/strokeWidth pair', () => {
    const widget = buildWidget({ showCoOccurrence: false, snapshot: buildSnapshot() });
    const tree = widget.render();
    const lines = collectByType(tree, 'line');

    expect(lines.length).toBe(3);
    expect(lines.some(line => (line.props.className as string).includes('origin-derived'))).toBe(false);

    const explicitLines = lines.filter(line => (line.props.className as string).includes('origin-explicit'));
    const candidateLines = lines.filter(line => (line.props.className as string).includes('origin-ai-candidate'));
    expect(explicitLines.length).toBe(2);
    expect(candidateLines.length).toBe(1);

    // Pairwise non-colour distinction: explicit is solid (no dasharray),
    // ai-candidate has its own dash pattern, and the two strokeWidths differ.
    for (const line of explicitLines) {
      expect(line.props.strokeDasharray).toBeUndefined();
      expect(line.props.strokeWidth).toBe(3.5);
    }
    expect(candidateLines[0].props.strokeDasharray).toBe('5 3');
    expect(candidateLines[0].props.strokeWidth).toBe(2.25);
  });

  test('toggle ON: the derived line carries a THIRD, distinct strokeDasharray/strokeWidth pair (not confusable with either authored kind)', () => {
    const widget = buildWidget({ showCoOccurrence: true, snapshot: buildSnapshot() });
    const tree = widget.render();
    const lines = collectByType(tree, 'line');

    expect(lines.length).toBe(6);
    const derivedLines = lines.filter(line => (line.props.className as string).includes('origin-derived'));
    expect(derivedLines.length).toBe(3);
    for (const line of derivedLines) {
      expect(line.props.strokeDasharray).toBe('1 3');
      // Derived is weight-scaled — never coincides with the fixed authored
      // widths (3.5 / 2.25) for THIS fixture's weights (1 or 2, max 2).
      expect([3.5, 2.25]).not.toContain(line.props.strokeWidth);
    }

    const circles = collectByType(tree, 'circle');
    expect(circles.length).toBe(5);
  });

  test('toggle OFF: rendered <circle> (node dot) count matches the filtered node set, not the full snapshot', () => {
    const widget = buildWidget({ showCoOccurrence: false, snapshot: buildSnapshot() });
    const circles = collectByType(widget.render(), 'circle');
    expect(circles.length).toBe(4);
  });

  test('the toggle checkbox reflects showCoOccurrence and the legend names all three origins', () => {
    const offWidget = buildWidget({ showCoOccurrence: false, snapshot: buildSnapshot() });
    const onWidget = buildWidget({ showCoOccurrence: true, snapshot: buildSnapshot() });

    const [offCheckbox] = collectByType(offWidget.render(), 'input');
    const [onCheckbox] = collectByType(onWidget.render(), 'input');
    expect(offCheckbox.props.checked).toBe(false);
    expect(onCheckbox.props.checked).toBe(true);

    const legendItems = collectByType(offWidget.render(), 'li')
      .map(item => item.props.className as string);
    expect(legendItems.some(className => className.includes('origin-explicit'))).toBe(true);
    expect(legendItems.some(className => className.includes('origin-ai-candidate'))).toBe(true);
    expect(legendItems.some(className => className.includes('origin-derived'))).toBe(true);
  });
});

describe('NarrativeMapWidget ownership chain text — ai-candidate is distinguishable by TEXT, not only colour (UR-044a/UR-026)', () => {
  function transfer(): NarrativeOwnershipTransfer {
    const explicitEntry: NarrativeOwnershipEntry = { owner: 'varuna', ownerLabel: 'Varuna', origin: 'explicit' };
    const candidateEntry: NarrativeOwnershipEntry = { owner: 'bhima', ownerLabel: 'Bhima', origin: 'ai-candidate' };
    return { artifactId: 'gandiva', artifactLabel: 'Gandiva', path: 'entities/artifacts/gandiva.yaml', entries: [explicitEntry, candidateEntry] };
  }

  test('an explicit hop renders the plain label; an ai-candidate hop renders the label PLUS a text suffix', () => {
    const widget = buildWidget();
    const explicitEntry: NarrativeOwnershipEntry = { owner: 'varuna', ownerLabel: 'Varuna', origin: 'explicit' };
    const candidateEntry: NarrativeOwnershipEntry = { owner: 'bhima', ownerLabel: 'Bhima', origin: 'ai-candidate' };

    const explicitNode: any = widget.renderOwnershipLink('gandiva', explicitEntry, 0);
    const candidateNode: any = widget.renderOwnershipLink('gandiva', candidateEntry, 1);

    expect(explicitNode.props.className).toBe('afe-narrative-ownership-link origin-explicit');
    expect(explicitNode.props.children).toBe('Varuna');

    expect(candidateNode.props.className).toBe('afe-narrative-ownership-link origin-ai-candidate');
    expect(candidateNode.props.children).not.toBe('Bhima');
    expect(String(candidateNode.props.children)).toContain('Bhima');
    expect(String(candidateNode.props.children)).not.toBe(String(explicitNode.props.children).replace('Varuna', 'Bhima'));
  });

  test('renderOwnershipTransfer places both origins in the same chain, each individually tagged', () => {
    const widget = buildWidget();
    const tree = widget.renderOwnershipTransfer(transfer());
    const links = collectByType(tree, 'span').filter(item =>
      (item.props.className as string | undefined)?.startsWith('afe-narrative-ownership-link'));
    expect(links.length).toBe(2);
    expect(links[0].props.className).toContain('origin-explicit');
    expect(links[1].props.className).toContain('origin-ai-candidate');
  });
});

describe('NarrativeMapWidget toggle persistence (UR-044b: "переживать перезапуск")', () => {
  test('setShowCoOccurrence persists via storageService under the documented key', async () => {
    const calls: { key: string; value: unknown }[] = [];
    const widget = buildWidget({
      showCoOccurrence: false,
      update: () => { /* no real DOM in this fixture */ },
      storageService: {
        setData: async (key: string, value: unknown) => { calls.push({ key, value }); }
      }
    });

    await widget.setShowCoOccurrence(true);

    expect(widget.showCoOccurrence).toBe(true);
    expect(calls).toEqual([{ key: 'afe-narrative-map:show-co-occurrence', value: true }]);
  });

  test('initialize() restores the toggle from storageService BEFORE the first refresh (no flash)', async () => {
    const order: string[] = [];
    const widget = buildWidget({
      storageService: {
        getData: async () => { order.push('getData'); return true; }
      },
      refresh: async () => { order.push('refresh'); }
    });

    await widget.initialize();

    expect(widget.showCoOccurrence).toBe(true);
    expect(order).toEqual(['getData', 'refresh']);
  });

  test('initialize() defaults to OFF when nothing was persisted yet (UR-044b: default-off on a fresh book)', async () => {
    const widget = buildWidget({
      storageService: { getData: async () => undefined },
      refresh: async () => { /* no-op */ }
    });

    await widget.initialize();

    expect(widget.showCoOccurrence).toBe(false);
  });
});
