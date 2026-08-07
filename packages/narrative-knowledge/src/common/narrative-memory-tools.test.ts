/**
 * The DECISIONS behind the read-only AI tools (TASK-022 WP-6).
 *
 * This suite is about the rule; `src/browser/narrative-memory-tool-answers.test.ts`
 * is about the answer a tool actually hands back, built over a real index. They
 * are separate because they fail for separate reasons — a wrong rule here makes
 * every tool lie the same way, a wrong projection there makes one tool point at
 * the wrong file.
 */

import { describe, expect, test } from 'bun:test';
import { parseSkillFile, validateSkillDescription } from '@theia/ai-core/lib/common/skill';
import { INDEX_FAILURE_CODES, indexFailureLocalizationKey } from './index-failure';
import { INDEX_STALE_REASONS, type IndexState } from './index-state';
import {
  NARRATIVE_MEMORY_PHRASES,
  indexStaleLocalizationKey
} from './narrative-memory-presentation';
import {
  NARRATIVE_MEMORY_TOOL_IDS,
  NARRATIVE_TOOL_COLLATION_LOCALE,
  NARRATIVE_TOOL_NOTICE_KEYS,
  NARRATIVE_TOOL_PHRASE_KEYS,
  compareEntitiesForDisplay,
  narrativeToolIndexReport
} from './narrative-memory-tools';
import {
  NARRATIVE_MEMORY_QUERY_SKILL_NAME,
  NARRATIVE_MEMORY_QUERY_SKILL_PATH,
  narrativeMemoryQuerySkillFile
} from './narrative-memory-query-skill';

const CATALOG_KEYS = new Set(NARRATIVE_MEMORY_PHRASES.map(entry => entry.key));

describe('WP-6 — the four answers a state produces', () => {
  test('requirement 1: `ready` ANSWERS, and an empty result is authoritative', () => {
    const report = narrativeToolIndexReport({ state: 'ready', generation: 12 });
    expect(report.answered).toBe(true);
    // NOTHING to say. `ready` is the one state where an empty list means what it
    // looks like, so a notice here would train a reader to skip them.
    expect(report.noticeKeys).toEqual([]);
    expect(report.generation).toBe(12);
  });

  test('requirement 2: `rebuilding` is NOT READY, with a sentence', () => {
    const report = narrativeToolIndexReport({ state: 'rebuilding', generation: 3 });
    expect(report.answered).toBe(false);
    expect(report.noticeKeys).toEqual([NARRATIVE_TOOL_NOTICE_KEYS.rebuilding]);
  });

  test('requirement 2: the two `absent` causes are DIFFERENT statements', () => {
    const notBuilt = narrativeToolIndexReport({ state: 'absent', generation: 0, cause: 'not-built' });
    const noManuscript = narrativeToolIndexReport({
      state: 'absent',
      generation: 0,
      cause: 'no-manuscript'
    });
    expect(notBuilt.answered).toBe(false);
    expect(noManuscript.answered).toBe(false);
    expect(notBuilt.absentCause).toBe('not-built');
    expect(noManuscript.absentCause).toBe('no-manuscript');
    // COLLAPSING THEM WOULD SEND AN AUTHOR HUNTING for a Rebuild command that
    // WP-5 removes from the screen in a workspace with no manuscript.
    expect(notBuilt.noticeKeys).not.toEqual(noManuscript.noticeKeys);
    expect(notBuilt.noticeKeys).toEqual([NARRATIVE_TOOL_NOTICE_KEYS.notBuilt]);
    expect(noManuscript.noticeKeys).toEqual([NARRATIVE_TOOL_NOTICE_KEYS.noManuscript]);
  });

  test('requirement 3: `failed` is BROKEN, with the code AND the incident id (ОВ-8)', () => {
    const report = narrativeToolIndexReport({
      state: 'failed',
      generation: 9,
      reason: {
        code: 'storage-corrupted',
        incidentId: 'incident-77',
        occurrences: 2,
        relPath: 'content/ch-01.md'
      }
    });
    expect(report.answered).toBe(false);
    expect(report.failureCode).toBe('storage-corrupted');
    // ОВ-8's "кто что видит" table names this consumer explicitly: the
    // localized phrase for the code, plus the incident id, so a user can tie
    // the model's answer to a line in the backend log.
    expect(report.incidentId).toBe('incident-77');
    expect(report.noticeKeys).toEqual([
      NARRATIVE_TOOL_NOTICE_KEYS.broken,
      indexFailureLocalizationKey('storage-corrupted')
    ]);
    // And NOT the path. That column of the table belongs to Show Index Status.
    expect(JSON.stringify(report)).not.toContain('content/ch-01.md');
    expect(JSON.stringify(report)).not.toContain('occurrences');
  });

  test('requirement 4: `stale` ANSWERS, and the mark carries the REASON', () => {
    for (const reason of INDEX_STALE_REASONS) {
      const report = narrativeToolIndexReport({
        state: 'stale',
        generation: 4,
        staleReason: reason,
        staleSince: 1_700_000_000_000
      });
      // The tool ANSWERS — refusing would make it useless during an ordinary
      // watcher failure that can last a whole session (ОВ-6).
      expect(report.answered).toBe(true);
      // THE REJECTING CASE OF THE READINESS BLOCK. An answer under `stale`
      // without a mark must fail: an implementation returning `noticeKeys: []`
      // here — the natural shape if `stale` is treated as "just another ready" —
      // is red on this line.
      expect(report.noticeKeys.length).toBeGreaterThan(0);
      expect(report.noticeKeys).toContain(NARRATIVE_TOOL_NOTICE_KEYS.stale);
      // And WHICH kind of not-fresh, not merely that it is not fresh: the three
      // reasons have three different remedies.
      expect(report.noticeKeys).toContain(indexStaleLocalizationKey(reason));
      expect(report.staleReason).toBe(reason);
      expect(report.staleSince).toBe(1_700_000_000_000);
    }
  });

  test('every state EXCEPT ready owes the caller at least one sentence', () => {
    // Walks the union rather than listing cases, so a sixth state added to
    // `IndexState` and classified as `answered: true` with nothing to say
    // lands here rather than in production.
    const states: IndexState[] = [
      { state: 'ready', generation: 1 },
      { state: 'rebuilding', generation: 1 },
      { state: 'absent', generation: 0, cause: 'not-built' },
      { state: 'absent', generation: 0, cause: 'no-manuscript' },
      { state: 'failed', generation: 1, reason: { code: 'internal', incidentId: 'i', occurrences: 1 } },
      ...INDEX_STALE_REASONS.map(
        (reason): IndexState => ({ state: 'stale', generation: 1, staleReason: reason, staleSince: 1 })
      )
    ];
    for (const state of states) {
      const report = narrativeToolIndexReport(state);
      expect(report.state).toBe(state.state);
      expect(report.generation).toBe(state.generation);
      if (state.state === 'ready') {
        expect(report.noticeKeys).toEqual([]);
      } else {
        expect(report.noticeKeys.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('WP-6 — display order (ISS-349)', () => {
  test('names are collated under an EXPLICIT locale, not by code point', () => {
    // THE PAIR ISS-349 BUILT, turned around. `Я` is U+042F and `а` is U+0430,
    // so by code point — which is what the index answers in, and rightly —
    // the upper-case word comes FIRST. Under any Russian collation it comes
    // second. An implementation that passed the index's order through, or that
    // sorted names with `<`, returns these two the other way round and fails
    // here.
    expect(compareEntitiesForDisplay({ id: 'a', name: 'арджуна' }, { id: 'b', name: 'Ярость' }))
      .toBeLessThan(0);
    expect('Ярость' < 'арджуна').toBe(true);
  });

  test('the locale is stated, and the collator really honours it', () => {
    expect(NARRATIVE_TOOL_COLLATION_LOCALE).toBe('ru');
    // A runtime built without full ICU collapses `Intl.Collator` to a code-unit
    // comparison and every assertion above would go green for the wrong reason
    // in the other direction. This is the floor case: the collator must NOT
    // agree with `<` on the pair it was chosen for.
    const collated = new Intl.Collator(NARRATIVE_TOOL_COLLATION_LOCALE).compare('арджуна', 'Ярость');
    expect(collated).toBeLessThan(0);
  });

  test('equal names fall back to the id in CODE POINT order, so the order is total', () => {
    // Two cards may legitimately carry one name — that is what an id is for —
    // and a comparator returning 0 there leaves their order to the sort's
    // internals, which is the reproducibility hole this whole decision closes.
    expect(compareEntitiesForDisplay({ id: 'a', name: 'Кришна' }, { id: 'b', name: 'Кришна' }))
      .toBeLessThan(0);
    expect(compareEntitiesForDisplay({ id: 'b', name: 'Кришна' }, { id: 'a', name: 'Кришна' }))
      .toBeGreaterThan(0);
    expect(compareEntitiesForDisplay({ id: 'a', name: 'Кришна' }, { id: 'a', name: 'Кришна' })).toBe(0);
  });

  test('numeric segments order as numbers, not as text', () => {
    expect(compareEntitiesForDisplay({ id: 'x', name: 'Глава 2' }, { id: 'y', name: 'Глава 10' }))
      .toBeLessThan(0);
  });
});

describe('WP-6 — the tools themselves', () => {
  test('four tools, four distinct ids, none colliding with the manuscript_* set', () => {
    expect(NARRATIVE_MEMORY_TOOL_IDS).toHaveLength(4);
    expect(new Set(NARRATIVE_MEMORY_TOOL_IDS).size).toBe(4);
    for (const id of NARRATIVE_MEMORY_TOOL_IDS) {
      // Both sets share ONE `ToolInvocationRegistry` for the whole of WP-7, and
      // a collision there is a silent shadowing in a Map rather than an error.
      expect(id.startsWith('narrative_')).toBe(true);
    }
  });

  test('every tool has a name and a description key, and both are in the catalog', () => {
    // THE DRIFT GUARD between the two halves of the phrase declaration: the keys
    // are built in `narrative-memory-tools.ts` and the phrases live in
    // `narrative-memory-presentation.ts` (they cannot share a module without a
    // cycle). A leaf renamed on one side and not the other is red here, and the
    // ru-bundle test closes the catalog-to-bundle direction.
    for (const id of NARRATIVE_MEMORY_TOOL_IDS) {
      const keys = NARRATIVE_TOOL_PHRASE_KEYS[id];
      expect(keys).toBeDefined();
      expect(CATALOG_KEYS.has(keys.name)).toBe(true);
      expect(CATALOG_KEYS.has(keys.description)).toBe(true);
    }
  });

  test('every notice key is in the catalog too', () => {
    for (const key of Object.values(NARRATIVE_TOOL_NOTICE_KEYS)) {
      expect(CATALOG_KEYS.has(key)).toBe(true);
    }
    // Plus the two families a report REUSES rather than declaring: without
    // these, a `failed` or `stale` answer would render a raw identifier.
    for (const code of INDEX_FAILURE_CODES) {
      expect(CATALOG_KEYS.has(indexFailureLocalizationKey(code))).toBe(true);
    }
    for (const reason of INDEX_STALE_REASONS) {
      expect(CATALOG_KEYS.has(indexStaleLocalizationKey(reason))).toBe(true);
    }
  });
});

describe('WP-6 — the narrative-memory-query skill', () => {
  const file = narrativeMemoryQuerySkillFile();

  test('THEIA parses it and its own validator accepts it', () => {
    // The REAL parser and the REAL validator, not a hand-rolled YAML read.
    // `DefaultSkillService` runs exactly these two functions over the file it
    // finds on disk, and a skill it rejects is one that simply never appears in
    // the Skills list — a silent absence, with nothing in any log the author
    // would look at. The first edition of this file FAILED here: an unquoted
    // description containing a colon is a nested mapping to YAML.
    const parsed = parseSkillFile(file);
    expect(parsed.metadata).toBeDefined();
    expect(validateSkillDescription(parsed.metadata!, NARRATIVE_MEMORY_QUERY_SKILL_NAME)).toEqual([]);
    expect(parsed.metadata!.name).toBe(NARRATIVE_MEMORY_QUERY_SKILL_NAME);
    expect(parsed.metadata!.description.length).toBeGreaterThan(0);
  });

  test('allowedTools names exactly the four tools, and nothing else', () => {
    // `allowedTools` is an ALLOW list, so a tool renamed here and not there
    // fails in the silent direction: the tool is simply not offered.
    const parsed = parseSkillFile(file);
    expect(parsed.metadata!.allowedTools).toEqual([...NARRATIVE_MEMORY_TOOL_IDS]);
  });

  test('the body states the four-state reading and the evidence rule', () => {
    const body = parseSkillFile(file).content;
    for (const state of ['ready', 'rebuilding', 'absent', 'failed', 'stale']) {
      expect(body).toContain(state);
    }
    expect(body).toContain('whole-file');
    expect(body).toContain('ai-candidate');
    // The one-hop boundary with gh#59, in words the model will read.
    expect(body.toLowerCase()).toContain('one hop');
  });

  test('the file on disk in the sample book IS this file, byte for byte', async () => {
    // ONE AUTHORED EDITION. Theia discovers skills as FILES — there is no DI
    // contribution point — so the package cannot ship the skill as code alone;
    // it has to be materialized. Two editions of the same text is how one of
    // them starts lying, and the sample book is the workspace `test:ui` boots.
    const onDisk = await Bun.file(
      new URL(`../../../../examples/sample-book/${NARRATIVE_MEMORY_QUERY_SKILL_PATH}`, import.meta.url)
    ).text();
    expect(onDisk).toBe(file);
  });
});
