/**
 * WP-5's readiness block, as tests (TASK-022).
 *
 * "По случаю на КАЖДУЮ строку таблицы (шесть), плюс СЕДЬМОЙ — `ready → stale`
 * НЕ снимает маркеры И НЕ добавляет новых; тест на `no-manuscript`; тест, что
 * выключение `diagnostics.enabled` снимает маркеры; тест вызова
 * `configure(patch)` ... Плюс ДВА случая на отказ Rebuild по владению."
 *
 * Every one of them is a statement about a DECISION, so every one of them is a
 * call to `narrativeMemoryPresentation()`. Nothing here builds a widget: the
 * contribution that owns `StatusBar` and `ProblemManager` cannot be imported
 * under `bun` at all (`@lumino/domutils` dies at module load), and a case that
 * asserts a rendered widget would be asserting the rendering rather than the
 * rule.
 */

import { describe, expect, test } from 'bun:test';
import type { IndexFailureReason } from './index-failure';
import type { IndexState } from './index-state';
import {
  NARRATIVE_MEMORY_NLS_PREFIX,
  narrativeIndexStatusReport,
  narrativeMemoryPresentation
} from './narrative-memory-presentation';

const FAILURE: IndexFailureReason = {
  code: 'storage-unavailable',
  incidentId: 'inc-1',
  occurrences: 2,
  relPath: 'chapters/01.md'
};

const READY: IndexState = { state: 'ready', generation: 7 };
const REBUILDING: IndexState = { state: 'rebuilding', generation: 7 };
const STALE: IndexState = {
  state: 'stale',
  generation: 7,
  staleReason: 'watcher-lost',
  staleSince: 1_700_000_000_000
};
const NOT_BUILT: IndexState = { state: 'absent', generation: 0, cause: 'not-built' };
const NO_MANUSCRIPT: IndexState = { state: 'absent', generation: 0, cause: 'no-manuscript' };
const FAILED: IndexState = { state: 'failed', generation: 7, reason: FAILURE };

/** The ordinary case: a manuscript, nobody else holding the lock, diagnostics on. */
function show(state: IndexState, overrides: { blocked?: boolean; diagnostics?: boolean } = {}) {
  return narrativeMemoryPresentation({
    state,
    rebuildBlockedByForeignWriter: overrides.blocked ?? false,
    diagnosticsEnabled: overrides.diagnostics ?? true
  });
}

// ---------------------------------------------------------------------------
// The six rows of the plan's state table
// ---------------------------------------------------------------------------

describe('WP-5 state table — one case per row', () => {
  test('row 1, `ready`: normal tone plus the generation; diagnostics publish; both commands available', () => {
    const view = show(READY);
    expect(view.statusBar?.tone).toBe('normal');
    expect(view.statusBar?.phraseKey).toBe(`${NARRATIVE_MEMORY_NLS_PREFIX}/status-ready`);
    // "Норма + `generation`" — the number is on this row and no other.
    expect(view.statusBar?.generation).toBe(7);
    expect(view.diagnostics).toEqual({ publishNew: true, retainExisting: true });
    expect(view.rebuildCommand).toEqual({ visible: true, enabled: true });
    expect(view.showStatusCommand).toEqual({ visible: true, enabled: true });
  });

  test('row 2, `rebuilding`: building; nothing new published; Rebuild unavailable', () => {
    const view = show(REBUILDING);
    expect(view.statusBar?.phraseKey).toBe(`${NARRATIVE_MEMORY_NLS_PREFIX}/status-rebuilding`);
    expect(view.statusBar?.generation).toBeUndefined();
    expect(view.diagnostics.publishNew).toBe(false);
    expect(view.rebuildCommand.visible).toBe(true);
    expect(view.rebuildCommand.enabled).toBe(false);
    expect(view.rebuildCommand.disabledReasonKey).toBe(
      `${NARRATIVE_MEMORY_NLS_PREFIX}/rebuild-blocked-rebuilding`
    );
    // Show Index Status is the ONE surface that always answers: it is how a
    // user finds out why the other command is greyed out.
    expect(view.showStatusCommand.enabled).toBe(true);
  });

  test('row 3, `stale`: WARNING tone and the reason; markers kept, none added; Rebuild available', () => {
    const view = show(STALE);
    // Warning, not error — `stale` data was right and is still usable. An error
    // tone on a working index trains the reader to ignore error tones.
    expect(view.statusBar?.tone).toBe('warning');
    expect(view.statusBar?.detailKeys).toEqual([`${NARRATIVE_MEMORY_NLS_PREFIX}/stale-watcher-lost`]);
    expect(view.diagnostics).toEqual({ publishNew: false, retainExisting: true });
    expect(view.rebuildCommand).toEqual({ visible: true, enabled: true });
  });

  test('row 4, `absent`/`not-built`: not built; nothing published; Rebuild available', () => {
    const view = show(NOT_BUILT);
    expect(view.statusBar?.phraseKey).toBe(`${NARRATIVE_MEMORY_NLS_PREFIX}/status-not-built`);
    expect(view.statusBar?.tone).toBe('normal');
    expect(view.diagnostics).toEqual({ publishNew: false, retainExisting: false });
    expect(view.rebuildCommand).toEqual({ visible: true, enabled: true });
  });

  test('row 5, `absent`/`no-manuscript`: the whole element is HIDDEN and both commands with it', () => {
    const view = show(NO_MANUSCRIPT);
    // `undefined` is the row, not an empty label: a status bar entry about a
    // manuscript index is noise in a folder that holds no manuscript. And it is
    // an ANSWER, not a failure — nothing here may present it as one.
    expect(view.statusBar).toBeUndefined();
    expect(view.rebuildCommand.visible).toBe(false);
    expect(view.showStatusCommand.visible).toBe(false);
    expect(view.diagnostics).toEqual({ publishNew: false, retainExisting: false });
  });

  test('row 6, `failed`: ERROR tone and the code phrase; nothing published; Rebuild available', () => {
    const view = show(FAILED);
    expect(view.statusBar?.tone).toBe('error');
    expect(view.statusBar?.phraseKey).toBe(`${NARRATIVE_MEMORY_NLS_PREFIX}/status-failed`);
    // The CODE's phrase and nothing else: ОВ-8 keeps the path, the occurrence
    // count and the incident id OUT of the status bar.
    expect(view.statusBar?.detailKeys).toEqual([
      `${NARRATIVE_MEMORY_NLS_PREFIX}/index-failure-storage-unavailable`
    ]);
    expect(view.diagnostics).toEqual({ publishNew: false, retainExisting: false });
    expect(view.rebuildCommand).toEqual({ visible: true, enabled: true });
  });

  test('the six rows really are six distinct answers — no two collapse into one', () => {
    // Without this, an implementation that returned the same presentation for
    // every state would pass five of the six cases above by accident of which
    // fields each one happened to assert.
    const rendered = [READY, REBUILDING, STALE, NOT_BUILT, NO_MANUSCRIPT, FAILED].map(state =>
      JSON.stringify(show(state))
    );
    expect(new Set(rendered).size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// The seventh case (ОВ-6 tooth 2)
// ---------------------------------------------------------------------------

describe('WP-5 case 7 — `ready → stale` removes no marker and adds none', () => {
  test('retention survives the transition', () => {
    // TWO SEPARATE ASSERTIONS, as ОВ-6 tooth 2 words them, because they fail
    // for opposite reasons: withdrawing would silently HIDE real broken links,
    // publishing would INVENT new ones from data whose freshness nobody
    // promises any more.
    expect(show(READY).diagnostics.publishNew).toBe(true);
    const after = show(STALE).diagnostics;
    expect(after.retainExisting).toBe(true);
    expect(after.publishNew).toBe(false);
  });

  test('and it holds for all three staleReasons, not just the one', () => {
    for (const staleReason of ['foreign-writer', 'watcher-lost', 'partial-update-failed'] as const) {
      const view = show({ state: 'stale', generation: 3, staleReason, staleSince: 1 });
      expect(view.diagnostics).toEqual({ publishNew: false, retainExisting: true });
      expect(view.statusBar?.detailKeys).toEqual([
        `${NARRATIVE_MEMORY_NLS_PREFIX}/stale-${staleReason}`
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// The diagnostics toggle
// ---------------------------------------------------------------------------

describe('WP-5 — `narrativeMemory.diagnostics.enabled`', () => {
  test('turning it off withdraws the markers, in every state that had any', () => {
    // `retainExisting: false` IS the withdrawal instruction — the publisher
    // clears its own owner. Asserting only `publishNew` would pass on an
    // implementation that merely stopped adding and left the old set on screen,
    // which is exactly the bug the setting exists to prevent.
    for (const state of [READY, REBUILDING, STALE, NOT_BUILT, FAILED]) {
      expect(show(state, { diagnostics: false }).diagnostics).toEqual({
        publishNew: false,
        retainExisting: false
      });
    }
  });

  test('and it changes nothing else — the status bar and both commands are untouched', () => {
    const on = show(READY);
    const off = show(READY, { diagnostics: false });
    expect(off.statusBar).toEqual(on.statusBar);
    expect(off.rebuildCommand).toEqual(on.rebuildCommand);
    expect(off.showStatusCommand).toEqual(on.showStatusCommand);
  });
});

// ---------------------------------------------------------------------------
// The two ownership cases (ОВ-4 tooth 8, WP-5's half)
// ---------------------------------------------------------------------------

describe('WP-5 — Rebuild is refused BY OWNERSHIP, not by state (ОВ-4 / ISS-321)', () => {
  test('a LIVE foreign lock: visible but disabled in BOTH `stale` and `failed`', () => {
    for (const state of [STALE, FAILED]) {
      const view = show(state, { blocked: true });
      // VISIBLE is half the assertion. Hiding the command would leave the user
      // unable to see why the only action the status bar offers does nothing.
      expect(view.rebuildCommand.visible).toBe(true);
      expect(view.rebuildCommand.enabled).toBe(false);
      expect(view.rebuildCommand.disabledReasonKey).toBe(
        `${NARRATIVE_MEMORY_NLS_PREFIX}/rebuild-blocked-foreign-writer`
      );
    }
  });

  test('an EXPIRED lock: available in BOTH — "always refuse" must not pass', () => {
    // The rejecting half of the pair. Without it, an implementation that simply
    // never enables Rebuild would satisfy the case above.
    for (const state of [STALE, FAILED]) {
      expect(show(state, { blocked: false }).rebuildCommand).toEqual({
        visible: true,
        enabled: true
      });
    }
  });

  test('a state-keyed implementation cannot pass both halves', () => {
    // `stale` and `failed` are held CONSTANT across the pair and only the lock
    // moves, so any rule that reads the state instead of the lock returns the
    // same answer twice and fails one of the two.
    for (const state of [STALE, FAILED]) {
      expect(show(state, { blocked: true }).rebuildCommand.enabled).not.toBe(
        show(state, { blocked: false }).rebuildCommand.enabled
      );
    }
  });

  test('ownership overrides `ready` too — the rule says "НЕЗАВИСИМО от состояния"', () => {
    expect(show(READY, { blocked: true }).rebuildCommand.enabled).toBe(false);
    expect(show(NOT_BUILT, { blocked: true }).rebuildCommand.enabled).toBe(false);
  });

  test('but it does not resurrect a command in a workspace with no manuscript', () => {
    // Visibility is decided FIRST for this reason: a lock file left behind in a
    // folder that is not a manuscript must not put a Narrative Memory command
    // on screen.
    const view = show(NO_MANUSCRIPT, { blocked: true });
    expect(view.rebuildCommand.visible).toBe(false);
    expect(view.showStatusCommand.visible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Show Index Status
// ---------------------------------------------------------------------------

describe('WP-5 — Show Index Status reports what the status bar deliberately does not', () => {
  test('`failed`: the whole IndexFailureReason, incident id included (ОВ-8)', () => {
    const report = narrativeIndexStatusReport({
      state: FAILED,
      rebuildBlockedByForeignWriter: false,
      diagnosticsEnabled: true
    });
    expect(report.failure).toEqual(FAILURE);
    expect(report.generation).toBe(7);
  });

  test('`stale`: reason, `staleSince` and generation (ОВ-6)', () => {
    const report = narrativeIndexStatusReport({
      state: STALE,
      rebuildBlockedByForeignWriter: false,
      diagnosticsEnabled: true
    });
    expect(report.staleReason).toBe('watcher-lost');
    expect(report.staleSince).toBe(1_700_000_000_000);
    expect(report.generation).toBe(7);
  });

  test('`generation` is reported on EVERY branch, which is why the envelope exists', () => {
    // An empty answer during a rebuild has to be distinguishable from an empty
    // answer meaning "there is no such thing". A report that dropped the
    // counter on some branches would put that back.
    for (const state of [READY, REBUILDING, STALE, NOT_BUILT, NO_MANUSCRIPT, FAILED]) {
      const report = narrativeIndexStatusReport({
        state,
        rebuildBlockedByForeignWriter: false,
        diagnosticsEnabled: true
      });
      expect(typeof report.generation).toBe('number');
    }
  });

  test('the ownership refusal is reported here even when the state does not mention it', () => {
    const report = narrativeIndexStatusReport({
      state: FAILED,
      rebuildBlockedByForeignWriter: true,
      diagnosticsEnabled: true
    });
    expect(report.rebuildBlockedByForeignWriter).toBe(true);
  });

  test('`no-manuscript` says so instead of pretending to describe an index', () => {
    const report = narrativeIndexStatusReport({
      state: NO_MANUSCRIPT,
      rebuildBlockedByForeignWriter: false,
      diagnosticsEnabled: true
    });
    expect(report.noManuscript).toBe(true);
    expect(report.failure).toBeUndefined();
  });
});
