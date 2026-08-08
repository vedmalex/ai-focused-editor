/**
 * What the timeline panel shows (gh#48 WP-6).
 *
 * The plan names four teeth for this surface, and three of them are decisions
 * rather than rendering, so they live here: a COMBINED filter with both halves
 * paired, a broken reference surfacing as a diagnostic WITH its twin, and the
 * order arriving unchanged. The fourth — the rendered state and the
 * subscription — needs a widget, and is asserted where the widget is.
 */

import { describe, expect, test } from 'bun:test';
import type { IndexedEvent, NarrativeEvent } from '@ai-focused-editor/narrative-knowledge';
import {
  buildTimelineViewModel,
  isEmptyFilter,
  TIMELINE_EXCLUSION_KEYS,
  TIMELINE_ORIGIN_KEYS,
  TIMELINE_FILTER_ROLES
} from './timeline-view-model';

const TIMELINE = 'knowledge/timeline/main.yaml';

function ref(role: string, entityId: string, resolved = true) {
  return { role, raw: `${role}:${entityId}`, entityId, resolved };
}

function event(id: string, overrides: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return {
    id,
    title: id,
    storyTime: { kind: 'unknown' },
    refs: [],
    origin: 'explicit',
    evidence: { path: TIMELINE, evidenceKind: 'whole-file' },
    sourceRefs: [],
    ...overrides
  } as NarrativeEvent;
}

function indexed(e: NarrativeEvent, extra: Partial<IndexedEvent> = {}): IndexedEvent {
  return { event: e, relPath: TIMELINE, ...extra } as IndexedEvent;
}

/** Ivan and Moscow together, Ivan alone, Moscow alone — the fixture a combined
 *  filter needs in order to be able to fail in both directions. */
const CAST: IndexedEvent[] = [
  indexed(event('both', { title: 'Иван в Москве', refs: [ref('participant', 'ivan'), ref('location', 'moscow')] })),
  indexed(event('ivan-only', { title: 'Иван один', refs: [ref('participant', 'ivan'), ref('location', 'kazan')] })),
  indexed(event('moscow-only', { title: 'Москва без Ивана', refs: [ref('participant', 'olga'), ref('location', 'moscow')] }))
];

describe('filters combine by AND', () => {
  test('character AND location keeps only the event with both', () => {
    const model = buildTimelineViewModel(CAST, { participant: 'ivan', location: 'moscow' });
    expect(model.rows.map(row => row.event.id)).toEqual(['both']);
  });

  test('and each half ALONE keeps more — so the line above is not passing by accident', () => {
    // The paired positives. Without them, a filter that returned one arbitrary
    // row, or that ANDed everything into nothing but happened to keep `both`,
    // would satisfy the case above.
    expect(buildTimelineViewModel(CAST, { participant: 'ivan' }).rows.map(row => row.event.id))
      .toEqual(['both', 'ivan-only']);
    expect(buildTimelineViewModel(CAST, { location: 'moscow' }).rows.map(row => row.event.id))
      .toEqual(['both', 'moscow-only']);
    expect(buildTimelineViewModel(CAST, {}).rows).toHaveLength(3);
  });

  test('a combination nobody satisfies yields no rows — and says which kind of empty', () => {
    const model = buildTimelineViewModel(CAST, { participant: 'ivan', location: 'novgorod' });
    expect(model.rows).toEqual([]);
    // NOT `no-events`: the author has three. Telling them "add your first
    // event" here would send them looking for a feature they already use.
    expect(model.emptyKind).toBe('no-matches');
    expect(model.total).toBe(3);
  });

  test('a manuscript with no events at all is a DIFFERENT empty', () => {
    const model = buildTimelineViewModel([], {});
    expect(model.emptyKind).toBe('no-events');
    expect(model.total).toBe(0);
  });

  test('the role a reference carries is part of the match', () => {
    // `moscow` as a PARTICIPANT is not `moscow` as a LOCATION. Matching by id
    // alone would make the two filters interchangeable.
    const odd = [indexed(event('odd', { refs: [ref('participant', 'moscow')] }))];
    expect(buildTimelineViewModel(odd, { location: 'moscow' }).rows).toEqual([]);
    expect(buildTimelineViewModel(odd, { participant: 'moscow' }).rows).toHaveLength(1);
  });

  test('chapter and search narrow too, and search is case-insensitive', () => {
    const byChapter = [
      indexed(event('a', { chapterPath: 'content/ch-01.md', title: 'Приезд' })),
      indexed(event('b', { chapterPath: 'content/ch-02.md', title: 'Отъезд' }))
    ];
    expect(buildTimelineViewModel(byChapter, { chapterPath: 'content/ch-01.md' }).rows.map(r => r.event.id))
      .toEqual(['a']);
    expect(buildTimelineViewModel(byChapter, { search: 'ПРИЕЗД' }).rows.map(r => r.event.id)).toEqual(['a']);
    // A blank search is not a filter — trimmed to nothing means "show all".
    expect(buildTimelineViewModel(byChapter, { search: '   ' }).rows).toHaveLength(2);
  });
});

describe('a broken reference is a diagnostic, not a disappearance', () => {
  const broken = [
    indexed(event('has-broken', { refs: [ref('participant', 'ivan', true), ref('participant', 'nobody', false)] })),
    indexed(event('all-fine', { refs: [ref('participant', 'ivan', true)] }))
  ];

  test('the event is KEPT, and the unresolved reference is named on the row', () => {
    const model = buildTimelineViewModel(broken, {});
    expect(model.rows.map(row => row.event.id)).toEqual(['has-broken', 'all-fine']);
    expect(model.rows[0].brokenRefs.map(item => item.entityId)).toEqual(['nobody']);
    expect(model.brokenCount).toBe(1);
  });

  test('and an event whose references all resolve carries none — the twin', () => {
    // The paired positive the plan asks for: "a reference fixed by editing the
    // card stops being a diagnostic". Without it, marking EVERY row broken
    // would pass the case above.
    const model = buildTimelineViewModel(broken, {});
    expect(model.rows[1].brokenRefs).toEqual([]);
  });

  test('a filter still matches through a broken reference', () => {
    // The author wrote `char:nobody` deliberately; filtering by it must find
    // the event, or the diagnostic is unreachable from the panel that shows it.
    expect(buildTimelineViewModel(broken, { participant: 'nobody' }).rows.map(r => r.event.id))
      .toEqual(['has-broken']);
  });
});

describe('the order arrives already decided', () => {
  test('rows keep the order they were given, both ways', () => {
    // The panel must not re-sort: the rule lives in `event-ordering.ts`, and a
    // second edition here would be a third spelling of it. A fixture where the
    // two orders DISAGREE is what makes this assertable — the same flashback
    // shape the store's own contract uses.
    const story = [indexed(event('flashback')), indexed(event('opening'))];
    const manuscript = [indexed(event('opening')), indexed(event('flashback'))];
    expect(buildTimelineViewModel(story, {}).rows.map(r => r.event.id)).toEqual(['flashback', 'opening']);
    expect(buildTimelineViewModel(manuscript, {}).rows.map(r => r.event.id)).toEqual(['opening', 'flashback']);
  });

  test('an unplaceable event stays visible, carrying its reason', () => {
    // Hiding it would make the panel tidier and the manuscript misrepresented.
    const rows = buildTimelineViewModel(
      [indexed(event('placed')), indexed(event('unplaced'), { orderExclusion: 'no-sequence' })],
      {}
    ).rows;
    expect(rows.map(row => row.event.id)).toEqual(['placed', 'unplaced']);
    expect(rows[0].orderExclusion).toBeUndefined();
    expect(rows[1].orderExclusion).toBe('no-sequence');
  });
});

describe('facets are built from the events themselves', () => {
  test('each role offers what its events actually carry, most used first', () => {
    const model = buildTimelineViewModel(CAST, {});
    expect(model.facets.participant.map(f => `${f.id}:${f.count}`)).toEqual(['ivan:2', 'olga:1']);
    expect(model.facets.location.map(f => `${f.id}:${f.count}`)).toEqual(['moscow:2', 'kazan:1']);
    // A role nobody uses offers nothing, rather than offering the whole
    // registry and matching none of it.
    expect(model.facets.thread).toEqual([]);
  });

  test('an id named twice by ONE event counts once', () => {
    // The facet answers "how many events would this filter keep", and the
    // filter is a membership test — counting occurrences would overstate it.
    const twice = [indexed(event('t', { refs: [ref('participant', 'ivan'), ref('participant', 'ivan')] }))];
    expect(buildTimelineViewModel(twice, {}).facets.participant).toEqual([{ id: 'ivan', count: 1 }]);
  });

  test('facets are computed over ALL events, not over the filtered rows', () => {
    // Otherwise choosing one value empties every other list and the author
    // cannot change their mind without clearing the filter first.
    const model = buildTimelineViewModel(CAST, { participant: 'ivan', location: 'moscow' });
    expect(model.rows).toHaveLength(1);
    // EVERY role, not one of them: a facet list narrowed for `location` alone
    // would pass a check that only looked at `participant`, and vice versa.
    expect(model.facets.location.map(f => f.id)).toEqual(['moscow', 'kazan']);
    expect(model.facets.participant.map(f => f.id)).toEqual(['ivan', 'olga']);
    expect(model.chapters).toEqual(buildTimelineViewModel(CAST, {}).chapters);
  });

  test('chapters are offered the same way', () => {
    const model = buildTimelineViewModel(
      [indexed(event('a', { chapterPath: 'content/ch-01.md' })), indexed(event('b'))],
      {}
    );
    // The event naming NO chapter contributes nothing rather than an empty key.
    expect(model.chapters).toEqual([{ id: 'content/ch-01.md', count: 1 }]);
  });
});

describe('the totals a panel shows beside the list', () => {
  test('`total` is the unfiltered count, so "N of M" cannot disagree with itself', () => {
    const model = buildTimelineViewModel(CAST, { participant: 'ivan' });
    expect(model.rows).toHaveLength(2);
    expect(model.total).toBe(3);
  });
});

describe('isEmptyFilter', () => {
  test('distinguishes "no filter" from "a filter that matches nothing"', () => {
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ search: '  ' })).toBe(true);
    expect(isEmptyFilter({ participant: 'ivan' })).toBe(false);
    expect(isEmptyFilter({ search: 'x' })).toBe(false);
    expect(isEmptyFilter({ chapterPath: 'content/ch-01.md' })).toBe(false);
  });
});

describe('the total records cannot render blank', () => {
  test('every exclusion reason and every origin has a key', () => {
    // Compile-time totality is the real guard; this walks it so that a member
    // added with an empty string still fails.
    for (const value of Object.values(TIMELINE_EXCLUSION_KEYS)) {
      expect(value.length).toBeGreaterThan(0);
    }
    for (const value of Object.values(TIMELINE_ORIGIN_KEYS)) {
      expect(value.length).toBeGreaterThan(0);
    }
    expect(Object.keys(TIMELINE_EXCLUSION_KEYS)).toHaveLength(5);
    expect(Object.keys(TIMELINE_ORIGIN_KEYS)).toHaveLength(3);
    expect(TIMELINE_FILTER_ROLES).toHaveLength(3);
  });
});
