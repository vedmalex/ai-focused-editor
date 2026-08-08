/**
 * The timeline panel's RENDERED state, and its subscription (gh#48 WP-6).
 *
 * WHAT THIS FILE OWNS AND WHAT IT DOES NOT. Which rows survive a filter, which
 * are diagnostics and which of the three empty states applies are decided by
 * `timeline-view-model.ts` and asserted there against values. What only a widget
 * can get wrong is asserted here: that the decisions REACH the tree, that the
 * order toggle re-queries instead of re-sorting, that navigation degrades for a
 * whole-file reference, and that the subscription keeps firing.
 *
 * THE SUBSCRIPTION IS CHECKED WITH TWO SUCCESSIVE CHANGES, not one. gh#46's
 * list of defects that every green test missed has "a subscription that fired
 * once" on it: a handler that unsubscribes, or guards on a flag it never
 * clears, is indistinguishable from a working one under a single edit.
 *
 * The assertions read the React ELEMENT TREE, which is a plain object — a real
 * `ReactWidget` cannot be mounted under bun, and pretending otherwise is what
 * `welcome-widget.test.ts` records as the honest limit of this lane.
 */

import { describe, expect, test } from 'bun:test';

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
    // `monaco-editor-core`'s GPU decoration extractor calls `Element.append`
    // at MODULE LOAD (reached transitively once `semantic-markdown-preview-
    // widget.ts` — imported below for `segmentPreviewMarkdown` — pulls in
    // `MonacoEditorProvider`); without it that import throws before any test runs.
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
// NON-DESTRUCTIVE, and that is the whole difference from the shim this was
// copied from. The `test:widget` band runs its files in ONE process, and
// `welcome-widget.test.ts` installs a much richer stub; overwriting it from
// here left `react-dom`'s root undefined and took a neighbouring file's tests
// down with it. A shim exists to let a module LOAD — if one is already
// installed, it has already done that job.
globals.document = globals.document ?? stubDocument;
globals.window = globals.window ?? globalThis;
// `monaco-editor-core`'s dom.js reads `mainWindow.location.href` at module
// load, reached the same way `append` above is (via `MonacoEditorProvider`).
globals.location = globals.location ?? { href: 'http://localhost/' };
globals.navigator = globals.navigator ?? { userAgent: 'bun', platform: 'bun', language: 'en' };
globals.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globals.getComputedStyle = () => ({ getPropertyValue: () => '' });
globals.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globals.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globals.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
globals.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0) as unknown as number;
globals.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
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


// `@theia/workspace` reads the frontend application config at module load.
// Set idempotently: this band shares one process and its load order is not
// promised, so the file that gets here second must not throw.
const { FrontendApplicationConfigProvider } =
  await import('@theia/core/lib/browser/frontend-application-config-provider');
try {
  FrontendApplicationConfigProvider.set({ applicationName: 'test' } as never);
} catch {
  // Another file in this band configured it first.
}


const { TimelineWidget } = await import('./timeline-widget');

const ROOT = 'file:///workspace';
const TIMELINE = 'knowledge/timeline/main.yaml';
const CHAPTER = 'content/ch-01.md';

function ref(role: string, entityId: string, resolved = true) {
  return { role, raw: `${role}:${entityId}`, entityId, resolved };
}

function event(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    title: id,
    storyTime: { kind: 'unknown' },
    refs: [],
    origin: 'explicit',
    evidence: { path: TIMELINE, evidenceKind: 'whole-file' },
    sourceRefs: [],
    ...overrides
  };
}

const RANGE_REF = {
  path: CHAPTER,
  evidenceKind: 'range',
  range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } }
};

/** Story order and manuscript order DISAGREE here — a flashback. Without that
 *  the toggle could be a no-op and every assertion would still pass. */
const BY_ORDER: Record<string, any[]> = {
  story: [
    { event: event('flashback', { title: 'Воспоминание', sourceRefs: [RANGE_REF] }), relPath: TIMELINE },
    { event: event('opening', { title: 'Начало', origin: 'ai-candidate' }), relPath: TIMELINE }
  ],
  manuscript: [
    { event: event('opening', { title: 'Начало', origin: 'ai-candidate' }), relPath: TIMELINE },
    { event: event('flashback', { title: 'Воспоминание', sourceRefs: [RANGE_REF] }), relPath: TIMELINE }
  ]
};

interface Harness {
  widget: any;
  queries: { orderBy: string }[];
  opened: { uri: string; selection?: unknown }[];
  fire: (rootUri?: string) => void;
}

function harness(options: { events?: Record<string, any[]>; state?: any; noRoot?: boolean } = {}): Harness {
  const queries: { orderBy: string }[] = [];
  const opened: { uri: string; selection?: unknown }[] = [];
  const listeners: ((e: any) => void)[] = [];
  const byOrder = options.events ?? BY_ORDER;

  const widget: any = Object.create(TimelineWidget.prototype);
  // The fields `@postConstruct` would set, without running Lumino's ctor.
  widget.order = 'story';
  widget.filter = {};
  widget.events = [];
  widget.loading = false;
  widget.pendingRefresh = false;
  widget.state = undefined;
  widget.rootUri = undefined;
  widget.update = () => {};
  Object.defineProperty(widget, 'isVisible', { value: true, configurable: true });

  widget.knowledge = {
    listEvents: async (_root: string, query: { orderBy: string }) => {
      queries.push(query);
      return { state: options.state ?? { state: 'ready', generation: 1 }, data: byOrder[query.orderBy] ?? [] };
    }
  };
  widget.indexChangeWatcher = { onDidIndexChange: (fn: (e: any) => void) => (listeners.push(fn), { dispose() {} }) };
  widget.workspaceService = {
    ready: Promise.resolve(),
    tryGetRoots: () =>
      options.noRoot
        ? []
        : [{ resource: { toString: () => ROOT, resolve: (p: string) => ({ toString: () => `${ROOT}/${p}` }) } }],
    roots: Promise.resolve([])
  };
  // THE OPENER IS THE SEAM, NOT THE METHOD. An earlier edition replaced
  // `openEvidence` itself with a stand-in and then asserted against that
  // stand-in — the ninth "green by coincidence" of this epic, and a mutation
  // that manufactured a range for a whole-file reference stayed green because
  // the shipped method never ran. Theia's `open()` helper resolves an opener
  // from this service and calls it, so faking the service exercises the real
  // method all the way down.
  widget.openerService = {
    getOpener: async () => ({
      open: async (uri: any, opts?: { selection?: unknown }) => {
        opened.push(opts?.selection === undefined
          ? { uri: uri.toString() }
          : { uri: uri.toString(), selection: opts.selection });
      }
    })
  };

  // The subscription the real `init()` installs.
  widget.toDispose = { push() {} };
  listeners.push((e: any) => widget.onIndexChanged(e));

  return {
    widget,
    queries,
    opened,
    fire: (rootUri = ROOT) => listeners.forEach(fn => fn({ rootUri, generation: 1 }))
  };
}

/** Every element in a rendered tree, flattened. */
function walk(node: any, out: any[] = []): any[] {
  if (node === null || node === undefined || typeof node !== 'object') {
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach(item => walk(item, out));
    return out;
  }
  out.push(node);
  const children = node.props?.children;
  if (children !== undefined) {
    walk(children, out);
  }
  return out;
}

const rowIds = (widget: any): string[] =>
  walk(widget.render())
    .filter(node => node?.props?.['data-event'] !== undefined)
    .map(node => node.props['data-event']);

describe('the panel renders what the model decided', () => {
  test('rows reach the tree, in the order the service gave them', async () => {
    const h = harness();
    await h.widget.refresh();
    expect(rowIds(h.widget)).toEqual(['flashback', 'opening']);
  });

  test('origin is on the row, so explicit and ai-candidate are told apart', async () => {
    const h = harness();
    await h.widget.refresh();
    const origins = walk(h.widget.render())
      .filter(node => node?.props?.['data-event'] !== undefined)
      .map(node => node.props['data-origin']);
    expect(origins).toEqual(['explicit', 'ai-candidate']);
  });

  test('a filter narrows the TREE, not just the model', async () => {
    const h = harness();
    await h.widget.refresh();
    h.widget.setFilter({ search: 'Воспоминание' });
    expect(rowIds(h.widget)).toEqual(['flashback']);
    // PAIRED POSITIVE: clearing it brings the other row back, so "renders one
    // row" cannot pass.
    h.widget.setFilter({});
    expect(rowIds(h.widget)).toEqual(['flashback', 'opening']);
  });

  test('a broken reference renders as its own words and the view still stands', async () => {
    const h = harness({
      events: {
        story: [
          { event: event('broken', { refs: [ref('participant', 'nobody', false)] }), relPath: TIMELINE },
          { event: event('fine', { refs: [ref('participant', 'ivan', true)] }), relPath: TIMELINE }
        ]
      }
    });
    await h.widget.refresh();
    const nodes = walk(h.widget.render());
    expect(nodes.filter(n => n?.props?.['data-broken-ref'] !== undefined).map(n => n.props['data-broken-ref']))
      .toEqual(['participant:nobody']);
    // THE TWIN: the sound event carries no diagnostic, and BOTH rows render.
    expect(rowIds(h.widget)).toEqual(['broken', 'fine']);
    const marked = nodes.filter(n => n?.props?.['data-broken'] !== undefined);
    expect(marked).toHaveLength(1);
  });

  test('an unplaceable event stays in the list, carrying its reason', async () => {
    const h = harness({
      events: { story: [{ event: event('unplaced'), relPath: TIMELINE, orderExclusion: 'no-sequence' }] }
    });
    await h.widget.refresh();
    const nodes = walk(h.widget.render());
    expect(nodes.some(n => n?.props?.['data-unplaced'] === 'no-sequence')).toBe(true);
    expect(rowIds(h.widget)).toEqual(['unplaced']);
  });
});

describe('the order toggle re-queries rather than re-sorting', () => {
  test('switching asks the service for the other order, and the tree follows', async () => {
    const h = harness();
    await h.widget.refresh();
    expect(rowIds(h.widget)).toEqual(['flashback', 'opening']);

    await h.widget.setOrder('manuscript');
    // THE QUERY CHANGED — this is what stops a local comparator from passing.
    expect(h.queries.map(q => q.orderBy)).toEqual(['story', 'manuscript']);
    // AND SO DID THE TREE, in the direction the fixture makes unambiguous.
    expect(rowIds(h.widget)).toEqual(['opening', 'flashback']);
  });

  test('switching to the order already shown costs no round trip', async () => {
    const h = harness();
    await h.widget.refresh();
    await h.widget.setOrder('story');
    expect(h.queries).toHaveLength(1);
  });
});

describe('the subscription keeps firing', () => {
  test('TWO successive index changes each cause a refresh', async () => {
    const h = harness();
    await h.widget.refresh();
    expect(h.queries).toHaveLength(1);

    h.fire();
    await Promise.resolve();
    await Promise.resolve();
    const afterFirst = h.queries.length;
    expect(afterFirst).toBeGreaterThan(1);

    h.fire();
    await Promise.resolve();
    await Promise.resolve();
    // THE SECOND ONE IS THE POINT. A handler that fired once — disposed, or
    // guarded on a flag it never clears — passes every single-edit test.
    expect(h.queries.length).toBeGreaterThan(afterFirst);
  });

  test('a change in ANOTHER workspace is ignored', async () => {
    const h = harness();
    await h.widget.refresh();
    const before = h.queries.length;
    h.fire('file:///somewhere-else');
    // The SAME number of ticks the passing case above needs, so "no new query"
    // means the guard refused it rather than the test looking too early.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.queries).toHaveLength(before);
  });
});

describe('the panel says which kind of nothing', () => {
  const statusOf = (widget: any): string | undefined =>
    walk(widget.render()).find(n => n?.props?.['data-status'] !== undefined)?.props['data-status'];
  const emptyOf = (widget: any): string | undefined =>
    walk(widget.render()).find(n => n?.props?.['data-empty'] !== undefined)?.props['data-empty'];

  test('no events at all offers the command that creates one', async () => {
    const h = harness({ events: { story: [] } });
    await h.widget.refresh();
    expect(emptyOf(h.widget)).toBe('no-events');
  });

  test('a filter matching none says so INSTEAD — a different sentence', async () => {
    const h = harness();
    await h.widget.refresh();
    h.widget.setFilter({ search: 'ничего такого' });
    expect(emptyOf(h.widget)).toBe('no-matches');
  });

  test('a rebuilding index is not reported as an absence of events', async () => {
    // The confusion `Envelope` exists to prevent: an empty list under
    // `rebuilding` is not an authoritative "you have no events".
    const h = harness({ events: { story: [] }, state: { state: 'rebuilding', generation: 1 } });
    await h.widget.refresh();
    expect(statusOf(h.widget)).toBe('rebuilding');
  });

  test('a stale index still shows its rows, and says it may be behind', async () => {
    const h = harness({ state: { state: 'stale', generation: 1, staleReason: 'watcher-lost', staleSince: 1 } });
    await h.widget.refresh();
    expect(statusOf(h.widget)).toBe('stale');
    // ROWS STILL RENDER: stale means "possibly behind", not "unknown".
    expect(rowIds(h.widget)).toEqual(['flashback', 'opening']);
  });

  test('a failed index says so rather than showing an empty list', async () => {
    const h = harness({
      events: { story: [] },
      state: { state: 'failed', generation: 1, reason: { code: 'storage-corrupted', incidentId: 'x', occurrences: 1 } }
    });
    await h.widget.refresh();
    expect(statusOf(h.widget)).toBe('failed');
  });

  test('a ready index with rows shows no status line at all', async () => {
    // The paired negative for the five above: a panel that always showed a
    // banner would satisfy every one of them.
    const h = harness();
    await h.widget.refresh();
    expect(statusOf(h.widget)).toBeUndefined();
  });
});

describe('navigation degrades rather than lying', () => {
  test('a range reference opens the chapter AT the range', async () => {
    const h = harness();
    await h.widget.refresh();
    const row = walk(h.widget.render()).find(n => n?.props?.['data-event'] === 'flashback');
    const button = walk(row).find(n => n?.props?.className === 'afe-timeline-title');
    button.props.onClick();
    await Promise.resolve();
    expect(h.opened).toEqual([
      {
        uri: `${ROOT}/${CHAPTER}`,
        selection: {
          start: { line: 2, character: 0 },
          end: { line: 3, character: 0 }
        }
      }
    ]);
  });

  test('a WHOLE-FILE reference opens the chapter with NO selection', async () => {
    // The half the range case cannot cover: `evidence.ts` is explicit that a
    // manufactured range would make a weaker claim indistinguishable from a
    // precise one, and this is the only place that distinction is visible to an
    // author — the cursor either lands somewhere specific or it does not.
    const h = harness({
      events: {
        story: [
          {
            event: event('whole', { sourceRefs: [{ path: CHAPTER, evidenceKind: 'whole-file' }] }),
            relPath: TIMELINE
          }
        ]
      }
    });
    await h.widget.refresh();
    const row = walk(h.widget.render()).find(n => n?.props?.['data-event'] === 'whole');
    const button = walk(row).find(n => n?.props?.className === 'afe-timeline-title');
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.opened).toEqual([{ uri: `${ROOT}/${CHAPTER}` }]);
  });

  test('an event with no source reference offers no jump at all', async () => {
    // Better a disabled control than one that lands somewhere plausible and
    // wrong.
    const h = harness();
    await h.widget.refresh();
    const row = walk(h.widget.render()).find(n => n?.props?.['data-event'] === 'opening');
    const button = walk(row).find(n => n?.props?.className === 'afe-timeline-title');
    expect(button.props.disabled).toBe(true);
  });
});
