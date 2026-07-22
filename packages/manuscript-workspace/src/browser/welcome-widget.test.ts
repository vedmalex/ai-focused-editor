import { beforeEach, describe, expect, test } from 'bun:test';

/**
 * Smoke tests for both route branches of the welcome widget (tech_spec §F.7).
 *
 * WHY THE SHIM BELOW. `welcome-widget.ts` imports `@theia/core/lib/browser`,
 * which pulls in Lumino, which touches `document` AT MODULE LOAD. Bun has no
 * DOM, so without these globals the module cannot even be imported — never
 * mind rendered. The shim is deliberately dumb and lives only here: it exists
 * to let the module LOAD, not to emulate a browser. Nothing below renders into
 * it; the assertions are made over React ELEMENT TREES, which are plain
 * objects.
 *
 * The stated limit of §F.7, repeated so nobody mistakes this file for more than
 * it is: a real `ReactWidget` cannot be mounted in a bun test, so the "does it
 * actually work on screen" half of the acceptance criteria stays a manual check
 * in `qa.md`.
 *
 * WHY THIS FILE RUNS SEPARATELY. Importing the widget pulls in the Theia browser
 * barrels, whose inversify decorators execute at module load. Under a single
 * cross-package `bun test packages` process the load order differs from an
 * isolated run and those barrels break — first `WorkspaceDeleteHandler`
 * ("circular dependency problem"), and once that is stubbed, a half-initialised
 * `@theia/core/lib/browser` missing `LabelProvider`. Both are load-order
 * artefacts of the bundled Theia packages, not defects of this widget: the file
 * is green on its own and the widget builds and runs normally.
 *
 * So the root `test` script runs the suite in two passes — `test:packages`
 * ignores this path, `test:widget` runs it alone — and both must stay green.
 * A THIRD step now runs before them, `test:generated`: the ISS-098 tests at the
 * bottom resolve the production container module, which imports the git-ignored
 * `docs/docs-content.generated.ts`. Making the suite generate it is the honest
 * option — the alternative, a test that skips itself when the file is absent,
 * would be green on exactly the clean checkout where the binding matters most.
 * Do NOT rename this file away from `*.test.ts`: that pattern is what keeps it
 * out of `tsc` (tsconfig `exclude`) and out of the inventory extractor's scan,
 * and dropping it silently adds this file's fixtures to the documented surface.
 *
 * NOTE ON FIXTURES: plain quoted strings only — NEVER `String.raw`, which under
 * Bun replaces Cyrillic with escape sequences.
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
globals.document = stubDocument;
globals.window = globalThis;
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
const { FrontendApplicationConfigProvider } =
  await import('@theia/core/lib/browser/frontend-application-config-provider');
FrontendApplicationConfigProvider.set({ applicationName: 'test' } as never);

const { nls } = await import('@theia/core/lib/common/nls');
const { DocsContentProvider, DocsLang, DocsManifest, DocsPage } =
  await import('../common/docs/docs-contract') as typeof import('../common/docs/docs-contract');
const { sortDocsManifestEntries } = await import('../common/docs/docs-lang');
const { WelcomeDocsRenderer } = await import('./docs/welcome-docs-renderer');
const { WelcomeWidget, WelcomeCommands } = await import('./welcome-widget');
const React = (await import('@theia/core/shared/react')).default;
const { Container } = await import('@theia/core/shared/inversify');
const { DisposableCollection } = await import('@theia/core/lib/common');
const { EMPTY_DOCS_CONTENT_PROVIDER } = await import('./docs/empty-docs-content-provider');
const welcomeFrontendModule = (await import('./welcome-frontend-module')).default;

type ContentProvider = import('../common/docs/docs-contract').DocsContentProvider;
type Manifest = import('../common/docs/docs-contract').DocsManifest;
type Page = import('../common/docs/docs-contract').DocsPage;
type Lang = import('../common/docs/docs-contract').DocsLang;

void DocsContentProvider;
void DocsLang;
void DocsManifest;
void DocsPage;

// ---------------------------------------------------------------------------
// Fixtures: five ru pages — two top-level (home, start) plus two sections.
// ---------------------------------------------------------------------------

function makePage(id: string, title: string, order: number, section?: string): Page {
  return { id, lang: 'ru', title, order, section, markdown: `# ${title}\n`, covers: [] };
}

const ruPages: readonly Page[] = [
  makePage('home', 'Путеводитель', 0),
  makePage('start', 'С чего начать', 10),
  makePage('book/export', 'Экспорт книги', 20, 'Книга'),
  makePage('book/build', 'Сборка книги', 30, 'Книга'),
  makePage('write/focus', 'Режим фокуса', 40, 'Письмо')
];

function manifestOf(lang: Lang, pages: readonly Page[]): Manifest {
  return {
    lang,
    entries: sortDocsManifestEntries(
      pages.map(page => ({ id: page.id, title: page.title, order: page.order, section: page.section }))
    )
  };
}

/** ru: five pages; en: nothing — today's production state (§E.1). */
const provider: ContentProvider = {
  getPage: (lang, id) => (lang === 'ru' ? ruPages.find(page => page.id === id) : undefined),
  getManifest: lang => (lang === 'ru' ? manifestOf('ru', ruPages) : { lang, entries: [] })
};

interface Harness {
  readonly widget: any;
  readonly warnings: string[];
  readonly executed: string[];
  updates: number;
}

/**
 * A widget WITHOUT its constructor: `ReactWidget`'s own constructor builds a
 * React root over a real DOM node, which cannot exist here. `Object.create`
 * gives the prototype (i.e. every method under test) with none of that.
 */
function harness(options: {
  registered?: readonly string[];
  enabled?: readonly string[];
  recent?: readonly string[];
} = {}): Harness {
  const registered = new Set(options.registered ?? ['app.run']);
  const enabled = new Set(options.enabled ?? ['app.run']);
  const warnings: string[] = [];
  const executed: string[] = [];
  const widget: any = Object.create(WelcomeWidget.prototype);

  widget.route = { kind: 'home' };
  widget.checklists = new Map<string, Set<number>>();
  widget.docs = provider;
  widget.docsRenderer = new WelcomeDocsRenderer();
  widget.recent = [...(options.recent ?? ['file:///books/one'])];
  widget.catalog = [];
  widget.catalogLoaded = true;
  widget.commandRegistry = {
    getCommand: (id: string) => (registered.has(id) ? { id, label: id } : undefined),
    isEnabled: (id: string) => enabled.has(id),
    executeCommand: (id: string) => { executed.push(id); return Promise.resolve(); }
  };
  widget.messages = { warn: (text: string) => { warnings.push(text); return Promise.resolve(undefined); } };
  widget.preferenceService = { get: (name: string, fallback: unknown) => (name.includes('library') ? '' : fallback) };
  widget.labelProvider = { getName: () => 'one', getLongName: () => '/books/one' };
  widget.workspaceService = { open() {} };

  const result: Harness = { widget, warnings, executed, updates: 0 };
  widget.update = () => { result.updates++; };
  return result;
}

/** Children of a React element, flattened and stripped of the empty slots. */
function childrenOf(node: any): any[] {
  const children = node?.props?.children;
  const list = Array.isArray(children) ? children.flat(Infinity) : [children];
  return list.filter(child => child !== undefined && child !== null && child !== false);
}

/** Depth-first walk of a React element tree. */
function walk(node: any, visit: (element: any) => void): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (node.props) {
    visit(node);
  }
  for (const child of childrenOf(node)) {
    walk(child, visit);
  }
}

function collect(node: any, predicate: (element: any) => boolean): any[] {
  const found: any[] = [];
  walk(node, element => {
    if (predicate(element)) {
      found.push(element);
    }
  });
  return found;
}

function textOf(node: any): string {
  let text = '';
  walk(node, element => {
    for (const child of childrenOf(element)) {
      if (typeof child === 'string') {
        text += child;
      }
    }
  });
  return text;
}

beforeEach(() => {
  (nls as any).locale = undefined;
});

describe('the command the guide is opened by', () => {
  test('is declared next to its siblings with the specified id', () => {
    expect(WelcomeCommands.OPEN_DOCS.id).toBe('ai-focused-editor.welcome.openDocs');
  });
});

describe('home route — the eight existing affordances keep their places', () => {
  test('render() yields the six sections in the order of §D.2', () => {
    const { widget } = harness();
    const children = childrenOf(widget.render());
    expect(children).toHaveLength(6);
    expect(children[0].type).toBe('header');
    expect(children[1].props.className).toContain('afe-welcome-section');
    expect(children[2].props.className).toContain('afe-welcome-scenarios');
    expect(children[3].props.className).toContain('afe-welcome-catalog');
    expect(children[4].props.className).toContain('afe-welcome-section');
    expect(children[5].type).toBe('footer');
  });

  test('the guide cards sit between Start and My Books, never before Start', () => {
    const { widget } = harness();
    const classes = childrenOf(widget.render()).map((child: any) => String(child.props.className ?? child.type));
    expect(classes.findIndex(name => name.includes('afe-welcome-scenarios')))
      .toBeGreaterThan(classes.findIndex(name => name.includes('afe-welcome-section')));
  });

  test('Start still offers New Book, Open Folder and Book Doctor', () => {
    const { widget } = harness();
    const buttons = collect(widget.renderStart(), element => element.type === 'button');
    expect(buttons).toHaveLength(3);
    expect(textOf(widget.renderStart())).toContain('Create New Book');
  });

  test('the show-on-startup checkbox is still in the footer', () => {
    const { widget } = harness();
    const boxes = collect(widget.renderFooter(), element => element.props?.type === 'checkbox');
    expect(boxes).toHaveLength(1);
  });

  test('Recent still lists the recent workspaces', () => {
    const { widget } = harness({ recent: ['file:///books/one', 'file:///books/two'] });
    const rows = collect(widget.renderRecent(), element => element.props?.className === 'afe-welcome-recent-row');
    expect(rows).toHaveLength(2);
  });
});

describe('scenario cards on the home route', () => {
  test('are built from the manifest and cover every sectioned page', () => {
    const { widget } = harness();
    const cards = collect(widget.renderScenarioCards(), element => element.props?.className === 'afe-welcome-scenario-card');
    expect(cards.map((card: any) => card.key)).toEqual(['book/export', 'book/build', 'write/focus']);
  });

  test('clicking a card enters the guide at that page', () => {
    const h = harness();
    const cards = collect(h.widget.renderScenarioCards(), element => element.props?.className === 'afe-welcome-scenario-card');
    cards[1].props.onClick();
    expect(h.widget.route).toEqual({ kind: 'docs', pageId: 'book/build' });
  });

  test('an EMPTY guide (no pages at all) renders no section rather than an empty one', () => {
    const { widget } = harness();
    widget.docs = { getPage: () => undefined, getManifest: (lang: Lang) => ({ lang, entries: [] }) };
    expect(widget.renderScenarioCards()).toBeUndefined();
  });
});

describe('docs route', () => {
  test('renders exactly the navigation and the page container', () => {
    const { widget } = harness();
    widget.route = { kind: 'docs', pageId: 'start' };
    const children = childrenOf(widget.render());
    expect(children).toHaveLength(2);
    expect(children[0].type).toBe('nav');
    expect(children[1].props.className).toBe('afe-docs-page');
    expect(typeof children[1].props.ref).toBe('function');
  });

  test('an unresolvable page id degrades to the home route instead of an empty shell', () => {
    const { widget } = harness();
    widget.route = { kind: 'docs', pageId: 'ghost' };
    const children = childrenOf(widget.render());
    expect(widget.route).toEqual({ kind: 'home' });
    expect(children).toHaveLength(6);
  });
});

describe('renderDocsNav (F-D5-1)', () => {
  const page = () => ruPages.find(entry => entry.id === 'book/export')!;

  test('lists all five pages in the §B.3 order', () => {
    const { widget } = harness();
    const items = collect(widget.renderDocsNav(page()), element => element.props?.['data-afe-nav'] === 'page');
    expect(items.map((item: any) => item.props['data-afe-nav-page']))
      .toEqual(['home', 'start', 'book/export', 'book/build', 'write/focus']);
  });

  test('prints a heading per NAMED group and none for the section-less one', () => {
    const { widget } = harness();
    const headings = collect(widget.renderDocsNav(page()), element => element.props?.className === 'afe-docs-nav-section');
    expect(headings.map((heading: any) => textOf(heading))).toEqual(['Книга', 'Письмо']);
  });

  test('carries EXACTLY ONE way back to the welcome screen', () => {
    const { widget } = harness();
    const home = collect(widget.renderDocsNav(page()), element => element.props?.['data-afe-nav'] === 'home');
    expect(home).toHaveLength(1);
  });

  test('marks the current page: disabled, aria-current and the modifier class', () => {
    const { widget } = harness();
    const items = collect(widget.renderDocsNav(page()), element => element.props?.['data-afe-nav'] === 'page');
    const current = items.filter((item: any) => item.props.disabled);
    expect(current).toHaveLength(1);
    expect(current[0].props['data-afe-nav-page']).toBe('book/export');
    expect(current[0].props['aria-current']).toBe('page');
    expect(current[0].props.className).toContain('afe-docs-nav-item--current');
  });

  test('clicking an item moves the route; clicking Back leaves the guide', () => {
    const h = harness();
    h.widget.route = { kind: 'docs', pageId: 'book/export' };
    const nav = h.widget.renderDocsNav(page());
    const items = collect(nav, element => element.props?.['data-afe-nav'] === 'page');
    items.find((item: any) => item.props['data-afe-nav-page'] === 'write/focus').props.onClick();
    expect(h.widget.route).toEqual({ kind: 'docs', pageId: 'write/focus' });

    const back = collect(nav, element => element.props?.['data-afe-nav'] === 'home')[0];
    back.props.onClick();
    expect(h.widget.route).toEqual({ kind: 'home' });
  });
});

describe('explicit English with an empty en set (F-D6-1)', () => {
  test('the navigation falls back to the ru pages instead of going blank', () => {
    (nls as any).locale = 'en';
    const { widget } = harness();
    const items = collect(
      widget.renderDocsNav(ruPages[0]),
      element => element.props?.['data-afe-nav'] === 'page'
    );
    expect(items).toHaveLength(5);
  });

  test('the scenario cards stay non-empty', () => {
    (nls as any).locale = 'en';
    const { widget } = harness();
    const cards = collect(widget.renderScenarioCards(), element => element.props?.className === 'afe-welcome-scenario-card');
    expect(cards.length).toBeGreaterThan(0);
  });
});

describe('openDocs is the single route-changing door', () => {
  test('an unknown page leaves the route alone and warns', () => {
    const h = harness();
    h.widget.openDocs('ghost');
    expect(h.widget.route).toEqual({ kind: 'home' });
    expect(h.warnings).toHaveLength(1);
  });

  test('a known page enters the guide and repaints', () => {
    const h = harness();
    h.widget.openDocs('start');
    expect(h.widget.route).toEqual({ kind: 'docs', pageId: 'start' });
    expect(h.updates).toBe(1);
  });
});

describe('line 2 of the no-dead-buttons contract (click time)', () => {
  test('an unregistered command is ignored silently — its button already said so', () => {
    const h = harness({ registered: [] });
    h.widget.invokeDocsCommand('app.run');
    expect(h.executed).toHaveLength(0);
    expect(h.warnings).toHaveLength(0);
  });

  test('a registered but currently disabled command WARNS and is not executed', () => {
    const h = harness({ registered: ['app.run'], enabled: [] });
    h.widget.invokeDocsCommand('app.run');
    expect(h.executed).toHaveLength(0);
    expect(h.warnings).toHaveLength(1);
  });

  test('an enabled command is executed', () => {
    const h = harness();
    h.widget.invokeDocsCommand('app.run');
    expect(h.executed).toEqual(['app.run']);
  });

  test('the settings directive falls back through both preference commands, then warns', () => {
    const withFilter = harness({ registered: ['preferences:open'] });
    withFilter.widget.openSettingsQuery('editor.font');
    expect(withFilter.executed).toEqual(['preferences:open']);

    const withoutFilter = harness({ registered: ['workbench.action.openGlobalSettings'] });
    withoutFilter.widget.openSettingsQuery('editor.font');
    expect(withoutFilter.executed).toEqual(['workbench.action.openGlobalSettings']);

    const withNeither = harness({ registered: [] });
    withNeither.widget.openSettingsQuery('editor.font');
    expect(withNeither.executed).toHaveLength(0);
    expect(withNeither.warnings).toHaveLength(1);
  });
});

describe('checklist toggling', () => {
  test('toggles on and off under a page-scoped key', () => {
    const h = harness();
    h.widget.route = { kind: 'docs', pageId: 'start' };
    h.widget.toggleStep('setup', 1);
    expect(h.widget.storeState().checklists).toEqual({ 'start::setup': [1] });
    h.widget.toggleStep('setup', 1);
    expect(h.widget.storeState().checklists).toEqual({});
  });

  test('a NaN or negative index from the dataset is ignored', () => {
    const h = harness();
    h.widget.route = { kind: 'docs', pageId: 'start' };
    h.widget.toggleStep('setup', Number('not-a-number'));
    h.widget.toggleStep('setup', -1);
    h.widget.toggleStep('setup', 1.5);
    expect(h.widget.storeState().checklists).toEqual({});
  });
});

describe('storeState / restoreState', () => {
  test('a valid state round-trips unchanged', () => {
    const h = harness();
    const state = { route: { kind: 'docs', pageId: 'book/export' }, checklists: { 'book/export::setup': [0, 2] } };
    h.widget.restoreState(state);
    expect(h.widget.storeState()).toEqual(state);
  });

  test('a page id that no longer exists degrades to the home route', () => {
    const h = harness();
    h.widget.restoreState({ route: { kind: 'docs', pageId: 'ghost' }, checklists: {} });
    expect(h.widget.route).toEqual({ kind: 'home' });
  });

  test('malformed checklist payloads are dropped, not trusted', () => {
    const h = harness();
    h.widget.restoreState({
      route: { kind: 'home' },
      checklists: { good: [0, 1], notAnArray: 3, negative: [-1], fractional: [0.5], mixed: [1, 'x', -2] }
    });
    expect(h.widget.storeState().checklists).toEqual({ good: [0, 1], mixed: [1] });
  });

  test('undefined state (a first-ever launch) is safe', () => {
    const h = harness();
    h.widget.restoreState(undefined);
    expect(h.widget.route).toEqual({ kind: 'home' });
    expect(h.widget.storeState().checklists).toEqual({});
  });
});

describe('the widget identity the layout restore depends on', () => {
  test('the id and factory id are untouched', () => {
    expect(WelcomeWidget.ID).toBe('ai-focused-editor.welcome');
    expect(WelcomeCommands.OPEN.id).toBe('ai-focused-editor.welcome.open');
    expect(WelcomeCommands.NEW_BOOK.id).toBe('ai-focused-editor.book.newBook');
  });
});

describe('the render context handed to the renderer', () => {
  test('reports registration, default captions and checklist state', () => {
    const h = harness();
    h.widget.route = { kind: 'docs', pageId: 'start' };
    h.widget.toggleStep('setup', 2);
    const ctx = h.widget.docsRenderContext(ruPages[1]);
    expect(ctx.isCommandRegistered('app.run')).toBe(true);
    expect(ctx.isCommandRegistered('ghost.command')).toBe(false);
    expect(ctx.commandLabel('app.run')).toBe('app.run');
    expect(ctx.isStepChecked('setup', 2)).toBe(true);
    expect(ctx.isStepChecked('setup', 0)).toBe(false);
  });
});

describe('keyboard activation of a checklist step (ISS-094)', () => {
  /**
   * A minimal keyboard event whose `target.closest()` answers with `element` —
   * the same shape the real delegated handler receives, since it never touches
   * anything else on the event.
   */
  function keydown(key: string, directive: string, extra: Record<string, string> = {}) {
    const state = { prevented: false };
    const element = { dataset: { afeDirective: directive, ...extra } };
    return {
      state,
      event: {
        key,
        target: { closest: () => element },
        preventDefault: () => { state.prevented = true; }
      } as unknown as KeyboardEvent
    };
  }

  const stepKeys = { afeStep: 'first-run', afeStepIndex: '1' };

  test('Space toggles the step the focus is on — the row is a span, not a button', () => {
    const h = harness();
    h.widget.route = { kind: 'docs', pageId: 'start' };
    const { event, state } = keydown(' ', 'step', stepKeys);
    h.widget.onDocsKeydown(event);
    expect(h.widget.storeState().checklists).toEqual({ 'start::first-run': [1] });
    expect(state.prevented).toBe(true);
  });

  test('Enter toggles it too, and a second press unticks it', () => {
    const h = harness();
    h.widget.route = { kind: 'docs', pageId: 'start' };
    h.widget.onDocsKeydown(keydown('Enter', 'step', stepKeys).event);
    expect(h.widget.storeState().checklists).toEqual({ 'start::first-run': [1] });
    h.widget.onDocsKeydown(keydown('Enter', 'step', stepKeys).event);
    expect(h.widget.storeState().checklists).toEqual({});
  });

  test('any other key is left to the browser', () => {
    const h = harness();
    h.widget.route = { kind: 'docs', pageId: 'start' };
    const { event, state } = keydown('a', 'step', stepKeys);
    h.widget.onDocsKeydown(event);
    expect(h.widget.storeState().checklists).toEqual({});
    expect(state.prevented).toBe(false);
  });

  test('Enter on the ACTION nested inside a step is not intercepted — or it would fire twice', () => {
    // A <button> is activated by the browser through a synthesised click, which
    // the click handler already answers. Handling it here as well would run the
    // command twice; toggling the step would be plain wrong.
    const h = harness();
    h.widget.route = { kind: 'docs', pageId: 'start' };
    const { event, state } = keydown('Enter', 'action', { afeCommand: 'app.run' });
    h.widget.onDocsKeydown(event);
    expect(h.executed).toHaveLength(0);
    expect(h.widget.storeState().checklists).toEqual({});
    expect(state.prevented).toBe(false);
  });

  test('a keypress outside any directive is ignored', () => {
    const h = harness();
    h.widget.route = { kind: 'docs', pageId: 'start' };
    h.widget.onDocsKeydown({
      key: ' ',
      target: { closest: () => null },
      preventDefault: () => { throw new Error('must not preventDefault'); }
    } as unknown as KeyboardEvent);
    expect(h.widget.storeState().checklists).toEqual({});
  });
});

describe('the delegated listeners of a mounted guide page', () => {
  /** A page container that records only what the widget does to it. */
  function recordingNode(log: string[]): any {
    return {
      textContent: 'stale',
      addEventListener: (type: string) => log.push(`+${type}`),
      removeEventListener: (type: string) => log.push(`-${type}`),
      appendChild: () => undefined
    };
  }

  test('mounting registers BOTH click and keydown; unmounting removes exactly those', () => {
    // Without this, the keyboard half of ISS-094 could be deleted from
    // `mountDocs` and every handler test would still pass — they call the
    // methods directly and never ask whether anything is listening.
    const h = harness();
    const log: string[] = [];
    h.widget.docsListeners = new DisposableCollection();
    h.widget.mountDocs(recordingNode(log), ruPages[1]);
    expect(log).toEqual(['+click', '+keydown']);
    h.widget.mountDocs(null, ruPages[1]);
    expect(log).toEqual(['+click', '+keydown', '-click', '-keydown']);
  });

  test('a re-render swaps the listeners instead of stacking a second pair', () => {
    const h = harness();
    const log: string[] = [];
    h.widget.docsListeners = new DisposableCollection();
    h.widget.mountDocs(recordingNode(log), ruPages[1]);
    h.widget.mountDocs(recordingNode(log), ruPages[1]);
    expect(log).toEqual(['+click', '+keydown', '-click', '-keydown', '+click', '+keydown']);
  });
});

describe('what the PRODUCTION frontend module actually binds (ISS-098)', () => {
  /**
   * The defect this replaces was invisible to everything: `DocsContentProvider`
   * was bound to `EMPTY_DOCS_CONTENT_PROVIDER`, so not one generated page ever
   * reached the running app — with a green build and a green suite. Only
   * launching the product showed it.
   *
   * So the assertion is made against the REAL container module, not against the
   * generated module directly: the generated content being fine proves nothing
   * about which implementation the app resolves. And it is a CONTENT assertion,
   * not an identity one — the empty provider is a legitimate object that the
   * tests themselves use, and "not that exact constant" would be satisfied by
   * any other empty provider.
   */
  function boundProvider(): ContentProvider {
    const container = new Container();
    container.load(welcomeFrontendModule as never);
    return container.get(DocsContentProvider) as ContentProvider;
  }

  test('the guide the app resolves has pages, and every one of them has a body', () => {
    const provider = boundProvider();
    const entries = provider.getManifest('ru').entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const page = provider.getPage('ru', entry.id);
      expect(page).toBeDefined();
      expect(page!.title.trim().length).toBeGreaterThan(0);
      expect(page!.markdown.trim().length).toBeGreaterThan(0);
    }
  });

  test('the guide root page is among them — the entry point of every route', () => {
    expect(boundProvider().getPage('ru', 'home')).toBeDefined();
  });

  test('and it is not the empty stand-in, which stays in the tree for the tests', () => {
    expect(boundProvider()).not.toBe(EMPTY_DOCS_CONTENT_PROVIDER);
    // The stand-in is still a valid provider — the point is WHICH one is bound.
    expect(EMPTY_DOCS_CONTENT_PROVIDER.getManifest('ru').entries).toHaveLength(0);
  });
});

describe('React.createElement only — the package compiles without JSX', () => {
  test('the rendered tree is built from plain element objects', () => {
    const { widget } = harness();
    const node = widget.render();
    expect(React.isValidElement(node)).toBe(true);
  });
});
