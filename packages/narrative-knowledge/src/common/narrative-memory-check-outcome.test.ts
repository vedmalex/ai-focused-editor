/**
 * "Check for Changes Now" — the outcome-classification decisions, as tests
 * (TASK-022 UR-036 part 1, UR-037, UR-038, ISS-361).
 *
 * Every case here calls a PURE function in `narrative-memory-presentation.ts`
 * — no widget, no RPC, no store — so it runs in the ordinary `test:packages`
 * lane under `bun`, the same reason `narrative-memory-presentation.test.ts`
 * next to this file does.
 */

import { describe, expect, test } from 'bun:test';
import type { NarrativeUpdateReport } from './narrative-index-update';
import {
  checkForChangesFailurePresentation,
  checkForChangesOutcome,
  NARRATIVE_MEMORY_NLS_PREFIX
} from './narrative-memory-presentation';

/** A report that changed and broke nothing — the baseline every case edits from. */
function report(overrides: Partial<NarrativeUpdateReport> = {}): NarrativeUpdateReport {
  return {
    mode: 'incremental',
    documentsReindexed: [],
    documentsRemoved: [],
    documentsMoved: [],
    unchangedDocuments: [],
    mentionsWritten: 0,
    eventsWritten: 0,
    derivedRelations: 0,
    unreadableDocuments: [],
    ...overrides
  };
}

describe('checkForChangesOutcome — UR-037: "обновлено" vs "изменений не найдено"', () => {
  test('nothing written at all is `no-changes`', () => {
    expect(checkForChangesOutcome(report()).resultKind).toBe('no-changes');
  });

  test('a reindexed document is `updated`', () => {
    expect(checkForChangesOutcome(report({ documentsReindexed: ['chapters/01.md'] })).resultKind).toBe('updated');
  });

  test('a removed document is `updated`', () => {
    expect(checkForChangesOutcome(report({ documentsRemoved: ['chapters/01.md'] })).resultKind).toBe('updated');
  });

  test('a moved document is `updated`', () => {
    expect(
      checkForChangesOutcome(report({ documentsMoved: [{ from: 'a.md', to: 'b.md' }] })).resultKind
    ).toBe('updated');
  });

  test('an unchanged document offered but identical is still `no-changes`', () => {
    expect(checkForChangesOutcome(report({ unchangedDocuments: ['chapters/01.md'] })).resultKind).toBe(
      'no-changes'
    );
  });

  test('an escalated full rebuild is `updated` even though its per-document lists are reported empty', () => {
    // `NarrativeIndexMaintainer.asUpdateEnvelope` reports `documentsReindexed`
    // etc. as `[]` BY CONSTRUCTION for `mode: 'rebuild'` — a classifier that
    // only looked at those lists would misreport a real, work-doing escalation
    // as "no changes found", exactly the false negative UR-037 exists to rule
    // out ("иначе автор не отличит успешную проверку от неработающей кнопки").
    expect(checkForChangesOutcome(report({ mode: 'rebuild' })).resultKind).toBe('updated');
  });
});

describe('checkForChangesOutcome — UR-038: the fourth, independent outcome', () => {
  test('unreadable files are counted even when nothing else changed', () => {
    const outcome = checkForChangesOutcome(report({ unreadableDocuments: ['broken.md'] }));
    expect(outcome.resultKind).toBe('no-changes');
    expect(outcome.unreadableCount).toBe(1);
  });

  test('no unreadable files reports a count of zero, not an absent field standing in for it', () => {
    expect(checkForChangesOutcome(report()).unreadableCount).toBe(0);
  });

  test('COMBINATION — updated AND unreadable are BOTH reported, not one chosen over the other', () => {
    // UR-038, verbatim: "Если проход И обновил что-то, И встретил
    // непрочитанные файлы — показываются ОБА факта, а не выбирается «более
    // важный». Обновление без оговорки об ошибке — это отчёт, утверждающий
    // полноту, которой не было."
    const outcome = checkForChangesOutcome(
      report({ documentsReindexed: ['ok.md'], unreadableDocuments: ['broken-1.md', 'broken-2.md'] })
    );
    expect(outcome.resultKind).toBe('updated');
    expect(outcome.unreadableCount).toBe(2);
  });
});

describe('checkForChangesFailurePresentation — ISS-361: a refused write reads as ownership, not a raw throw', () => {
  test('a live foreign lock (`available: false`) reads as the ownership-specific phrase', () => {
    expect(checkForChangesFailurePresentation({ available: false }).messageKey).toBe(
      `${NARRATIVE_MEMORY_NLS_PREFIX}/check-blocked-foreign-writer`
    );
  });

  test('any OTHER failure (`available: true`) reads as the generic, backend-log-pointing phrase', () => {
    // `available: true` alongside a caught exception means the failure was
    // something OTHER than a live foreign lock — the same "ask again, at the
    // moment" read `rebuild()`'s own handler already relies on, applied to a
    // command that could not gate its call ahead of time (UR-036 part 1).
    expect(checkForChangesFailurePresentation({ available: true }).messageKey).toBe(
      `${NARRATIVE_MEMORY_NLS_PREFIX}/check-failed`
    );
  });

  test('the two failure phrases are never the same key — a caller could not tell them apart otherwise', () => {
    const blocked = checkForChangesFailurePresentation({ available: false }).messageKey;
    const generic = checkForChangesFailurePresentation({ available: true }).messageKey;
    expect(blocked).not.toBe(generic);
  });
});
