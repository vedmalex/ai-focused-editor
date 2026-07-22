import { afterAll, describe, expect, test } from 'bun:test';
import URI from '@theia/core/lib/common/uri';
import { parseWikiLinks } from '../common/link-navigation';
import { buildNoteIndex, type NoteIndex } from '../common/note-index';
import type { NarrativeEntity } from '../common/narrative-entity-protocol';

/**
 * Unit tests for the TASK-013 U4 pure chain-resolution logic
 * (`resolveWikiToken`/`wikiTokenLinkRange`/`resolveNoteWithTitleFallback`) — the
 * "чистую логику ... вынеси в тестируемые функции" half of the U4 task (plan
 * §9/ISS-139(d)). `SemanticLinkContribution` itself (the Monaco `LinkProvider`,
 * command registration, `QuickInputService`/`FileService` glue) stays UI-thin and
 * untested here — it wires these pure functions into Theia, nothing more.
 *
 * These functions do not import `@theia/monaco-editor-core`/`@theia/core/lib/
 * browser` themselves, but the module they live in (`semantic-link-
 * contribution.ts`) does — Bun has no DOM, so importing it at all requires the
 * same load-time shim `welcome-widget.test.ts` uses (documented there) to let
 * `@theia/core/lib/browser`'s Lumino-backed `ApplicationShell` import resolve.
 * Confirmed NOT to need the "run separately" isolation that file needs: this
 * suite passes green inside the full `bun test src/` run alongside every other
 * package test.
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

// `@theia/workspace/lib/browser/workspace-service.js` (pulled in transitively by
// `semantic-link-contribution.ts`) reads `FrontendApplicationConfigProvider` at
// MODULE LOAD, and `.set()` throws unconditionally on a second call — a process-
// global singleton `welcome-widget.test.ts`'s own (unguarded) shim also sets.
// Probe with `.get()` first rather than assuming this file runs alone in the
// process, and if THIS file was the one that set it, clear it again once this
// file's tests finish so a same-process `welcome-widget.test.ts` running after
// it can still call its own unconditional `.set()`.
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

const { resolveNoteWithTitleFallback, resolveWikiToken, wikiTokenLinkRange } =
  await import('./semantic-link-contribution');

function makeEntity(overrides: Partial<NarrativeEntity> & Pick<NarrativeEntity, 'kind' | 'id'>): NarrativeEntity {
  return {
    label: overrides.id,
    path: `entities/${overrides.kind}/${overrides.id}.yaml`,
    uri: `file:///workspace/entities/${overrides.kind}/${overrides.id}.yaml`,
    aliases: [],
    ...overrides
  };
}

const identityMapTagKind = (kind: string): string => kind;

function firstToken(text: string) {
  const [token] = parseWikiLinks(text);
  if (!token) {
    throw new Error(`no [[...]] token in ${JSON.stringify(text)}`);
  }
  return token;
}

describe('wikiTokenLinkRange', () => {
  test('covers the whole token when there is no alias', () => {
    const token = firstToken('[[char:krishna]]');
    expect(wikiTokenLinkRange(token)).toEqual({ start: 0, end: '[[char:krishna]]'.length });
  });

  test('stops right before the pipe when an alias is present', () => {
    const text = '[[char:krishna|Кришна]]';
    const token = firstToken(text);
    const range = wikiTokenLinkRange(token);
    expect(text.slice(range.start, range.end)).toBe('[[char:krishna');
  });

  test('stops right before the pipe for a note+alias token too (generalized rule)', () => {
    const text = '[[Моя заметка|Подпись]]';
    const token = firstToken(text);
    const range = wikiTokenLinkRange(token);
    expect(text.slice(range.start, range.end)).toBe('[[Моя заметка');
  });
});

describe('resolveWikiToken', () => {
  // Tag kind used verbatim as the entity kind (`identityMapTagKind`) so these
  // cases stay decoupled from the registry's `char` -> `character` shorthand
  // mapping (that convention is `EntityTypeRegistryService`'s own concern,
  // exercised elsewhere) — `resolveWikiToken` only needs SOME mapper function.
  const entities: NarrativeEntity[] = [
    makeEntity({ kind: 'term', id: 'krishna' }),
    makeEntity({ kind: 'term', id: 'sharan-108' })
  ];

  test('labeled entity token resolves via kind+id', () => {
    const token = firstToken('[[term:krishna|Кришна]]');
    const index = buildNoteIndex([]);
    const resolution = resolveWikiToken(token, entities, identityMapTagKind, index, '/book/ch1.md');
    expect(resolution).toEqual({ type: 'entity', entity: entities[0] });
  });

  test('bare kind:id entity token resolves via kind+id', () => {
    const token = firstToken('[[term:krishna]]');
    const index = buildNoteIndex([]);
    const resolution = resolveWikiToken(token, entities, identityMapTagKind, index, '/book/ch1.md');
    expect(resolution.type).toBe('entity');
  });

  test('bare no-colon token resolves via bare id FIRST (UR-002/UR-003(a) corpus compatibility)', () => {
    const token = firstToken('[[sharan-108]]');
    // A note also happens to exist at this basename — entity resolution must win.
    const index = buildNoteIndex(['/book/notes/sharan-108.md']);
    const resolution = resolveWikiToken(token, entities, identityMapTagKind, index, '/book/ch1.md');
    expect(resolution).toEqual({ type: 'entity', entity: entities[1] });
  });

  test('entity-class token with an unknown id falls through to note resolution, then unresolved', () => {
    const token = firstToken('[[term:unknown-id]]');
    const index = buildNoteIndex([]);
    const resolution = resolveWikiToken(token, entities, identityMapTagKind, index, '/book/ch1.md');
    expect(resolution).toEqual({ type: 'unresolved', notePath: 'term:unknown-id' });
  });

  test('note-class token with no matching entity resolves by basename', () => {
    const token = firstToken('[[Моя заметка]]');
    const index = buildNoteIndex(['/book/notes/Моя заметка.md']);
    const resolution = resolveWikiToken(token, entities, identityMapTagKind, index, '/book/ch1.md');
    expect(resolution).toEqual({
      type: 'note',
      notePath: 'Моя заметка',
      resolved: { path: '/book/notes/Моя заметка.md' }
    });
  });

  test('duplicate basenames at equal distance resolve ambiguous, with sorted candidates', () => {
    const token = firstToken('[[note]]');
    const index = buildNoteIndex(['/book/a/note.md', '/book/b/note.md']);
    const resolution = resolveWikiToken(token, entities, identityMapTagKind, index, '/book/ch1.md');
    expect(resolution.type).toBe('note');
    if (resolution.type === 'note') {
      expect(resolution.resolved.ambiguous).toBe(true);
      expect(resolution.resolved.candidates).toEqual(['/book/a/note.md', '/book/b/note.md']);
    }
  });

  test('note-class token that matches nothing (no entity, no basename, no title) is unresolved', () => {
    const token = firstToken('[[Нет такой заметки]]');
    const index = buildNoteIndex(['/book/notes/other.md']);
    const resolution = resolveWikiToken(token, entities, identityMapTagKind, index, '/book/ch1.md');
    expect(resolution).toEqual({ type: 'unresolved', notePath: 'Нет такой заметки' });
  });

  test('a basename miss still resolves through an already-populated title index (UR-005(2))', () => {
    const token = firstToken('[[Секретный Заголовок]]');
    const index: NoteIndex = buildNoteIndex(['/book/notes/real-file-name.md']);
    index.titleIndex.set('секретный заголовок', ['/book/notes/real-file-name.md']);
    const resolution = resolveWikiToken(token, entities, identityMapTagKind, index, '/book/ch1.md');
    expect(resolution).toEqual({
      type: 'note',
      notePath: 'Секретный Заголовок',
      resolved: { path: '/book/notes/real-file-name.md' }
    });
  });
});

// ISS-144: `SemanticLinkContribution.collectWikiLinks` calls `resolveWikiToken`
// with `documentUri = model.uri.toString()` (the FULL, percent-encoded URI),
// matching the full `file://...` representation `NoteIndexService` stores its
// candidates in (`FileSearchService.find` results) — NOT the scheme-less
// `model.uri.path` this call used to pass. These cases exercise the exact
// full-URI shape the real editor path now uses end-to-end: entity resolution
// (representation-independent), the note "closest chapter" tie-break (which
// DOES depend on both sides sharing one representation), and the ambiguous
// case — proving `resolution.resolved.path` comes back as a plain full URI
// string ready for `new URI(...)`, exactly what `collectWikiLinks`'s resolved-
// note branch now does to build the open target (no workspace-root path join).
describe('resolveWikiToken with full file:// URI documentPath (ISS-144 fix verification)', () => {
  const entities: NarrativeEntity[] = [makeEntity({ kind: 'term', id: 'krishna' })];

  test('entity resolution is unaffected by the file:// documentPath representation', () => {
    const token = firstToken('[[term:krishna]]');
    const index = buildNoteIndex([]);
    const resolution = resolveWikiToken(
      token, entities, identityMapTagKind, index, 'file:///ws/proj/chapters/ch1.md'
    );
    expect(resolution).toEqual({ type: 'entity', entity: entities[0] });
  });

  test('duplicate note basenames resolve to the file:// candidate closest to a file:// documentPath', () => {
    const token = firstToken('[[note]]');
    const index = buildNoteIndex([
      'file:///ws/proj/a/notes/note.md',
      'file:///ws/proj/b/notes/note.md'
    ]);
    const resolution = resolveWikiToken(
      token, entities, identityMapTagKind, index, 'file:///ws/proj/a/chapters/ch1.md'
    );
    expect(resolution).toEqual({
      type: 'note',
      notePath: 'note',
      resolved: { path: 'file:///ws/proj/a/notes/note.md' }
    });
    // The resolved path is a complete file URI — `new URI(resolved.path)`
    // (what `collectWikiLinks`/`pickNoteTarget`/`openOrCreateNote` now do)
    // opens it directly, with no `root.withPath(...)` join needed.
    if (resolution.type === 'note') {
      expect(() => new URI(resolution.resolved.path)).not.toThrow();
      expect(new URI(resolution.resolved.path).scheme).toBe('file');
    }
  });

  test('a genuine equal-distance tie among file:// candidates still resolves ambiguous, with sorted full-URI candidates', () => {
    const token = firstToken('[[note]]');
    const index = buildNoteIndex([
      'file:///ws/proj/b/note.md',
      'file:///ws/proj/a/note.md'
    ]);
    const resolution = resolveWikiToken(
      token, entities, identityMapTagKind, index, 'file:///ws/proj/root.md'
    );
    expect(resolution.type).toBe('note');
    if (resolution.type === 'note') {
      expect(resolution.resolved.ambiguous).toBe(true);
      expect(resolution.resolved.candidates).toEqual([
        'file:///ws/proj/a/note.md',
        'file:///ws/proj/b/note.md'
      ]);
    }
  });
});

describe('resolveNoteWithTitleFallback', () => {
  test('short-circuits on a direct sync hit — the resolver callback is never invoked', async () => {
    const index = buildNoteIndex(['/book/notes/note.md']);
    let calls = 0;
    const resolved = await resolveNoteWithTitleFallback(
      'note',
      '/book/ch1.md',
      index,
      async () => { calls++; return undefined; }
    );
    expect(resolved).toEqual({ path: '/book/notes/note.md' });
    expect(calls).toBe(0);
  });

  test('stops at the FIRST entry whose lazily-resolved title matches, not the whole vault', async () => {
    const index = buildNoteIndex([
      '/book/notes/aaa.md',
      '/book/notes/bbb.md',
      '/book/notes/ccc.md'
    ]);
    const calls: string[] = [];
    const resolved = await resolveNoteWithTitleFallback(
      'The Real Title',
      '/book/ch1.md',
      index,
      async path => {
        calls.push(path);
        // Simulate the real NoteIndexService: a successful title resolution
        // folds the title -> path mapping into the SAME shared index.
        if (path === '/book/notes/bbb.md') {
          index.titleIndex.set('the real title', [path]);
          return 'The Real Title';
        }
        return undefined;
      }
    );
    expect(resolved).toEqual({ path: '/book/notes/bbb.md' });
    // Entry order in `buildNoteIndex` is encounter order: aaa (miss), bbb (hit,
    // short-circuits) — ccc must never be visited.
    expect(calls).toEqual(['/book/notes/aaa.md', '/book/notes/bbb.md']);
  });

  test('exhausts the whole vault and returns undefined when no title ever matches', async () => {
    const index = buildNoteIndex(['/book/notes/aaa.md', '/book/notes/bbb.md']);
    const calls: string[] = [];
    const resolved = await resolveNoteWithTitleFallback(
      'Nothing Matches This',
      '/book/ch1.md',
      index,
      async path => { calls.push(path); return undefined; }
    );
    expect(resolved).toBeUndefined();
    expect(calls).toEqual(['/book/notes/aaa.md', '/book/notes/bbb.md']);
  });
});
