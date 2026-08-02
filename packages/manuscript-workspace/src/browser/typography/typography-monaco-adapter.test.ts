import { describe, expect, test } from 'bun:test';
import { TypographyMonacoAdapter } from './typography-monaco-adapter';
import type { TypographyEdit } from '../../common/typography/typography-types';

/**
 * Seam-double for the undo contract (TASK-019 §2, DEFECT-2 mechanism). A fake
 * `ITextModel` records the exact call sequence so we can assert `applyEdits`
 * emits ONE discrete undo element: `pushStackElement` -> a single
 * `pushEditOperations` -> `pushStackElement`. That is the boundary shape one
 * Ctrl+Z reverts (the same pattern proofreading-widget.applyScopedEdit proved
 * works live). The *live* undo re-validation — that a real Cmd+Z now stands
 * rather than being re-applied — is the contribution-level `isUndoing` guard,
 * verified on the running app by the orchestrator.
 */
function fakeModel(overrides: Partial<Record<string, unknown>> = {}): {
  model: any;
  calls: string[];
} {
  const calls: string[] = [];
  const model: any = {
    getLineCount: () => 5,
    getLineMaxColumn: () => 200,
    pushStackElement: () => calls.push('stack'),
    pushEditOperations: (_before: unknown, ops: unknown[]) => {
      calls.push(`edit:${(ops as unknown[]).length}`);
      return null;
    },
    ...overrides
  };
  return { model, calls };
}

function edit(startCol: number, endCol: number, text: string): TypographyEdit {
  return {
    range: { start: { line: 1, column: startCol }, end: { line: 1, column: endCol } },
    text,
    ruleId: 'collapse-multiple-spaces'
  };
}

/**
 * Seam-double for the LIVE context path. `buildContext` only needs the document
 * text, so a line-backed model in the same style as {@link fakeModel} is enough;
 * `tokenization` is absent on purpose so the pure code mask stands alone (the
 * documented fail-open branch of `refineWithMonaco`).
 */
function contentModel(lines: string[]): any {
  return {
    getLinesContent: () => [...lines],
    getLineCount: () => lines.length,
    getLineMaxColumn: (line: number) => (lines[line - 1]?.length ?? 0) + 1
  };
}

function contextOptions(windowStart: number, windowEnd: number) {
  return {
    changedRange: {
      start: { line: windowStart, column: 1 },
      end: { line: windowEnd, column: 1 }
    },
    cursor: { line: windowStart, column: 1 },
    trigger: 'type' as const,
    locale: 'ru',
    windowStart,
    windowEnd
  };
}

describe('TypographyMonacoAdapter.buildContext (front matter is code — ISS-241)', () => {
  const doc = [
    '---',
    'title: привет,мир',
    'type: chapter',
    'updated: 2026-08-01T10:20',
    '---',
    '',
    'иван шёл ,молча'
  ];

  test('every front-matter line (delimiters included) is snapshotted as isCode', () => {
    const adapter = new TypographyMonacoAdapter();
    const ctx = adapter.buildContext(contentModel(doc), contextOptions(1, doc.length));

    expect(ctx.lines.map(line => line.isCode)).toEqual([
      true, true, true, true, true, false, false
    ]);
    // Code lines carry no tokens, so no rule can even address a span inside them.
    expect(ctx.lines.slice(0, 5).every(line => line.tokens.length === 0)).toBe(true);
  });

  test('a live window that starts INSIDE the front matter still sees it as code', () => {
    // The typing seam snapshots a small window; the mask is computed over the
    // whole document, so line 3 is code even though line 1 is out of window.
    const adapter = new TypographyMonacoAdapter();
    const ctx = adapter.buildContext(contentModel(doc), contextOptions(3, 4));

    expect(ctx.lines.map(line => ({ lineNumber: line.lineNumber, isCode: line.isCode }))).toEqual([
      { lineNumber: 3, isCode: true },
      { lineNumber: 4, isCode: true }
    ]);
  });

  test('a mid-document --- separator is NOT treated as front matter', () => {
    const adapter = new TypographyMonacoAdapter();
    const lines = ['проза', '', '---', 'type: chapter', '---', 'ещё'];
    const ctx = adapter.buildContext(contentModel(lines), contextOptions(1, lines.length));

    expect(ctx.lines.every(line => !line.isCode)).toBe(true);
  });
});

describe('TypographyMonacoAdapter.buildContext window clamping (F-CR2-1)', () => {
  const lines = ['одна', 'две', 'три'];

  test('CRITICAL: a windowEnd PAST the last line is clamped, not an out-of-range read', () => {
    // The look-ahead widening adds `requiredLookaheadLines` to `windowEnd`
    // unconditionally, so on the last line of a document the seam asks for a line
    // that does not exist. This is the clamp both drivers rely on instead of
    // guarding at the call site — asserted rather than assumed.
    const adapter = new TypographyMonacoAdapter();
    const ctx = adapter.buildContext(contentModel(lines), contextOptions(2, 99));

    expect(ctx.lines.map(line => line.lineNumber)).toEqual([2, 3]);
    // No `undefined` text sneaks in as a snapshot for the phantom lines.
    expect(ctx.lines.every(line => typeof line.text === 'string')).toBe(true);
  });

  test('a windowStart above line 1 is clamped the same way', () => {
    const adapter = new TypographyMonacoAdapter();
    const ctx = adapter.buildContext(contentModel(lines), contextOptions(-4, 2));
    expect(ctx.lines.map(line => line.lineNumber)).toEqual([1, 2]);
  });
});

describe('TypographyMonacoAdapter.applyEdits (discrete undo contract)', () => {
  test('a fitting edit produces exactly ONE discrete undo element', () => {
    const adapter = new TypographyMonacoAdapter();
    const { model, calls } = fakeModel();

    const wrote = adapter.applyEdits(model, [edit(1, 3, ' ')]);

    expect(wrote).toBe(true);
    // stack (close prior element) -> single edit batch -> stack (close ours):
    // one Ctrl+Z reverts precisely this auto-fix.
    expect(calls).toEqual(['stack', 'edit:1', 'stack']);
  });

  test('multiple edits collapse into a SINGLE pushEditOperations (one undo step)', () => {
    const adapter = new TypographyMonacoAdapter();
    const { model, calls } = fakeModel();

    const wrote = adapter.applyEdits(model, [edit(1, 3, ' '), edit(5, 7, ' ')]);

    expect(wrote).toBe(true);
    expect(calls).toEqual(['stack', 'edit:2', 'stack']);
  });

  test('an empty edit list writes nothing and pushes no undo boundary', () => {
    const adapter = new TypographyMonacoAdapter();
    const { model, calls } = fakeModel();

    expect(adapter.applyEdits(model, [])).toBe(false);
    expect(calls).toEqual([]);
  });

  test('drift guard: an out-of-range edit is dropped, leaving no empty undo element', () => {
    const adapter = new TypographyMonacoAdapter();
    // endColumn 500 exceeds getLineMaxColumn (200) -> range no longer fits.
    const { model, calls } = fakeModel();

    expect(adapter.applyEdits(model, [edit(1, 500, ' ')])).toBe(false);
    // No operations survived the drift guard, so no stack/edit calls at all.
    expect(calls).toEqual([]);
  });

  test('a drifted edit is dropped but a fitting sibling still applies as one element', () => {
    const adapter = new TypographyMonacoAdapter();
    const { model, calls } = fakeModel();

    const wrote = adapter.applyEdits(model, [edit(1, 500, ' '), edit(1, 3, ' ')]);

    expect(wrote).toBe(true);
    expect(calls).toEqual(['stack', 'edit:1', 'stack']);
  });
});
