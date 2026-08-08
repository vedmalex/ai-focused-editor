/**
 * The command itself, through the COMMAND REGISTRY (gh#48 WP-5 re-gate, F3).
 *
 * WHY THIS FILE HAD TO EXIST. The contribution's own header claimed the "not one
 * byte of the chapter" invariant was "asserted by comparing bytes"; it was not.
 * The byte assertions lived one layer down, in the pure module, and they are
 * about the TIMELINE file. Nothing executed the command at all — not the
 * selection reading, not the whole-file fallback, not the refusal paths, not
 * `suggestTitle`. §5.7 asks for a byte comparison of the PROSE, and the plan's
 * WP-5 asked for two teeth by name: the chapter is unchanged, and the created
 * event is readable. Both are here.
 *
 * IT RUNS THE COMMAND THE WAY A PALETTE DOES — `commands.executeCommand(id)` —
 * rather than calling the method, so the registration is exercised too: a
 * command that is not registered, or registered under another id, fails here
 * instead of passing quietly.
 *
 * THE SEAMS ARE FAKED, THE LOGIC IS NOT. Editor, files, prompt and the
 * knowledge service are stand-ins; everything that decides what happens —
 * selection to range, the whole-file fallback, the refusal branches, the write
 * target, the shaping — is the shipped code.
 */

import { describe, expect, test } from 'bun:test';

/**
 * WHY THE DOM SHIM AND THE DYNAMIC IMPORTS. The contribution imports
 * `@theia/core/lib/browser`, which pulls in Lumino, which touches `document` AT
 * MODULE LOAD — so under bare `bun test` the module cannot even be imported.
 * Same shim, same reason and same shape as `welcome-widget.test.ts`; this file
 * therefore rides the `test:widget` band, which is §8's "test lanes from day
 * one" applied rather than rediscovered.
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

const { CommandRegistry } = await import('@theia/core/lib/common/command');
const URI = (await import('@theia/core/lib/common/uri')).default;
const { extractEvents } = await import('@ai-focused-editor/narrative-knowledge');
const { TimelineAuthoringContribution, TimelineCommands, suggestTitle } =
  await import('./timeline-authoring-contribution');
const { DEFAULT_TIMELINE_FILE } = await import('../common/timeline-event-authoring');

const ROOT = 'file:///workspace';
const CHAPTER = 'content/ch-01.md';
const CHAPTER_TEXT = ['# Глава первая', '', 'Иван приехал в город.', 'Было холодно.', ''].join('\n');

interface Harness {
  commands: InstanceType<typeof CommandRegistry>;
  files: Map<string, string>;
  messages: { kind: string; text: string }[];
  updated: string[];
}

/**
 * The contribution with its seams replaced.
 *
 * `selection` is given in the shape Theia hands over — zero-based line/character
 * — so the range arithmetic under test is the real one.
 */
function harness(options: {
  selection?: { start: { line: number; character: number }; end: { line: number; character: number } };
  timeline?: string;
  timelineUnreadable?: boolean;
  title?: string;
  cancelled?: boolean;
  editor?: boolean;
  chapterUri?: string;
  updateThrows?: boolean;
  writeThrows?: boolean;
} = {}): Harness {
  const files = new Map<string, string>([[`${ROOT}/${CHAPTER}`, CHAPTER_TEXT]]);
  if (options.timeline !== undefined) {
    files.set(`${ROOT}/${DEFAULT_TIMELINE_FILE}`, options.timeline);
  }
  const messages: { kind: string; text: string }[] = [];
  const updated: string[] = [];
  const selection = options.selection ?? {
    start: { line: 2, character: 0 },
    end: { line: 3, character: 13 }
  };

  const contribution = new TimelineAuthoringContribution();
  const uri = new URI(options.chapterUri ?? `${ROOT}/${CHAPTER}`);
  (contribution as any).editorManager = {
    currentEditor:
      options.editor === false
        ? undefined
        : {
            editor: {
              uri,
              selection,
              document: {
                getText: (range?: typeof selection) =>
                  range === undefined
                    ? CHAPTER_TEXT
                    : CHAPTER_TEXT.split('\n').slice(range.start.line, range.end.line + 1).join('\n')
              }
            }
          }
  };
  (contribution as any).workspaceService = { tryGetRoots: () => [{ resource: new URI(ROOT) }] };
  (contribution as any).quickInput = {
    input: async () => (options.cancelled === true ? undefined : options.title ?? 'Иван приезжает')
  };
  (contribution as any).fileService = {
    exists: async (target: URI) => files.has(target.toString()),
    read: async (target: URI) => {
      if (options.timelineUnreadable && target.toString().endsWith(DEFAULT_TIMELINE_FILE)) {
        throw new Error('EACCES');
      }
      const value = files.get(target.toString());
      if (value === undefined) {
        throw new Error('ENOENT');
      }
      return { value };
    },
    write: async (target: URI, content: string) => {
      if (options.writeThrows) {
        throw new Error('EROFS');
      }
      files.set(target.toString(), content);
    }
  };
  (contribution as any).knowledge = {
    updateDocument: async (target: string) => {
      if (options.updateThrows) {
        throw new Error('backend down');
      }
      updated.push(target);
    }
  };
  (contribution as any).messages = {
    warn: async (text: string) => void messages.push({ kind: 'warn', text }),
    info: async (text: string) => void messages.push({ kind: 'info', text }),
    error: async (text: string) => void messages.push({ kind: 'error', text })
  };

  const commands = new CommandRegistry({ getContributions: () => [contribution] } as any);
  commands.onStart();
  return { commands, files, messages, updated };
}

const run = async (h: Harness): Promise<void> => {
  await h.commands.executeCommand(TimelineCommands.ADD_EVENT_FROM_SELECTION.id);
};

describe('Add Event from Selection — §5.7, byte for byte', () => {
  test('the chapter is not touched, and the event IS written', async () => {
    const h = harness();
    await run(h);

    // THE INVARIANT, AS A BYTE COMPARISON RATHER THAN AN ABSENCE OF COMPLAINTS.
    expect(h.files.get(`${ROOT}/${CHAPTER}`)).toBe(CHAPTER_TEXT);
    // PAIRED POSITIVE: something DID happen, so "changes nothing at all" cannot
    // satisfy the line above.
    const timeline = h.files.get(`${ROOT}/${DEFAULT_TIMELINE_FILE}`);
    expect(timeline).toBeDefined();
    expect(h.updated).toEqual([`${ROOT}/${DEFAULT_TIMELINE_FILE}`]);
  });

  test('what was written is readable BY THE INDEXER, with the selected lines', async () => {
    const h = harness();
    await run(h);
    const timeline = h.files.get(`${ROOT}/${DEFAULT_TIMELINE_FILE}`)!;

    // Not "the YAML parses" — the actual extractor the index runs. A file that
    // parses and that `extractEvents` rejects would be a file the author never
    // sees an event from.
    const read = extractEvents({ path: DEFAULT_TIMELINE_FILE, text: timeline });
    expect(read.problems).toEqual([]);
    expect(read.events).toHaveLength(1);
    expect(read.events[0].title).toBe('Иван приезжает');
    expect(read.events[0].chapterPath).toBe(CHAPTER);
    expect(read.events[0].sourceRefs).toEqual([
      { path: CHAPTER, evidenceKind: 'range', range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } } }
    ]);
    // The author has not placed it yet — the command does not invent an order.
    expect(read.events[0].sequence).toBeUndefined();
  });

  test('an empty selection points at the whole file rather than at line zero', async () => {
    const h = harness({ selection: { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } } });
    await run(h);
    const read = extractEvents({
      path: DEFAULT_TIMELINE_FILE,
      text: h.files.get(`${ROOT}/${DEFAULT_TIMELINE_FILE}`)!
    });
    expect(read.events[0].sourceRefs).toEqual([{ path: CHAPTER, evidenceKind: 'whole-file' }]);
  });
});

describe('Add Event from Selection — the paths that must write nothing', () => {
  const writesNothing = async (h: Harness): Promise<void> => {
    await run(h);
    expect(h.files.has(`${ROOT}/${DEFAULT_TIMELINE_FILE}`) && h.files.get(`${ROOT}/${DEFAULT_TIMELINE_FILE}`) !== undefined)
      .toBe(h.files.has(`${ROOT}/${DEFAULT_TIMELINE_FILE}`));
    expect(h.updated).toEqual([]);
    expect(h.messages.length).toBeGreaterThan(0);
  };

  test('no editor open', async () => {
    const h = harness({ editor: false });
    await writesNothing(h);
    expect(h.files.has(`${ROOT}/${DEFAULT_TIMELINE_FILE}`)).toBe(false);
  });

  test('the prompt was cancelled, or the title was blank', async () => {
    for (const options of [{ cancelled: true }, { title: '   ' }]) {
      const h = harness(options);
      await run(h);
      expect(h.files.has(`${ROOT}/${DEFAULT_TIMELINE_FILE}`)).toBe(false);
      expect(h.updated).toEqual([]);
      // NO MESSAGE EITHER: the author cancelled, and telling them so is noise.
      expect(h.messages).toEqual([]);
    }
  });

  test('an existing file that is not a timeline is refused, not overwritten', async () => {
    const foreign = 'scenes:\n  - id: s1\n';
    const h = harness({ timeline: foreign });
    await run(h);
    expect(h.files.get(`${ROOT}/${DEFAULT_TIMELINE_FILE}`)).toBe(foreign);
    expect(h.updated).toEqual([]);
    expect(h.messages.some(message => message.kind === 'warn')).toBe(true);
  });

  test('a timeline that cannot be APPENDED to is refused, not corrupted', async () => {
    const awkward = 'events:\n- id: a\n  title: A\n';
    const h = harness({ timeline: awkward });
    await run(h);
    expect(h.files.get(`${ROOT}/${DEFAULT_TIMELINE_FILE}`)).toBe(awkward);
    expect(h.updated).toEqual([]);
  });

  test('an UNREADABLE existing file is not replaced by a fresh one', async () => {
    // The defect this closes: every read error read as "absent", after which a
    // brand-new four-line file replaced the author's.
    const h = harness({ timeline: 'events:\n  - id: a\n    title: A\n', timelineUnreadable: true });
    await run(h);
    expect(h.files.get(`${ROOT}/${DEFAULT_TIMELINE_FILE}`)).toBe('events:\n  - id: a\n    title: A\n');
    expect(h.messages.some(message => message.kind === 'error')).toBe(true);
  });
});

describe('Add Event from Selection — failures are said out loud', () => {
  test('a failed write is reported as an error, not swallowed', async () => {
    const h = harness({ writeThrows: true });
    await run(h);
    expect(h.messages.some(message => message.kind === 'error')).toBe(true);
    expect(h.updated).toEqual([]);
  });

  test('a failed re-index still confirms the write, so the author does not add it twice', async () => {
    const h = harness({ updateThrows: true });
    await run(h);
    // The file IS written; the honest message is "you will see it shortly",
    // not "it failed" — which would make the author repeat the command and get
    // a duplicate.
    expect(h.files.get(`${ROOT}/${DEFAULT_TIMELINE_FILE}`)).toBeDefined();
    expect(h.messages.some(message => message.kind === 'info')).toBe(true);
    expect(h.messages.some(message => message.kind === 'error')).toBe(false);
  });
});

describe('suggestTitle', () => {
  test('offers the first sentence, collapsed and capped', () => {
    expect(suggestTitle('Иван приехал в город. Было холодно.')).toBe('Иван приехал в город.');
    expect(suggestTitle('  два   пробела  ')).toBe('два пробела');
    expect(suggestTitle('')).toBe('');
    expect(suggestTitle('а'.repeat(200)).length).toBeLessThanOrEqual(80);
  });
});
