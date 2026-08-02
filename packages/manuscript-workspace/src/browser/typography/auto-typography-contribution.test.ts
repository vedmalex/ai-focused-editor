import { describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { BuildContextOptions } from './typography-monaco-adapter';
import type { TypographyEdit, TypographyRule } from '../../common/typography/typography-types';

/**
 * DOM bootstrap — MUST run before the Theia browser modules load. Importing
 * `@theia/monaco/lib/browser/monaco-editor` (needed for the `MonacoEditor.get()`
 * `instanceof` check the contribution performs) pulls in `@lumino/domutils`,
 * which touches `document` at MODULE-EVALUATION time. Static ESM imports are
 * hoisted above any setup statement, so the Theia/monaco imports below are
 * DYNAMIC and deliberately sequenced after this bootstrap. One shared window is
 * fine here: nothing in this suite renders — the DOM exists only so the imports
 * evaluate (contrast `welcome-docs-katex.test.ts`, which mutates the document
 * and therefore needs a fresh Window per test).
 */
const domWindow = new Window() as unknown as Record<string, unknown>;
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = domWindow;
globals.self = domWindow;
// Copy every DOM global monaco's ESM modules may touch at evaluation time
// (`UIEvent`, `HTMLElement`, `NodeFilter`, …). Enumerating rather than listing
// them keeps this bootstrap from breaking on the next monaco bump; existing
// runtime globals are never overwritten.
for (const name of Object.getOwnPropertyNames(domWindow)) {
  if (globals[name] !== undefined) {
    continue;
  }
  try {
    const value = domWindow[name];
    if (value !== undefined) {
      globals[name] = value;
    }
  } catch {
    // Some happy-dom accessors throw when read out of context — skip them.
  }
}

const { default: URI } = await import('@theia/core/lib/common/uri');
const { MonacoEditor } = await import('@theia/monaco/lib/browser/monaco-editor');
const { AutoTypographyContribution, CONTEXT_LOOKBACK_LINES, TYPOGRAPHY_TYPE_DEBOUNCE_MS } = await import('./auto-typography-contribution');
const { TYPOGRAPHY_RULES } = await import('../../common/typography/typography-rules');
const { TypographyMonacoAdapter } = await import('./typography-monaco-adapter');
const { TYPOGRAPHY_ENABLED_KEY, ruleEnabledKey } = await import('../../common/typography/typography-rule-contribution');
const { DefaultTypographyEngine } = await import('../../common/typography/typography-engine');

/**
 * Seam-double harness for the LIVE auto-typography contribution (TASK-019 §4,
 * ISS-242). Every guard this file asserts is a SEAM gate that no pure-core test
 * can reach: the undo/redo/flush filter (DEFECT-2), the Q6 selection skip, the
 * recursion guard, the IME composition guard, the paste window, the per-pass
 * scope re-gate, and the ISS-244 lazy `autoClosingQuotes` suppression.
 *
 * Doubles, not mocks-of-ourselves:
 *  - a fake monaco `IStandaloneCodeEditor` with hand-fired event emitters,
 *  - a mutable fake `ITextModel` (line array + real `getValue`), so the REAL
 *    `TypographyMonacoAdapter` can parse front matter and build contexts,
 *  - a recording engine whose `computeEdits` CALL COUNT is the observable for
 *    "a pass actually ran" — asserting on the guard flag itself would be a
 *    tautology.
 */

/** Minimal hand-fired event emitter matching monaco's `Event<T>` shape. */
function emitter<T>(): { on: (listener: (event: T) => void) => { dispose(): void }; fire: (event: T) => void } {
  const listeners: Array<(event: T) => void> = [];
  return {
    on: (listener: (event: T) => void) => {
      listeners.push(listener);
      return {
        dispose: () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        }
      };
    },
    fire: (event: T) => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    }
  };
}

interface ContentChangeLike {
  changes: Array<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }>;
  isUndoing: boolean;
  isRedoing: boolean;
  isFlush: boolean;
}

function contentChange(overrides: Partial<ContentChangeLike> = {}): ContentChangeLike {
  return {
    changes: [{ range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: 'x' }],
    isUndoing: false,
    isRedoing: false,
    isFlush: false,
    ...overrides
  };
}

/** A mutable fake `ITextModel` backed by a line array. */
function fakeModel(lines: string[]): any {
  return {
    getLineCount: () => lines.length,
    getLineMaxColumn: (line: number) => (lines[line - 1]?.length ?? 0) + 1,
    getLinesContent: () => [...lines],
    getValue: () => lines.join('\n'),
    isDisposed: () => false,
    pushStackElement: () => undefined,
    pushEditOperations: () => null
  };
}

interface Harness {
  contribution: HarnessContribution;
  widget: any;
  control: any;
  model: any;
  fire: {
    content: (event?: Partial<ContentChangeLike>) => void;
    compositionStart: () => void;
    compositionEnd: () => void;
    paste: (range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => void;
    dispose: () => void;
  };
  /** Every `updateOptions` payload the contribution wrote onto the editor. */
  updateOptionsCalls: Array<Record<string, unknown>>;
  /** One entry per `engine.computeEdits` call — the "a pass ran" observable. */
  computeCalls: BuildContextOptions[];
  /** One entry per `adapter.applyEdits` call. */
  applyCalls: number[];
  /** `ruleId` of every edit that reached `adapter.applyEdits`, in order. */
  appliedRuleIds: string[];
  setSelections: (selections: Array<{ empty: boolean }> | undefined) => void;
  untrack: () => void;
  /** Flip the `aiFocusedEditor.typography.enabled` master toggle and recompute (F-D5-2). */
  setMasterEnabled: (enabled: boolean) => void;
}

/**
 * Test subclass. `schedulePass` is overridden to RECORD the request and run it
 * INLINE.
 *
 * Why this shape rather than fake timers: the guards under test split into two
 * families — "no pass may be scheduled at all" (undo/redo/flush, recursion,
 * composition) and "the pass must run and reach the engine" (the positive
 * controls, paste window, scope re-gate). One override covers both: the first
 * family asserts `scheduled.length`, the second asserts the engine/adapter call
 * counters produced by the real `applyAt`. Fake timers would only prove
 * scheduling and never exercise `applyAt`; real timers would cost 200ms of sleep
 * per case and make the suite flaky.
 */
class HarnessContribution extends AutoTypographyContribution {
  readonly scheduled: Array<{ trigger: string; changedRange?: unknown }> = [];

  protected schedulePass(widget: any, pass: any): void {
    this.scheduled.push(pass);
    (this as any).applyAt(widget, pass);
  }
}

interface HarnessOptions {
  /** Editor file path (drives the scope predicates). */
  path?: string;
  /** Document lines (front matter included when the test needs a chapter). */
  lines?: string[];
  /** `aiFocusedEditor.typography.scope` value. */
  scope?: 'chapters' | 'all-md';
  /** Edits the fake engine returns — non-empty drives the apply path. */
  edits?: TypographyEdit[];
  /** Resolved `autoClosingQuotes` the editor reports before we touch it. */
  autoClosingQuotes?: 'always' | 'languageDefined' | 'beforeWhitespace' | 'never';
  /** When set, `adapter.applyEdits` throws it (finally-reset coverage). */
  applyThrows?: Error;
  /** When true, `adapter.applyEdits` re-fires a content change, as monaco would. */
  applyReentersContentChange?: boolean;
  /**
   * Rules the `ContributionProvider` serves. When given, the harness runs the
   * REAL {@link DefaultTypographyEngine} over them instead of the canned-edits
   * double — the only way "rule X's `apply` was never called" can be an
   * observable rather than an assertion about our own mock (ISS-253).
   */
  rules?: readonly TypographyRule[];
  /**
   * `aiFocusedEditor.typography.<id>.enabled` preference values, keyed by RULE
   * ID. Absent ids fall through to the rule's own `defaultEnabled`.
   */
  rulePrefs?: Record<string, boolean>;
}

const CHAPTER_LINES = ['---', 'type: chapter', '---', '', 'Some prose  here', 'more prose', 'and more'];
const PLAIN_LINES = ['# Notes', '', 'Some prose  here', 'more prose', 'and more', 'tail', 'end'];

function harness(options: HarnessOptions = {}): Harness {
  const path = options.path ?? '/book/content/chapter-01.md';
  const lines = options.lines ?? CHAPTER_LINES;
  const scope = options.scope ?? 'chapters';

  const model = fakeModel(lines);
  const content = emitter<ContentChangeLike>();
  const compositionStart = emitter<void>();
  const compositionEnd = emitter<void>();
  const paste = emitter<any>();
  const disposeEmitter = emitter<void>();

  const updateOptionsCalls: Array<Record<string, unknown>> = [];
  let quotes = options.autoClosingQuotes ?? 'languageDefined';
  let selections: Array<{ isEmpty: () => boolean }> | undefined = [{ isEmpty: () => true }];
  let masterEnabled = true;

  const control: any = {
    getModel: () => model,
    getOption: () => quotes,
    updateOptions: (next: Record<string, unknown>) => {
      updateOptionsCalls.push(next);
      if (typeof next.autoClosingQuotes === 'string') {
        quotes = next.autoClosingQuotes as typeof quotes;
      }
    },
    getSelections: () => selections,
    getPosition: () => ({ lineNumber: 3, column: 1 }),
    onDidChangeModelContent: content.on,
    onDidCompositionStart: compositionStart.on,
    onDidCompositionEnd: compositionEnd.on,
    onDidPaste: paste.on
  };

  // MonacoEditor.get() is an `instanceof` check, so the widget's editor must be
  // a real MonacoEditor shape — built without running the constructor.
  const editor: any = Object.create(MonacoEditor.prototype);
  editor.uri = new URI(`file://${path}`);
  editor.getControl = () => control;

  const widget: any = { editor, onDispose: disposeEmitter.on };

  const computeCalls: BuildContextOptions[] = [];
  const applyCalls: number[] = [];
  const appliedRuleIds: string[] = [];

  const realAdapter = new TypographyMonacoAdapter();
  const adapter: any = {
    readChangedRange: (event: any) => realAdapter.readChangedRange(event),
    readFrontMatterType: (target: any) => realAdapter.readFrontMatterType(target),
    buildContext: (target: any, buildOptions: BuildContextOptions) => {
      computeCalls.push(buildOptions);
      return realAdapter.buildContext(target, buildOptions);
    },
    applyEdits: (_target: any, edits: readonly TypographyEdit[]) => {
      applyCalls.push(edits.length);
      appliedRuleIds.push(...edits.map(edit => edit.ruleId));
      if (options.applyReentersContentChange) {
        // Monaco echoes our own write back as a content change; the recursion
        // guard must swallow it.
        content.fire(contentChange());
      }
      if (options.applyThrows) {
        throw options.applyThrows;
      }
      return true;
    }
  };

  // With `options.rules` the REAL engine runs the REAL rules; otherwise the
  // canned-edits double the guard tests above rely on.
  const engine: any = options.rules
    ? new DefaultTypographyEngine(options.rules)
    : { computeEdits: () => options.edits ?? [] };

  const rulePrefsByKey = new Map<string, boolean>(
    Object.entries(options.rulePrefs ?? {}).map(([id, value]) => [ruleEnabledKey(id), value])
  );

  const preferenceService: any = {
    get: (key: string, defaultValue: unknown) => {
      if (key === 'aiFocusedEditor.typography.scope') {
        return scope;
      }
      if (key === TYPOGRAPHY_ENABLED_KEY) {
        return masterEnabled;
      }
      if (rulePrefsByKey.has(key)) {
        return rulePrefsByKey.get(key);
      }
      return defaultValue;
    },
    onPreferenceChanged: emitter<any>().on
  };

  const ruleProvider: any = {
    getContributions: () => options.rules ?? [{ id: 'collapse-multiple-spaces', defaultEnabled: true }]
  };

  const fileService: any = {
    // No enclosing manifest: the `chapters` gate then leans on front matter only.
    exists: async () => false,
    read: async () => ({ value: '' })
  };

  const editorManager: any = { onCurrentEditorChanged: emitter<any>().on };

  const contribution = new HarnessContribution();
  Object.assign(contribution as unknown as Record<string, unknown>, {
    editorManager,
    preferenceService,
    engine,
    adapter,
    ruleProvider,
    fileService
  });
  (contribution as any).recomputeEnabled();
  (contribution as any).trackEditor(widget);

  return {
    contribution,
    widget,
    control,
    model,
    fire: {
      content: (event: Partial<ContentChangeLike> = {}) => content.fire(contentChange(event)),
      compositionStart: () => compositionStart.fire(undefined as never),
      compositionEnd: () => compositionEnd.fire(undefined as never),
      paste: range => paste.fire({ range }),
      dispose: () => disposeEmitter.fire(undefined as never)
    },
    updateOptionsCalls,
    computeCalls,
    applyCalls,
    appliedRuleIds,
    setSelections: next => {
      selections = next?.map(selection => ({ isEmpty: () => selection.empty }));
    },
    untrack: () => (contribution as any).untrack(widget),
    setMasterEnabled: enabled => {
      masterEnabled = enabled;
      (contribution as any).recomputeEnabled();
    }
  };
}

describe('AutoTypographyContribution — undo/redo/flush guard (DEFECT-2, UR-003)', () => {
  test('POSITIVE CONTROL: an ordinary content change DOES run a pass', () => {
    const h = harness();
    h.fire.content();
    expect(h.contribution.scheduled).toHaveLength(1);
    expect(h.computeCalls).toHaveLength(1);
  });

  test('isUndoing: no pass is scheduled and the engine is never reached', () => {
    const h = harness();
    h.fire.content({ isUndoing: true });
    expect(h.contribution.scheduled).toHaveLength(0);
    expect(h.computeCalls).toHaveLength(0);
  });

  test('isRedoing: no pass is scheduled and the engine is never reached', () => {
    const h = harness();
    h.fire.content({ isRedoing: true });
    expect(h.contribution.scheduled).toHaveLength(0);
    expect(h.computeCalls).toHaveLength(0);
  });

  test('isFlush: no pass is scheduled and the engine is never reached', () => {
    const h = harness();
    h.fire.content({ isFlush: true });
    expect(h.contribution.scheduled).toHaveLength(0);
    expect(h.computeCalls).toHaveLength(0);
  });
});

describe('AutoTypographyContribution — Q6 selection guard', () => {
  test('a non-empty selection skips the pass before the engine runs', () => {
    const h = harness();
    h.setSelections([{ empty: false }]);
    h.fire.content();
    expect(h.contribution.scheduled).toHaveLength(1); // scheduled…
    expect(h.computeCalls).toHaveLength(0); // …but applyAt bailed out.
  });

  test('multi-cursor (2 selections) skips the pass', () => {
    const h = harness();
    h.setSelections([{ empty: true }, { empty: true }]);
    h.fire.content();
    expect(h.computeCalls).toHaveLength(0);
  });

  test('a single empty cursor passes the guard', () => {
    const h = harness();
    h.setSelections([{ empty: true }]);
    h.fire.content();
    expect(h.computeCalls).toHaveLength(1);
  });
});

describe('AutoTypographyContribution — recursion guard', () => {
  test('our own write echoing back as a content change does NOT schedule a second pass', () => {
    const h = harness({
      // On line 3 — the line `contentChange()` reports as changed. The seam
      // confines writes to the changed range (F-CR2-1), so a canned edit on some
      // other line would be dropped before `applyEdits` and this suite would be
      // asserting about an edit the real seam could never have produced anyway.
      edits: [{ range: { start: { line: 3, column: 1 }, end: { line: 3, column: 2 } }, text: ' ', ruleId: 'collapse-multiple-spaces' }],
      applyReentersContentChange: true
    });

    h.fire.content();

    expect(h.applyCalls).toHaveLength(1);
    // The echoed change arrived while `applyingOwnEdit` was true.
    expect(h.contribution.scheduled).toHaveLength(1);
    expect(h.computeCalls).toHaveLength(1);
  });

  test('the guard is released in `finally` when applyEdits THROWS (no permanently stuck seam)', () => {
    const boom = new Error('adapter exploded');
    const h = harness({
      // On line 3 — the line `contentChange()` reports as changed. The seam
      // confines writes to the changed range (F-CR2-1), so a canned edit on some
      // other line would be dropped before `applyEdits` and this suite would be
      // asserting about an edit the real seam could never have produced anyway.
      edits: [{ range: { start: { line: 3, column: 1 }, end: { line: 3, column: 2 } }, text: ' ', ruleId: 'collapse-multiple-spaces' }],
      applyThrows: boom
    });

    expect(() => h.fire.content()).toThrow('adapter exploded');
    expect((h.contribution as any).applyingOwnEdit).toBe(false);
    // Observable proof the seam still works: the NEXT keystroke runs a pass.
    expect(() => h.fire.content()).toThrow('adapter exploded');
    expect(h.computeCalls).toHaveLength(2);
  });
});

describe('AutoTypographyContribution — IME composition guard', () => {
  test('changes fired during composition schedule nothing', () => {
    const h = harness();
    h.fire.compositionStart();
    h.fire.content();
    h.fire.content();
    expect(h.contribution.scheduled).toHaveLength(0);
    expect(h.computeCalls).toHaveLength(0);
  });

  test('composition end schedules exactly one pass and it reaches the engine', () => {
    const h = harness();
    h.fire.compositionStart();
    h.fire.content();
    h.fire.compositionEnd();
    expect(h.contribution.scheduled).toHaveLength(1);
    expect(h.contribution.scheduled[0].trigger).toBe('type');
    expect(h.computeCalls).toHaveLength(1);
  });
});

describe('AutoTypographyContribution — paste window (W1b)', () => {
  test('a multi-line paste runs ONE pass whose window covers the whole pasted range', () => {
    const h = harness();
    h.fire.paste({ startLineNumber: 3, startColumn: 1, endLineNumber: 6, endColumn: 12 });

    expect(h.contribution.scheduled).toHaveLength(1);
    expect(h.computeCalls).toHaveLength(1);

    const built = h.computeCalls[0];
    expect(built.trigger).toBe('paste');
    // Whole pasted range, plus the 2-line look-back — NOT the caret point.
    expect(built.windowStart).toBe(1);
    expect(built.windowEnd).toBe(6);
    expect(built.changedRange).toEqual({
      start: { line: 3, column: 1 },
      end: { line: 6, column: 12 }
    });
  });
});

describe('AutoTypographyContribution — per-pass scope re-gate (§1.3)', () => {
  test('scope=chapters: a markdown file with NO chapter signal is skipped', () => {
    const h = harness({ scope: 'chapters', path: '/book/content/notes.md', lines: PLAIN_LINES });
    h.fire.content();
    expect(h.contribution.scheduled).toHaveLength(1);
    expect(h.computeCalls).toHaveLength(0);
  });

  test('scope=chapters: the SAME file with front-matter `type: chapter` runs', () => {
    const h = harness({ scope: 'chapters', path: '/book/content/notes.md', lines: CHAPTER_LINES });
    h.fire.content();
    expect(h.computeCalls).toHaveLength(1);
  });

  test('scope=all-md: a plain markdown file runs', () => {
    const h = harness({ scope: 'all-md', path: '/book/content/notes.md', lines: PLAIN_LINES });
    h.fire.content();
    expect(h.computeCalls).toHaveLength(1);
  });
});

describe('AutoTypographyContribution — ISS-244 lazy autoClosingQuotes suppression (Q7)', () => {
  test('OUT of scope: the auto-closer is never touched (attach must not suppress)', () => {
    const h = harness({ scope: 'chapters', path: '/book/content/notes.md', lines: PLAIN_LINES });
    expect(h.updateOptionsCalls).toHaveLength(0); // nothing at attach time
    h.fire.content();
    expect(h.computeCalls).toHaveLength(0);
    expect(h.updateOptionsCalls).toHaveLength(0); // and nothing after a skipped pass
  });

  test('IN scope: the first passing pass suppresses exactly once', () => {
    const h = harness();
    expect(h.updateOptionsCalls).toHaveLength(0);
    h.fire.content();
    expect(h.updateOptionsCalls).toEqual([{ autoClosingQuotes: 'never' }]);
  });

  test('repeat passes do NOT re-write the option (idempotent)', () => {
    const h = harness();
    h.fire.content();
    h.fire.content();
    h.fire.content();
    expect(h.computeCalls).toHaveLength(3);
    expect(h.updateOptionsCalls).toHaveLength(1);
  });

  test('untrack WITHOUT any in-scope pass restores nothing (not touched -> not restored)', () => {
    const h = harness({ scope: 'chapters', path: '/book/content/notes.md', lines: PLAIN_LINES });
    h.fire.content();
    h.untrack();
    expect(h.updateOptionsCalls).toHaveLength(0);
  });

  test('untrack AFTER suppression restores the value captured before our write', () => {
    const h = harness({ autoClosingQuotes: 'always' });
    h.fire.content();
    h.untrack();
    expect(h.updateOptionsCalls).toEqual([
      { autoClosingQuotes: 'never' },
      { autoClosingQuotes: 'always' }
    ]);
  });

  test('a pass that leaves scope hands the auto-closer straight back', () => {
    // In scope while the front matter says chapter…
    const h = harness({ scope: 'chapters', path: '/book/content/notes.md', lines: CHAPTER_LINES });
    h.fire.content();
    expect(h.updateOptionsCalls).toEqual([{ autoClosingQuotes: 'never' }]);

    // …then the author edits the front matter away and types again.
    (h.model as any).getValue = () => PLAIN_LINES.join('\n');
    h.fire.content();
    expect(h.computeCalls).toHaveLength(1); // the second pass was skipped
    expect(h.updateOptionsCalls).toEqual([
      { autoClosingQuotes: 'never' },
      { autoClosingQuotes: 'languageDefined' }
    ]);
  });

  test('F-D5-2: turning the master toggle OFF restores the auto-closer even though applyAt never reaches the scope gate', () => {
    const h = harness({ autoClosingQuotes: 'always' });
    h.fire.content();
    expect(h.updateOptionsCalls).toEqual([{ autoClosingQuotes: 'never' }]); // suppressed while enabled

    h.setMasterEnabled(false);
    expect(h.updateOptionsCalls).toEqual([
      { autoClosingQuotes: 'never' },
      { autoClosingQuotes: 'always' }
    ]); // restored the moment enabledIds went empty — no editor close needed

    // A keystroke while disabled must not reach the engine (applyAt's enabledIds
    // guard) and must not re-suppress.
    h.fire.content();
    expect(h.computeCalls).toHaveLength(1); // unchanged since suppression
    expect(h.updateOptionsCalls).toHaveLength(2);

    // Turning it back on must NOT eagerly re-suppress (ISS-244: only an in-scope
    // pass suppresses) — only the NEXT keystroke's pass does.
    h.setMasterEnabled(true);
    expect(h.updateOptionsCalls).toHaveLength(2);

    h.fire.content();
    expect(h.updateOptionsCalls).toEqual([
      { autoClosingQuotes: 'never' },
      { autoClosingQuotes: 'always' },
      { autoClosingQuotes: 'never' }
    ]);
  });

  test('F-D5-2: disabling the only enabled rule (master stays on) also restores', () => {
    const h = harness({ autoClosingQuotes: 'beforeWhitespace' });
    h.fire.content();
    expect(h.updateOptionsCalls).toEqual([{ autoClosingQuotes: 'never' }]);

    // Simulate every rule being turned off while the master stays on: swap the
    // rule provider to an empty contribution set and recompute.
    (h.contribution as any).ruleProvider = { getContributions: () => [] };
    (h.contribution as any).recomputeEnabled();
    expect(h.updateOptionsCalls).toEqual([
      { autoClosingQuotes: 'never' },
      { autoClosingQuotes: 'beforeWhitespace' }
    ]);
  });
});

/**
 * PER-RULE TOGGLES (UR-002's obligatory half, QA/ISS-253).
 *
 * The suite above only ever exercised the MASTER toggle and an EMPTY rule
 * provider, so `recomputeEnabled`'s per-rule branch — `preferenceService.get(
 * ruleEnabledKey(rule.id), rule.defaultEnabled) !== false` — was never taken
 * with a `false` on the wire. Deleting that lookup (making every bound rule
 * unconditionally enabled) left the whole suite green, i.e. the feature users
 * are actually promised had no test at all.
 *
 * These cases run the REAL engine over REAL rule objects, so the observables are
 * "rule A's `apply` was never invoked" and "rule B's edit still landed" — facts
 * about the production dispatch path, not about a mock's bookkeeping.
 */
function probeRule(id: string, calls: string[], column: number): TypographyRule {
  return {
    id,
    descriptionKey: `ai-focused-editor/typography/${id}-desc`,
    defaultEnabled: true,
    priority: 10,
    apply: () => {
      calls.push(id);
      return [{
        ruleId: id,
        range: { start: { line: 3, column }, end: { line: 3, column: column + 1 } },
        text: '~'
      }];
    }
  };
}

describe('AutoTypographyContribution — per-rule enable toggles (UR-002, ISS-253)', () => {
  /** A plain markdown file in `all-md` scope: line 3 is prose, so edits survive. */
  const fixture = (rulePrefs?: Record<string, boolean>) => {
    const calls: string[] = [];
    const rules = [probeRule('collapse-multiple-spaces', calls, 1), probeRule('space-after-punctuation', calls, 5)];
    const h = harness({
      scope: 'all-md',
      path: '/book/content/notes.md',
      lines: PLAIN_LINES,
      rules,
      rulePrefs
    });
    return { h, calls };
  };

  test('POSITIVE CONTROL: with no preference set, BOTH rules run and both edits land', () => {
    const { h, calls } = fixture();
    expect([...h.contribution.getEnabledRuleIds()].sort()).toEqual(['collapse-multiple-spaces', 'space-after-punctuation']);

    h.fire.content();

    expect(calls.sort()).toEqual(['collapse-multiple-spaces', 'space-after-punctuation']);
    expect(h.appliedRuleIds.sort()).toEqual(['collapse-multiple-spaces', 'space-after-punctuation']);
  });

  test('CRITICAL: a rule toggled OFF is dropped from enabledIds, its apply is NEVER called, and the others keep working', () => {
    const { h, calls } = fixture({ 'collapse-multiple-spaces': false });

    // 1. The disabled rule is not in the enabled set…
    expect([...h.contribution.getEnabledRuleIds()]).toEqual(['space-after-punctuation']);

    h.fire.content();

    // 2. …the engine never invoked it (the dispatch loop iterates enabledIds)…
    expect(calls).toEqual(['space-after-punctuation']);
    expect(calls).not.toContain('collapse-multiple-spaces');
    // 3. …no edit of that rule reached the buffer…
    expect(h.appliedRuleIds).toEqual(['space-after-punctuation']);
    // 4. …and the run was NOT vacuously empty: the surviving rule still fixed
    //    the document, so this is a per-rule veto, not a dead seam.
    expect(h.applyCalls).toEqual([1]);
    // 5. The master toggle stayed ON the whole time (a master-off short-circuit
    //    would have produced the same empty-A result for the wrong reason).
    expect(h.contribution.getEnabledRuleIds().size).toBe(1);
  });

  test('a rule toggled ON explicitly overrides a defaultEnabled:false rule', () => {
    const calls: string[] = [];
    const offByDefault: TypographyRule = { ...probeRule('opt-in-rule', calls, 1), defaultEnabled: false };
    const h = harness({
      scope: 'all-md',
      path: '/book/content/notes.md',
      lines: PLAIN_LINES,
      rules: [offByDefault]
    });
    // Default state: off, and it stays off through a real keystroke.
    expect([...h.contribution.getEnabledRuleIds()]).toEqual([]);
    h.fire.content();
    expect(calls).toEqual([]);

    const on = harness({
      scope: 'all-md',
      path: '/book/content/notes.md',
      lines: PLAIN_LINES,
      rules: [offByDefault],
      rulePrefs: { 'opt-in-rule': true }
    });
    on.fire.content();
    expect(calls).toEqual(['opt-in-rule']);
    expect(on.appliedRuleIds).toEqual(['opt-in-rule']);
  });

  test('turning EVERY rule off individually (master still on) is equivalent to disabled', () => {
    const { h, calls } = fixture({ 'collapse-multiple-spaces': false, 'space-after-punctuation': false });
    expect(h.contribution.getEnabledRuleIds().size).toBe(0);
    h.fire.content();
    expect(calls).toEqual([]);
    expect(h.applyCalls).toHaveLength(0);
  });

  test('the master toggle vetoes rules whose OWN preference is true', () => {
    const { h, calls } = fixture({ 'collapse-multiple-spaces': true, 'space-after-punctuation': true });
    h.setMasterEnabled(false);
    expect(h.contribution.getEnabledRuleIds().size).toBe(0);
    h.fire.content();
    expect(calls).toEqual([]);
  });
});

/**
 * Q5 debounce/coalescing fixture (F-D5-4). Every OTHER test in this file runs
 * against {@link HarnessContribution}, which overrides `schedulePass` to
 * record the request and run `applyAt` INLINE — real by design for the guard
 * assertions above, but it means TYPOGRAPHY_TYPE_DEBOUNCE_MS coalescing is
 * asserted NOWHERE: a regression that swapped the real debounced
 * `schedulePass` for a direct `applyAt` call would leave every test above
 * green. This fixture instantiates the REAL `AutoTypographyContribution` —
 * `schedulePass`/`cancelScheduledPass` un-overridden — driven by Bun's fake
 * timers, so the debounce window itself has test teeth.
 */
function realScheduleFixture(): {
  contribution: InstanceType<typeof AutoTypographyContribution>;
  widget: any;
  fireKeystroke: () => void;
  computeCalls: BuildContextOptions[];
} {
  const path = '/book/content/chapter-01.md';
  const model = fakeModel(CHAPTER_LINES);
  const content = emitter<ContentChangeLike>();
  const compositionStart = emitter<void>();
  const compositionEnd = emitter<void>();
  const paste = emitter<any>();
  const disposeEmitter = emitter<void>();
  let quotes: 'always' | 'languageDefined' | 'beforeWhitespace' | 'never' = 'languageDefined';

  const control: any = {
    getModel: () => model,
    getOption: () => quotes,
    updateOptions: (next: Record<string, unknown>) => {
      if (typeof next.autoClosingQuotes === 'string') {
        quotes = next.autoClosingQuotes as typeof quotes;
      }
    },
    getSelections: () => [{ isEmpty: () => true }],
    getPosition: () => ({ lineNumber: 3, column: 1 }),
    onDidChangeModelContent: content.on,
    onDidCompositionStart: compositionStart.on,
    onDidCompositionEnd: compositionEnd.on,
    onDidPaste: paste.on
  };

  const editor: any = Object.create(MonacoEditor.prototype);
  editor.uri = new URI(`file://${path}`);
  editor.getControl = () => control;
  const widget: any = { editor, onDispose: disposeEmitter.on };

  const computeCalls: BuildContextOptions[] = [];
  const realAdapter = new TypographyMonacoAdapter();
  const adapter: any = {
    readChangedRange: (event: any) => realAdapter.readChangedRange(event),
    readFrontMatterType: (target: any) => realAdapter.readFrontMatterType(target),
    buildContext: (target: any, buildOptions: BuildContextOptions) => {
      computeCalls.push(buildOptions);
      return realAdapter.buildContext(target, buildOptions);
    },
    applyEdits: () => true
  };
  const engine: any = { computeEdits: () => [] };
  const preferenceService: any = {
    get: (key: string, defaultValue: unknown) => (key === 'aiFocusedEditor.typography.scope' ? 'chapters' : defaultValue),
    onPreferenceChanged: emitter<any>().on
  };
  const ruleProvider: any = {
    getContributions: () => [{ id: 'collapse-multiple-spaces', defaultEnabled: true }]
  };
  const fileService: any = { exists: async () => false, read: async () => ({ value: '' }) };
  const editorManager: any = { onCurrentEditorChanged: emitter<any>().on };

  const contribution = new AutoTypographyContribution();
  Object.assign(contribution as unknown as Record<string, unknown>, {
    editorManager,
    preferenceService,
    engine,
    adapter,
    ruleProvider,
    fileService
  });
  (contribution as any).recomputeEnabled();
  (contribution as any).trackEditor(widget);

  return {
    contribution,
    widget,
    fireKeystroke: () => content.fire(contentChange()),
    computeCalls
  };
}

describe('AutoTypographyContribution — Q5 debounce/coalescing (real timers, F-D5-4)', () => {
  test('N rapid keystrokes inside the debounce window coalesce into exactly ONE engine pass', () => {
    jest.useFakeTimers();
    try {
      const fx = realScheduleFixture();
      for (let i = 0; i < 5; i++) {
        fx.fireKeystroke();
        jest.advanceTimersByTime(TYPOGRAPHY_TYPE_DEBOUNCE_MS - 50);
      }
      expect(fx.computeCalls).toHaveLength(0); // still coalescing — the window keeps resetting

      jest.advanceTimersByTime(60); // the last keystroke's window now elapses
      expect(fx.computeCalls).toHaveLength(1); // exactly one pass for the whole 5-keystroke burst
    } finally {
      jest.useRealTimers();
    }
  });

  test('a keystroke AFTER the debounce window elapses schedules a second, independent pass', () => {
    jest.useFakeTimers();
    try {
      const fx = realScheduleFixture();
      fx.fireKeystroke();
      jest.advanceTimersByTime(TYPOGRAPHY_TYPE_DEBOUNCE_MS);
      expect(fx.computeCalls).toHaveLength(1);

      fx.fireKeystroke();
      jest.advanceTimersByTime(TYPOGRAPHY_TYPE_DEBOUNCE_MS);
      expect(fx.computeCalls).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('cancelScheduledPass (via untrack) drops the pending timer — no pass fires afterward', () => {
    jest.useFakeTimers();
    try {
      const fx = realScheduleFixture();
      fx.fireKeystroke();
      jest.advanceTimersByTime(TYPOGRAPHY_TYPE_DEBOUNCE_MS - 10); // still pending
      (fx.contribution as any).untrack(fx.widget);
      jest.advanceTimersByTime(1000); // long past the original window
      expect(fx.computeCalls).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * MULTI-EDITOR fixture (F-CR-7). Every other fixture in this file tracks exactly
 * ONE editor, which is precisely why the stranded-composition-guard defect was
 * invisible: with one editor open, a contribution-scoped flag and a per-editor
 * flag behave identically.
 *
 * This one puts TWO editors on ONE contribution — the real shape, since
 * `AutoTypographyContribution` is a singleton and `editorStates` is a Map — and
 * gives each its own control, model and hand-fired emitters, so a guard set on A
 * can be observed (or not) from B.
 */
function twoEditorFixture(): {
  contribution: HarnessContribution;
  a: EditorHandle;
  b: EditorHandle;
} {
  const contribution = new HarnessContribution();
  const computeCalls: BuildContextOptions[] = [];
  const realAdapter = new TypographyMonacoAdapter();

  const adapter: any = {
    readChangedRange: (event: any) => realAdapter.readChangedRange(event),
    readFrontMatterType: (target: any) => realAdapter.readFrontMatterType(target),
    buildContext: (target: any, options: BuildContextOptions) => {
      computeCalls.push(options);
      return realAdapter.buildContext(target, options);
    },
    applyEdits: () => true
  };

  const preferenceService: any = {
    get: (key: string, defaultValue: unknown) => {
      if (key === 'aiFocusedEditor.typography.scope') {
        return 'chapters';
      }
      if (key === TYPOGRAPHY_ENABLED_KEY) {
        return true;
      }
      return defaultValue;
    },
    onPreferenceChanged: emitter<any>().on
  };

  Object.assign(contribution as unknown as Record<string, unknown>, {
    editorManager: { onCurrentEditorChanged: emitter<any>().on },
    preferenceService,
    engine: { computeEdits: () => [] },
    adapter,
    ruleProvider: { getContributions: () => [{ id: 'collapse-multiple-spaces', defaultEnabled: true }] },
    fileService: { exists: async () => false, read: async () => ({ value: '' }) }
  });
  (contribution as any).recomputeEnabled();

  // Each editor's passes are counted separately by tagging the shared
  // `computeCalls` recorder with the model the pass actually ran against.
  const passesByModel = new Map<any, number>();
  const make = (path: string): EditorHandle => {
    const model = fakeModel([...CHAPTER_LINES]);
    const content = emitter<ContentChangeLike>();
    const compositionStart = emitter<void>();
    const compositionEnd = emitter<void>();
    const disposeEmitter = emitter<void>();

    const control: any = {
      getModel: () => model,
      getOption: () => 'languageDefined',
      updateOptions: () => undefined,
      getSelections: () => [{ isEmpty: () => true }],
      getPosition: () => ({ lineNumber: 3, column: 1 }),
      onDidChangeModelContent: content.on,
      onDidCompositionStart: compositionStart.on,
      onDidCompositionEnd: compositionEnd.on,
      onDidPaste: emitter<any>().on
    };

    const editor: any = Object.create(MonacoEditor.prototype);
    editor.uri = new URI(`file://${path}`);
    editor.getControl = () => control;
    const widget: any = { editor, onDispose: disposeEmitter.on };

    (contribution as any).trackEditor(widget);

    const before = () => computeCalls.length;
    return {
      widget,
      passes: () => passesByModel.get(model) ?? 0,
      fireContent: () => {
        const mark = before();
        content.fire(contentChange());
        // Attribute any pass produced by THIS editor's change to this model.
        const produced = computeCalls.length - mark;
        passesByModel.set(model, (passesByModel.get(model) ?? 0) + produced);
      },
      fireCompositionStart: () => compositionStart.fire(undefined as never),
      fireCompositionEnd: () => compositionEnd.fire(undefined as never),
      fireDispose: () => disposeEmitter.fire(undefined as never)
    };
  };

  return { contribution, a: make('/book/content/chapter-01.md'), b: make('/book/content/chapter-02.md') };
}

interface EditorHandle {
  widget: any;
  /** How many typography passes THIS editor's content changes have produced. */
  passes: () => number;
  fireContent: () => void;
  fireCompositionStart: () => void;
  fireCompositionEnd: () => void;
  fireDispose: () => void;
}

describe('AutoTypographyContribution — the IME composition guard is PER-EDITOR (F-CR-7)', () => {
  test('POSITIVE CONTROL: with no composition anywhere, both editors run passes', () => {
    const { a, b } = twoEditorFixture();
    a.fireContent();
    b.fireContent();
    expect(a.passes()).toBe(1);
    expect(b.passes()).toBe(1);
  });

  test('CRITICAL: an editor closed MID-COMPOSITION does not kill typography everywhere', () => {
    // The regression this pins: `composing` was a field on the CONTRIBUTION, and
    // only editor A's own `onDidCompositionEnd` listener cleared it. Closing A
    // between composition start and end disposed that listener before it could
    // fire, so the flag stayed true FOREVER and `applyAt` bailed out on its first
    // line for EVERY editor — live typography silently dead until restart, with
    // no error and nothing visible to explain it.
    const { a, b } = twoEditorFixture();

    a.fireCompositionStart();   // IME popup open in A…
    a.fireDispose();            // …and the user closes the tab. No compositionEnd.

    b.fireContent();
    expect(b.passes()).toBe(1); // B is unaffected — was 0 with the shared flag.
  });

  test('composing in one editor does not suppress passes in another', () => {
    // The lesser sibling of the same defect: cross-talk. Even with both tabs
    // open, an IME composition in A used to stop B from running.
    const { a, b } = twoEditorFixture();

    a.fireCompositionStart();

    a.fireContent();
    expect(a.passes()).toBe(0); // A is correctly suppressed — it IS composing.

    b.fireContent();
    expect(b.passes()).toBe(1); // …but B is not.
  });

  test('the guard still works WITHIN the composing editor, and lifts on its end', () => {
    // Guards against "fixed" by simply deleting the guard: A must still be
    // suppressed while composing, and must resume afterwards.
    const { a } = twoEditorFixture();

    a.fireCompositionStart();
    a.fireContent();
    expect(a.passes()).toBe(0);

    a.fireCompositionEnd();
    a.fireContent();
    expect(a.passes()).toBeGreaterThan(0);
  });

  // Sanity case, deliberately modest about what it proves: `untrack` drops the
  // state object entirely, so a re-tracked widget gets a fresh (unsuppressed)
  // state whether or not `untrack` also clears the flag. It pins the end-to-end
  // "close and reopen recovers" behaviour, not the belt-and-braces reset line.
  test('a re-tracked widget is not born suppressed', () => {
    const { contribution, a } = twoEditorFixture();
    a.fireCompositionStart();
    (contribution as any).untrack(a.widget);
    (contribution as any).trackEditor(a.widget);
    a.fireContent();
    expect(a.passes()).toBe(1);
  });
});

describe('AutoTypographyContribution — the context window honours DECLARED look-back (F-CR-4)', () => {
  /** A probe rule that declares a look-back need and never edits anything. */
  function lookbackProbe(id: string, requiredLookbackLines?: number): TypographyRule {
    return {
      id,
      descriptionKey: `ai-focused-editor/typography/${id}-desc`,
      defaultEnabled: true,
      priority: 50,
      requiredLookbackLines,
      apply: () => null
    };
  }

  /** Fire a keystroke on `line` and return the window the seam asked for. */
  function windowFor(rules: readonly TypographyRule[], line: number): BuildContextOptions {
    const h = harness({ rules });
    h.fire.content({
      changes: [{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, text: 'x' }]
    });
    expect(h.computeCalls).toHaveLength(1);
    return h.computeCalls[0];
  }

  test('BASELINE: with no rule declaring anything, the window uses CONTEXT_LOOKBACK_LINES', () => {
    // Pins the historical default, so the aggregation below can only ever WIDEN
    // the window — never silently shrink it.
    expect(windowFor([lookbackProbe('plain')], 6).windowStart).toBe(6 - CONTEXT_LOOKBACK_LINES);
  });

  test('CRITICAL: a rule declaring MORE look-back than the baseline actually gets it', () => {
    // The whole point of F-CR-4: the window size is derived from what rules
    // DECLARE, not from a private constant in this file that no rule can see.
    // 5 is deliberately larger than CONTEXT_LOOKBACK_LINES so the assertion
    // cannot be satisfied by the baseline.
    expect(windowFor([lookbackProbe('hungry', 5)], 6).windowStart).toBe(1);
  });

  test('the aggregate is the MAXIMUM across enabled rules, not the first or the last', () => {
    const rules = [lookbackProbe('a', 1), lookbackProbe('big', 4), lookbackProbe('c', 2)];
    expect(windowFor(rules, 6).windowStart).toBe(2);
    // Order-independent: reversing the registry must not change the window.
    expect(windowFor([...rules].reverse(), 6).windowStart).toBe(2);
  });

  test('a rule the user DISABLED does not widen the window', () => {
    const h = harness({
      rules: [lookbackProbe('a', 1), lookbackProbe('hungry', 5)],
      rulePrefs: { hungry: false }
    });
    h.fire.content({
      changes: [{ range: { startLineNumber: 6, startColumn: 1, endLineNumber: 6, endColumn: 1 }, text: 'x' }]
    });
    expect(h.computeCalls[0].windowStart).toBe(6 - CONTEXT_LOOKBACK_LINES);
  });

  test('CRITICAL INVARIANT: a look-back-declaring rule always SEES the predecessor line', () => {
    // The end-to-end statement the prose in `paragraph-start-capital` used to
    // make on its own: the real rule, from the real registry, run through the
    // real adapter, is handed the line above the one that changed — which is the
    // line its paragraph-start guard reads. Asserted on the SNAPSHOT the rule
    // receives, not on the window option, so a clamping or off-by-one bug in the
    // adapter is caught too.
    const rule = TYPOGRAPHY_RULES.find(candidate => candidate.id === 'paragraph-start-capital')!;
    expect(rule.requiredLookbackLines).toBeGreaterThanOrEqual(1);

    const seen: number[][] = [];
    const h = harness({ rules: [{ ...rule, apply: ctx => { seen.push(ctx.lines.map(l => l.lineNumber)); return null; } }] });
    h.fire.content({
      changes: [{ range: { startLineNumber: 6, startColumn: 1, endLineNumber: 6, endColumn: 1 }, text: 'x' }]
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(6);     // the changed line…
    expect(seen[0]).toContain(5);     // …and its predecessor.
  });
});

describe('AutoTypographyContribution — the window honours DECLARED look-ahead (F-CR2-1)', () => {
  /**
   * The rule at the centre of the defect, taken from the REAL registry (never a
   * hand-written stand-in): #40 refuses to convert a leading `- ` when EITHER
   * neighbour is a Markdown list item, and it is OFF by default, so every case
   * below turns it on explicitly.
   */
  const leadingHyphenRule = TYPOGRAPHY_RULES.find(
    (rule: TypographyRule) => rule.id === 'paragraph-leading-hyphen-to-em-dash'
  )!;
  const RULE_ON = { 'paragraph-leading-hyphen-to-em-dash': true };

  /** Front matter + prose; the caller supplies everything from line 4 down. */
  function chapter(...body: string[]): string[] {
    return ['---', 'type: chapter', '---', ...body];
  }

  /** Fire a keystroke on `line` (the shape monaco reports for one typed char). */
  function typeOn(h: Harness, line: number): void {
    h.fire.content({
      changes: [{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, text: 'x' }]
    });
  }

  test('CRITICAL (the user-visible defect): `- пункт` typed ABOVE an existing list is NOT converted', () => {
    // THE LIVE SCENARIO, built by the SEAM rather than handed to the rule whole.
    // The rule's own suite always passes it a complete window, so its forward
    // guard looked healthy; in the product the window ended at the changed line,
    // `ctx.lines[idx + 1]` was `undefined`, and the bullet the user had just
    // started typing above their list was silently turned into an em dash —
    // breaking the Markdown list and violating the one hard constraint of #40.
    const h = harness({
      lines: chapter('', 'Обычная проза.', '- пункт', '- существующий', '- ещё один'),
      rules: [leadingHyphenRule],
      rulePrefs: RULE_ON
    });

    typeOn(h, 6); // the `- пункт` line the user is on

    // Not vacuous: a pass really ran, over a window that really was widened…
    expect(h.computeCalls).toHaveLength(1);
    expect(h.computeCalls[0].windowEnd).toBe(7);
    // …and the successor list line was actually IN the snapshot the rule saw.
    expect(h.computeCalls[0].changedRange.end.line).toBe(6);
    // The payload: nothing was rewritten.
    expect(h.appliedRuleIds).toEqual([]);
    expect(h.applyCalls).toEqual([]);
  });

  test('ANTI-TAUTOLOGY: the same keystroke on a LONE dialogue line still converts', () => {
    // Guards against "fixing" the case above by disabling the rule, widening
    // nothing, or clamping every edit away. A leading hyphen with no list
    // neighbour in either direction is exactly what #40 exists to convert.
    const h = harness({
      lines: chapter('', 'Обычная проза.', '- Привет.', '', 'Дальше проза.'),
      rules: [leadingHyphenRule],
      rulePrefs: RULE_ON
    });

    typeOn(h, 6);

    expect(h.appliedRuleIds).toEqual(['paragraph-leading-hyphen-to-em-dash']);
  });

  test('the successor line is in the SNAPSHOT the rule receives, not merely in the window option', () => {
    // Asserted on `ctx.lines` so an off-by-one or a clamp regression in the
    // adapter is caught too — the same shape as the look-back invariant test.
    const seen: number[][] = [];
    const h = harness({
      lines: chapter('', 'Обычная проза.', '- пункт', '- существующий'),
      rules: [{ ...leadingHyphenRule, apply: (ctx: any) => { seen.push(ctx.lines.map((l: any) => l.lineNumber)); return null; } }],
      rulePrefs: RULE_ON
    });

    typeOn(h, 6);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(6); // the changed line…
    expect(seen[0]).toContain(7); // …and its SUCCESSOR.
  });

  test('a rule declaring NO look-ahead leaves the window ending exactly where it always did', () => {
    // No baseline in the forward direction: the fix must cost nothing when no
    // enabled rule asked for it.
    const plain: TypographyRule = {
      id: 'plain',
      descriptionKey: 'ai-focused-editor/typography/plain-desc',
      defaultEnabled: true,
      priority: 50,
      apply: () => null
    };
    const h = harness({ rules: [plain] });
    typeOn(h, 6);
    expect(h.computeCalls[0].windowEnd).toBe(6);
  });

  test('a rule the user DISABLED does not widen the window forward', () => {
    const h = harness({
      lines: chapter('', 'Обычная проза.', '- пункт', '- существующий'),
      rules: [leadingHyphenRule],
      rulePrefs: { 'paragraph-leading-hyphen-to-em-dash': false }
    });
    typeOn(h, 6);
    // The whole enabled set is empty, so no pass runs at all.
    expect(h.computeCalls).toHaveLength(0);
  });
});

describe('AutoTypographyContribution — look-ahead lines are CONTEXT, never a write surface (F-CR2-1)', () => {
  test('CRITICAL: a keystroke never rewrites the line BELOW the changed range', () => {
    // THE ISS-272 HAZARD THIS FIX HAD TO ANSWER. The context window doubles as
    // the editable region, so widening it forward would, on its own, license
    // every enabled rule to edit lines the user never touched: type one
    // character on line 6 and the untouched `- Привет.` on line 7 becomes an em
    // dash on its own. Here line 7 IS a convertible dialogue line (its own
    // successor, the blank line 8, is outside the widened window, so #40 really
    // does propose an edit on it) — and that edit must be dropped, not applied.
    const rule = TYPOGRAPHY_RULES.find(
      (candidate: TypographyRule) => candidate.id === 'paragraph-leading-hyphen-to-em-dash'
    )!;
    const proposed: number[] = [];
    const h = harness({
      lines: ['---', 'type: chapter', '---', '', 'Проза.', 'Ещё проза.', '- Привет.', ''],
      rules: [{
        ...rule,
        apply: (ctx: any) => {
          const edits = rule.apply(ctx) ?? [];
          proposed.push(...edits.map(e => e.range.start.line));
          return edits;
        }
      }],
      rulePrefs: { 'paragraph-leading-hyphen-to-em-dash': true }
    });

    h.fire.content({
      changes: [{ range: { startLineNumber: 6, startColumn: 1, endLineNumber: 6, endColumn: 1 }, text: 'x' }]
    });

    // NOT VACUOUS — this is what makes the assertion below a real clamp test:
    // the rule genuinely proposed an edit on line 7, one line past the change.
    expect(proposed).toEqual([7]);
    // …and the seam refused to write it.
    expect(h.applyCalls).toEqual([]);
    expect(h.appliedRuleIds).toEqual([]);
  });
});
