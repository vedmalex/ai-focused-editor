/**
 * ОВ-8's "кто что видит" table, as tests (TASK-022 WP-5).
 *
 * The status bar and Show Index Status deliberately see DIFFERENT amounts of
 * the same failure, and the difference is a sanitation decision rather than a
 * layout preference: the status bar is always on screen, in a shared office, in
 * a screenshot. So it gets the phrase and nothing else, while the surface the
 * user has to open on purpose gets the path, the count and the incident id.
 */

import { describe, expect, test } from 'bun:test';
import {
  narrativeIndexStatusReport,
  narrativeMemoryPresentation,
  type IndexState
} from '../common';
import {
  indexStatusReportLines,
  statusBarText,
  statusBarTooltip
} from './narrative-memory-render';

const INCIDENT = 'a1b2c3d4';

const failedWith = (relPath?: string): IndexState => ({
  state: 'failed',
  generation: 12,
  reason: {
    code: 'permission-denied',
    incidentId: INCIDENT,
    occurrences: 37,
    ...(relPath !== undefined ? { relPath } : {})
  }
});

function view(state: IndexState, blocked = false) {
  return narrativeMemoryPresentation({
    state,
    rebuildBlockedByForeignWriter: blocked,
    diagnosticsEnabled: true
  });
}

function report(state: IndexState, blocked = false) {
  return indexStatusReportLines(
    narrativeIndexStatusReport({
      state,
      rebuildBlockedByForeignWriter: blocked,
      diagnosticsEnabled: true
    })
  );
}

describe('WP-5 — the status bar shows the phrase and nothing sensitive', () => {
  test('a failure renders as an icon and a sentence, with no path, count or incident id', () => {
    const model = view(failedWith('chapters/03.md')).statusBar!;
    const text = `${statusBarText(model)}\n${statusBarTooltip(model)}`;
    expect(text).not.toContain(INCIDENT);
    expect(text).not.toContain('chapters/03.md');
    expect(text).not.toContain('37');
    expect(text).toContain('$(error)');
  });

  test('`ready` carries the generation and `not-built` does not', () => {
    expect(statusBarText(view({ state: 'ready', generation: 42 }).statusBar!)).toContain('42');
    expect(
      statusBarText(view({ state: 'absent', generation: 0, cause: 'not-built' }).statusBar!)
    ).not.toContain('(0)');
  });

  test('the tooltip adds the reason line that the label has no room for', () => {
    const model = view({
      state: 'stale',
      generation: 5,
      staleReason: 'foreign-writer',
      staleSince: 1
    }).statusBar!;
    expect(statusBarTooltip(model).split('\n')).toHaveLength(2);
    expect(statusBarText(model).split('\n')).toHaveLength(1);
  });
});

describe('WP-5 — Show Index Status shows what the status bar withholds', () => {
  test('the incident id appears, on its own line, never inside a sentence', () => {
    const lines = report(failedWith('chapters/03.md'));
    const carrying = lines.filter(line => line.includes(INCIDENT));
    expect(carrying).toHaveLength(1);
    // A LABEL AND A VALUE, joined here rather than substituted into a
    // translated phrase. A translator may reorder a sentence; an identifier the
    // user is about to paste into a bug report may not be reordered, and
    // putting it inside a localized string gives away the power to do it.
    expect(carrying[0].endsWith(`: ${INCIDENT}`)).toBe(true);
  });

  test('the path and the occurrence count are both there', () => {
    const body = report(failedWith('chapters/03.md')).join('\n');
    expect(body).toContain('chapters/03.md');
    expect(body).toContain('37');
  });

  test('an ABSENT relPath prints no path line at all — it is not "undefined"', () => {
    // ОВ-8 rule 1 DELETES the field when the file lies outside the workspace,
    // because a path outside the workspace is exactly the one that carries a
    // home directory and a user name. A renderer that printed the label with an
    // empty value would announce the deletion instead of honouring it.
    const body = report(failedWith()).join('\n');
    expect(body.toLowerCase()).not.toContain('undefined');
    expect(report(failedWith()).length).toBe(report(failedWith('a.md')).length - 1);
  });

  test('the generation is reported in every state, `no-manuscript` included', () => {
    for (const state of [
      { state: 'ready', generation: 9 },
      { state: 'rebuilding', generation: 9 },
      { state: 'absent', generation: 0, cause: 'no-manuscript' },
      { state: 'absent', generation: 0, cause: 'not-built' }
    ] as IndexState[]) {
      expect(report(state).some(line => /\d/.test(line))).toBe(true);
    }
  });

  test('a live foreign lock adds a line saying why Rebuild is unavailable', () => {
    const withLock = report(failedWith(), true);
    const without = report(failedWith(), false);
    expect(withLock.length).toBe(without.length + 1);
  });

  test('no line is a bare key — every phrase resolved through the catalog', () => {
    // `localizeKey` falls back to the leaf name when a key is missing from the
    // catalog, which is the right degradation for a running editor and a silent
    // defect for a test that only checks the lines are non-empty.
    for (const state of [
      failedWith('a.md'),
      { state: 'stale', generation: 1, staleReason: 'watcher-lost', staleSince: 2 } as IndexState,
      { state: 'ready', generation: 1 } as IndexState
    ]) {
      for (const line of report(state)) {
        expect(line).not.toMatch(/^[a-z-]+$/);
        expect(line.length).toBeGreaterThan(3);
      }
    }
  });
});
