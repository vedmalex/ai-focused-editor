/**
 * Writing an event into an author's file (gh#48 WP-5).
 *
 * THE CENTRAL ASSERTION IS A BYTE ONE. This module edits a file a human wrote,
 * so "the event was added" is not the interesting half — "and nothing else
 * moved" is. Every append case below checks that the previous text is a literal
 * PREFIX of the new text, which is the strongest form the claim has: not "looks
 * the same", not "parses the same", but the same bytes in the same places.
 *
 * The one deliberate exception (`events: []` becoming `events:`) is pinned by
 * its own case, so the exception cannot quietly widen.
 */

import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';
import {
  appendEventToTimeline,
  createEventId,
  eventIdsIn,
  uniqueEventId,
  DEFAULT_TIMELINE_FILE
} from './timeline-event-authoring';

const CHAPTER = 'content/ch-01.md';

const EVENT = {
  title: 'Иван приезжает',
  chapterPath: CHAPTER,
  range: { startLine: 23, endLine: 30 }
};

/** The appended text, parsed — for asserting what the INDEX will later read. */
function eventsOf(text: string): { id: string; title: string; chapter?: string; source_refs?: unknown[] }[] {
  const parsed = parseYaml(text) as { events: { id: string; title: string; chapter?: string; source_refs?: unknown[] }[] };
  return parsed.events;
}

describe('createEventId', () => {
  test('transliterates, slugs and prefixes', () => {
    expect(createEventId('Иван приезжает')).toBe('event-ivan-priezzhaet');
    expect(createEventId('Arrival in Moscow!')).toBe('event-arrival-in-moscow');
  });

  test('a title that slugs to nothing still yields a usable id', () => {
    // The paired negative of the case above: an id is a KEY, and returning ''
    // or 'event-' would produce a file the index cannot read.
    expect(createEventId('…')).toBe('event');
    expect(createEventId('')).toBe('event');
  });

  test('no trailing dash survives truncation', () => {
    const long = createEventId('а'.repeat(200));
    expect(long.endsWith('-')).toBe(false);
    expect(long.length).toBeLessThanOrEqual(66);
  });
});

describe('uniqueEventId', () => {
  test('leaves a free id alone and suffixes a taken one', () => {
    expect(uniqueEventId('event-a', new Set())).toBe('event-a');
    expect(uniqueEventId('event-a', new Set(['event-a']))).toBe('event-a-2');
    expect(uniqueEventId('event-a', new Set(['event-a', 'event-a-2']))).toBe('event-a-3');
  });
});

describe('eventIdsIn', () => {
  test('reads the ids of a real file, and answers EMPTY for what it cannot read', () => {
    expect([...eventIdsIn('events:\n  - id: a\n  - id: b\n')].sort()).toEqual(['a', 'b']);
    // Not a judgement about validity — just "no ids to avoid".
    expect(eventIdsIn(undefined).size).toBe(0);
    expect(eventIdsIn('this: is not a timeline').size).toBe(0);
    expect(eventIdsIn(': : broken yaml : :').size).toBe(0);
  });
});

describe('appendEventToTimeline — a new file', () => {
  test('creates one the index can read', () => {
    const result = appendEventToTimeline(undefined, EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const events = eventsOf(result.text);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('event-ivan-priezzhaet');
    expect(events[0].title).toBe('Иван приезжает');
    expect(events[0].chapter).toBe(CHAPTER);
    expect(events[0].source_refs).toEqual([{ path: CHAPTER, startLine: 23, endLine: 30 }]);
  });

  test('an empty existing file is treated as a new one, not appended to', () => {
    const result = appendEventToTimeline('   \n\n', EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(eventsOf(result.text)).toHaveLength(1);
  });
});

describe('appendEventToTimeline — an existing file', () => {
  /** A file with COMMENTS, blank lines, quoting choices and a trailing entry —
   *  every one of which a re-serializing implementation would silently
   *  rewrite. */
  const AUTHORED = [
    '# Мой таймлайн. Не трогать порядок!',
    '',
    'events:',
    '  - id: event-otъezd',
    "    title: 'Отъезд'",
    '    sequence: 10',
    '',
    '  # черновик, потом уточню',
    '  - id: event-vozvrashchenie',
    '    title: Возвращение',
    ''
  ].join('\n');

  test('everything the author wrote survives BYTE FOR BYTE', () => {
    const result = appendEventToTimeline(AUTHORED, EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // THE ASSERTION THIS FILE EXISTS FOR. A parse-and-restringify
    // implementation passes every other case here and fails this one: it drops
    // the comments, unquotes `'Отъезд'` and removes the blank lines.
    expect(result.text.startsWith(AUTHORED)).toBe(true);
    expect(result.text).toContain('# Мой таймлайн. Не трогать порядок!');
    expect(result.text).toContain('  # черновик, потом уточню');
    expect(result.text).toContain("    title: 'Отъезд'");
  });

  test('and the new event is really there, after the old ones', () => {
    const result = appendEventToTimeline(AUTHORED, EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(eventsOf(result.text).map(item => item.id)).toEqual([
      'event-otъezd',
      'event-vozvrashchenie',
      'event-ivan-priezzhaet'
    ]);
  });

  test('an id already in the file is not reused', () => {
    const taken = 'events:\n  - id: event-ivan-priezzhaet\n    title: Уже есть\n';
    const result = appendEventToTimeline(taken, EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.eventId).toBe('event-ivan-priezzhaet-2');
    // PAIRED POSITIVE: the incumbent keeps its id and its title.
    const events = eventsOf(result.text);
    expect(events[0].title).toBe('Уже есть');
    expect(events).toHaveLength(2);
  });

  test('a file with no trailing newline gains one rather than a joined line', () => {
    const result = appendEventToTimeline('events:\n  - id: a\n    title: A', EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(eventsOf(result.text)).toHaveLength(2);
    expect(result.text).not.toContain('title: A  - id:');
  });

  test('`events: []` becomes a block list — the ONE line this may rewrite', () => {
    const before = '# note\nevents: []\n';
    const result = appendEventToTimeline(before, EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The exception is confined to the marker line; the comment above it is
    // untouched, which is what stops this branch from widening into a rewrite.
    expect(result.text.startsWith('# note\nevents:\n')).toBe(true);
    expect(result.text).not.toContain('events: []');
    expect(eventsOf(result.text)).toHaveLength(1);
  });

  test('an `events:` key with nothing under it is appended to as-is', () => {
    const result = appendEventToTimeline('events:\n', EVENT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(eventsOf(result.text)).toHaveLength(1);
  });
});

describe('appendEventToTimeline — what it refuses', () => {
  test("a file that is not a timeline is REFUSED, not overwritten", () => {
    for (const foreign of ['scenes:\n  - id: s1\n', '- just\n- a\n- list\n', 'events: not-a-list\n', ': : broken']) {
      const result = appendEventToTimeline(foreign, EVENT);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not-a-timeline-file');
      }
    }
  });

  test('and a real timeline file is accepted, so the refusal is not blanket', () => {
    // Without this, an implementation that refuses everything passes the case
    // above — which is the shape this repository keeps paying for.
    const result = appendEventToTimeline('events:\n  - id: a\n    title: A\n', EVENT);
    expect(result.ok).toBe(true);
  });
});

describe('the title is quoted only when leaving it bare would change it', () => {
  const titled = (title: string): string => {
    const result = appendEventToTimeline(undefined, { ...EVENT, title });
    if (!result.ok) {
      throw new Error('expected an append');
    }
    return result.text;
  };

  test('an ordinary title stays bare, and round-trips', () => {
    expect(titled('Иван приезжает')).toContain('title: Иван приезжает');
    expect(eventsOf(titled('Иван приезжает'))[0].title).toBe('Иван приезжает');
  });

  test('titles YAML would otherwise re-read are quoted, and round-trip unchanged', () => {
    // Each of these parses as something OTHER than the string if left bare —
    // a mapping, a boolean, a number, or a value with its spaces eaten.
    for (const title of ['Глава: начало', 'true', '42', '  отступ  ', '- дефис', '#решётка', '', 'финал:']) {
      const text = titled(title);
      expect(eventsOf(text)[0].title).toBe(title);
    }
  });

  test('quotes and backslashes inside a title survive', () => {
    const title = 'Он сказал "нет" \\ ушёл';
    expect(eventsOf(titled(title))[0].title).toBe(title);
  });
});

describe('the default file', () => {
  test('is inside the ONE readable directory under knowledge/', () => {
    // Anything else under `knowledge/` is invisible to the index by design, so
    // a default path outside this directory would write events nothing reads.
    expect(DEFAULT_TIMELINE_FILE.startsWith('knowledge/timeline/')).toBe(true);
    expect(DEFAULT_TIMELINE_FILE.endsWith('.yaml')).toBe(true);
    expect(DEFAULT_TIMELINE_FILE.split('/')).toHaveLength(3);
  });
});
