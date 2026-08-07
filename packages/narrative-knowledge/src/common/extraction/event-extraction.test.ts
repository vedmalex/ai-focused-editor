import { describe, expect, test } from 'bun:test';
import { extractEvents } from './event-extraction';
import { EVENT_TIME_KINDS } from '../graph';

const PATH = 'knowledge/timeline/main.yaml';
const KNOWN = (ids: string[]) => (id: string) => ids.includes(id);

function read(body: string, known: string[] = []) {
  return extractEvents({ path: PATH, text: body }, KNOWN(known));
}

describe('extractEvents — the four time kinds are all first-class', () => {
  test('exact: the value is kept verbatim AND parsed, and the parse is only a diagnostic aid', () => {
    const { events, problems } = read(
      ['events:', '  - id: e1', '    title: Прибытие', '    story_time:', '      kind: exact', '      value: 2026-05-04T10:00:00Z'].join('\n')
    );
    expect(problems).toEqual([]);
    expect(events[0].storyTime.kind).toBe('exact');
    expect(events[0].storyTime.value).toBe('2026-05-04T10:00:00Z');
    expect(typeof events[0].storyTime.parsedMs).toBe('number');
  });

  test('relative: a phrase is NOT a defect', () => {
    // The case this whole design exists for. `ownership.from`/`to` taught the
    // project that story-time labels are freeform; an extractor that reported
    // "three winters later" as an unparsable date would make the commonest way
    // authors write time into an error.
    const { events, problems } = read(
      ['events:', '  - id: e1', '    title: Позже', '    story_time:', '      kind: relative', '      value: три зимы спустя'].join('\n')
    );
    expect(problems).toEqual([]);
    expect(events[0].storyTime.value).toBe('три зимы спустя');
    expect(events[0].storyTime.parsedMs).toBeUndefined();
  });

  test('sequence-only: an event ordered but not dated is complete', () => {
    const { events, problems } = read(
      ['events:', '  - id: e1', '    title: Без даты', '    sequence: 120', '    story_time:', '      kind: sequence'].join('\n')
    );
    expect(problems).toEqual([]);
    expect(events[0].sequence).toBe(120);
    expect(events[0].storyTime.kind).toBe('sequence');
  });

  test('unknown: an absent story_time is `unknown`, not a problem', () => {
    // An author who knows an event happened and not when has said something
    // true. Demanding the key would push them into inventing a time.
    const { events, problems } = read(['events:', '  - id: e1', '    title: Когда-то'].join('\n'));
    expect(problems).toEqual([]);
    expect(events[0].storyTime.kind).toBe('unknown');
  });

  test('a MISSPELLED kind is a problem — silence would hide the typo', () => {
    const { events, problems } = read(
      ['events:', '  - id: e1', '    title: X', '    story_time:', '      kind: exakt', '      value: 2026-05-04'].join('\n')
    );
    expect(problems.map(p => p.kind)).toContain('unknown-time-kind');
    // And the event survives: the author still wrote it down.
    expect(events).toHaveLength(1);
  });

  test('`exact` with an unparsable value is reported, and ONLY `exact` can fail this way', () => {
    const bad = read(
      ['events:', '  - id: e1', '    title: X', '    story_time:', '      kind: exact', '      value: как-нибудь весной'].join('\n')
    );
    expect(bad.problems.map(p => p.kind)).toContain('exact-time-unparsable');
    // PAIRED NEGATIVE: the same value under `relative` is not a defect. Without
    // this twin an extractor that flagged every unparsable value would pass.
    const good = read(
      ['events:', '  - id: e1', '    title: X', '    story_time:', '      kind: relative', '      value: как-нибудь весной'].join('\n')
    );
    expect(good.problems).toEqual([]);
  });

  test('the closed union and its data twin agree', () => {
    expect([...EVENT_TIME_KINDS].sort()).toEqual(['exact', 'relative', 'sequence', 'unknown']);
  });
});

describe('extractEvents — references are recorded, never invented', () => {
  const body = [
    'events:',
    '  - id: e1',
    '    title: Прибытие',
    '    participants:',
    '      - char:ivan',
    '      - char:nobody',
    '    location: location:moscow',
    '    plot_threads:',
    '      - thread:return-home'
  ].join('\n');

  test('an unresolved reference is KEPT with the flag, not dropped', () => {
    const { events } = read(body, ['ivan', 'moscow', 'return-home']);
    const refs = events[0].refs;
    const nobody = refs.find(ref => ref.entityId === 'nobody');
    expect(nobody).toBeDefined();
    expect(nobody?.resolved).toBe(false);
    // PAIRED POSITIVE: a reference that DOES resolve is marked so. Without it,
    // an extractor that reported everything unresolved would pass above.
    expect(refs.find(ref => ref.entityId === 'ivan')?.resolved).toBe(true);
  });

  test('roles come from the field the reference was written in', () => {
    const { events } = read(body, ['ivan', 'moscow', 'return-home']);
    const byId = new Map(events[0].refs.map(ref => [ref.entityId, ref.role]));
    expect(byId.get('ivan')).toBe('participant');
    expect(byId.get('moscow')).toBe('location');
    expect(byId.get('return-home')).toBe('thread');
  });

  test('a bare id with no kind prefix is legal', () => {
    // Every other surface in this package accepts the bare form; events being
    // the one place that rejects it would be a disagreement, not a rule.
    const { events } = read(['events:', '  - id: e1', '    title: X', '    participants:', '      - ivan'].join('\n'), ['ivan']);
    expect(events[0].refs[0].entityId).toBe('ivan');
    expect(events[0].refs[0].kind).toBeUndefined();
    expect(events[0].refs[0].resolved).toBe(true);
  });
});

describe('extractEvents — nothing is dropped silently', () => {
  test('a duplicate id is reported AND both events survive', () => {
    const { events, problems } = read(
      ['events:', '  - id: e1', '    title: Первое', '  - id: e1', '    title: Второе'].join('\n')
    );
    expect(problems.some(p => p.message.includes('more than once'))).toBe(true);
    // Folding them would lose an author's work to a typo. Which one wins is the
    // store's question about identity, not this reader's.
    expect(events).toHaveLength(2);
    expect(events.map(e => e.title)).toEqual(['Первое', 'Второе']);
  });

  test('an event with no id cannot be built, and says so', () => {
    const { events, problems } = read(['events:', '  - title: Безымянное'].join('\n'));
    expect(events).toEqual([]);
    expect(problems.map(p => p.kind)).toEqual(['missing-id']);
  });

  test('a missing title is a problem, and the event still exists', () => {
    const { events, problems } = read(['events:', '  - id: e1'].join('\n'));
    expect(problems.map(p => p.kind)).toContain('missing-title');
    expect(events).toHaveLength(1);
  });

  test('a non-numeric sequence is reported, and the event keeps no sequence at all', () => {
    const { events, problems } = read(['events:', '  - id: e1', '    title: X', '    sequence: позже'].join('\n'));
    expect(problems.map(p => p.kind)).toContain('invalid-sequence');
    // NOT coerced to 0: a coerced order would place the event confidently and
    // wrongly, which is worse than leaving it unplaced.
    expect(events[0].sequence).toBeUndefined();
  });

  test('a file that is not a mapping with `events:` is malformed, not empty', () => {
    const { events, problems } = read('просто строка');
    expect(events).toEqual([]);
    expect(problems.map(p => p.kind)).toEqual(['malformed']);
  });

  test('unparsable YAML is malformed, not a crash', () => {
    const { problems } = read('events:\n  - id: [unclosed');
    expect(problems.map(p => p.kind)).toEqual(['malformed']);
  });
});

describe('extractEvents — evidence is honest about precision', () => {
  test('a source_ref with lines becomes a range; one without becomes whole-file', () => {
    const { events } = read(
      [
        'events:',
        '  - id: e1',
        '    title: X',
        '    source_refs:',
        '      - uri: content/ch-04.md',
        '        startLine: 24',
        '        endLine: 31',
        '      - uri: content/ch-05.md'
      ].join('\n')
    );
    const refs = events[0].sourceRefs;
    expect(refs[0].evidenceKind).toBe('range');
    expect(refs[0].range?.start.line).toBe(24);
    // Manufacturing `line: 0` here would make a weaker claim look identical to a
    // precise one, and consumers position the cursor on the strength of it.
    expect(refs[1].evidenceKind).toBe('whole-file');
    expect(refs[1].range).toBeUndefined();
  });

  test('the event itself is evidenced by the timeline file it was read from', () => {
    const { events } = read(['events:', '  - id: e1', '    title: X'].join('\n'));
    expect(events[0].evidence.path).toBe(PATH);
  });
});
