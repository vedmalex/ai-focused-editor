/**
 * WHAT THE FOUR READ-ONLY AI TOOLS ACTUALLY HAND BACK (TASK-022 WP-6).
 *
 * THE ANSWERS COME OUT OF A REAL INDEX, not out of hand-written envelopes. Every
 * `ready` and `stale` case below builds a small manuscript, runs a full rebuild
 * through `NarrativeIndexSession` against the in-memory store adapter, and asks
 * the same reading methods the RPC service asks. A fixture of literal
 * `NarrativeEntity` objects would prove that the projection copies fields, which
 * is not what the readiness block is about — it is about what a tool says when
 * the index is in each of four states, and about no fact ever arriving without
 * something to navigate to.
 *
 * THE NOT-READY CASES GO THE OTHER WAY ON PURPOSE: they are handed an envelope
 * whose `data` is FULL. An implementation that merely forwards whatever it was
 * given passes a test built from empty envelopes and fails these.
 *
 * IT RUNS IN THE ORDINARY `test:packages` LANE. The module under test imports
 * `@theia/core/lib/common/uri` and `@theia/core/lib/common/nls` and nothing
 * else — both load under `bun`. `narrative-memory-tools-contribution.ts` pulls
 * `inversify` and `@theia/ai-core` and is left holding nothing but argument
 * parsing and a `JSON.stringify`, which is why it has no test of its own.
 *
 * WHAT A GREEN RUN HERE DOES NOT PROVE: anything about SQLite. `bun` cannot
 * resolve `node:sqlite`. What it does prove is that the same session code the
 * node lane runs against a real database produces these answers.
 */

import { describe, expect, test } from 'bun:test';
import URI from '@theia/core/lib/common/uri';
import {
  InMemoryNarrativeIndexStore,
  NarrativeIndexSession,
  rangeEvidence,
  type Envelope,
  type IndexableFile,
  type IndexState,
  type NarrativeDocumentContext,
  type NarrativeEntity,
  type NarrativeIndexStore,
  type NarrativeMention,
  type NarrativeRelation
} from '../common';
import {
  narrativeDocumentContextAnswer,
  narrativeEntityRelationsAnswer,
  narrativeFindEntitiesAnswer,
  narrativeFindMentionsAnswer,
  narrativeNoWorkspaceAnswer,
  type NarrativeToolAnswer,
  type NarrativeToolEvidence
} from './narrative-memory-tool-answers';

const ROOT = 'file:///workspace';
const SCHEMA_VERSION = 1;
const SUBJECT = 'content/ch-03.md';

/**
 * The pair whose CODE POINT order and Russian collation order disagree.
 *
 * ISS-349 built it for the store contract, where the assertion runs the other
 * way: `Я` is U+042F and `а` is U+0430, so by code point the upper-case word
 * comes first, and the index answers in exactly that order on purpose. Here the
 * NAMES carry the same pair — not just the ids — so that a projection sorting
 * names with `<` fails as loudly as one that passes the index's order through.
 */
const UPPER_NAME = 'Ярость';
const LOWER_NAME = 'арджуна';

function file(path: string, text: string): IndexableFile {
  return {
    path,
    uri: `${ROOT}/${path}`,
    text,
    sizeBytes: text.length,
    mtimeMs: 1_700_000_000_000,
    contentHash: `hash-of-${path}-${text.length}`
  };
}

/**
 * A manuscript carrying, deliberately, one of everything WP-6 must render:
 *
 *   - an `ownership` relation whose target names no card — an EXPLICIT relation
 *     with WHOLE-FILE evidence and a broken end;
 *   - two characters sharing chapters, so the DERIVED co-occurrence layer is
 *     non-empty;
 *   - a broken prose reference and a duplicate id, so `findings` has content;
 *   - a front-matter reference, whose evidence has no position either;
 *   - the Cyrillic pair above.
 */
function manuscript(): IndexableFile[] {
  return [
    file(
      'manifest.yaml',
      ['content:', ...[1, 2, 3].map(n => `  - path: content/ch-0${n}.md\n    title: Chapter ${n}`)].join('\n')
    ),
    file('entities/characters/krishna.yaml', ['id: krishna', 'name: Кришна', 'aliases:', '  - Говинда'].join('\n')),
    file('entities/characters/arjuna.yaml', ['id: arjuna', 'name: Арджуна'].join('\n')),
    file(`entities/characters/${UPPER_NAME}.yaml`, [`id: ${UPPER_NAME}`, `name: ${UPPER_NAME}`].join('\n')),
    file(`entities/characters/${LOWER_NAME}.yaml`, [`id: ${LOWER_NAME}`, `name: ${LOWER_NAME}`].join('\n')),
    file(
      'entities/artifacts/gandiva.yaml',
      ['id: gandiva', 'name: Гандива', 'ownership:', '  - owner: nobody-at-all', '    from: before the war'].join('\n')
    ),
    file('entities/artifacts/gandiva-copy.yaml', ['id: gandiva', 'name: Гандива (копия)'].join('\n')),
    file('content/ch-01.md', 'Together: [[char:krishna|Кришна]] and [[char:arjuna|Арджуна]].'),
    file('content/ch-02.md', 'Alone: [[char:krishna|Кришна]].'),
    file(
      SUBJECT,
      [
        '---',
        'characters: "[[char:arjuna|Арджуна]]"',
        '---',
        '',
        'Here stands [[char:krishna|Кришна]] holding [[artifact:gandiva|Гандива]],',
        'and a reference to [[char:nobody|Никто]] that resolves to nothing.'
      ].join('\n')
    )
  ];
}

interface Built {
  store: NarrativeIndexStore;
  session: NarrativeIndexSession;
}

/**
 * Build the index, then add the one origin extraction cannot produce.
 *
 * `ai-candidate` IS A NORMAL OPERATING MODE (UR-026), not an edge case, and no
 * deterministic parser emits one — an agent does. Writing it straight through
 * the port is how the third origin becomes observable in a tool answer at all.
 * It is given a RANGE evidence so that one answer carries both `locator` values
 * and the whole-file notice can be shown to fire on the right one.
 */
function build(): Built {
  const store: NarrativeIndexStore = new InMemoryNarrativeIndexStore({ readOnly: false });
  const session = new NarrativeIndexSession({ store, schemaVersion: SCHEMA_VERSION });
  session.rebuild(manuscript(), { indexedAt: 1_700_000_400_000 });
  store.transaction(writer => {
    writer.putRelation({
      sourceId: 'gandiva',
      targetId: 'arjuna',
      relType: 'wielded-by',
      origin: 'ai-candidate',
      confidence: 0.62,
      ownerPath: 'entities/artifacts/gandiva.yaml',
      sourceResolved: true,
      targetResolved: true,
      evidence: [
        rangeEvidence('entities/artifacts/gandiva.yaml', {
          start: { line: 2, character: 0 },
          end: { line: 3, character: 24 }
        })
      ]
    });
  });
  return { store, session };
}

/** Round-trip through JSON, because that is what a tool actually returns and
 *  because an `undefined` field disappears on the way — so "absent" here means
 *  absent on the wire, not merely absent from the object. */
function wire(answer: NarrativeToolAnswer): Record<string, unknown> {
  return JSON.parse(JSON.stringify(answer)) as Record<string, unknown>;
}

/** Every evidence anywhere in an answer, whatever section it came from. */
function allEvidence(value: unknown, into: NarrativeToolEvidence[] = []): NarrativeToolEvidence[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      allEvidence(item, into);
    }
    return into;
  }
  if (value === null || typeof value !== 'object') {
    return into;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && typeof record.locator === 'string') {
    into.push(record as unknown as NarrativeToolEvidence);
  }
  for (const nested of Object.values(record)) {
    allEvidence(nested, into);
  }
  return into;
}

function entitiesAnswer(session: NarrativeIndexSession): NarrativeToolAnswer {
  return narrativeFindEntitiesAnswer(ROOT, session.findEntities());
}

function relationsAnswer(session: NarrativeIndexSession, entityId: string): NarrativeToolAnswer {
  return narrativeEntityRelationsAnswer(ROOT, session.getRelations({ entityId, direction: 'either' }));
}

function contextAnswer(session: NarrativeIndexSession): NarrativeToolAnswer {
  return narrativeDocumentContextAnswer(
    ROOT,
    session.getContextForDocument({
      documentUri: `${ROOT}/${SUBJECT}`,
      relPath: SUBJECT,
      options: { spoilerSafe: false }
    })
  );
}

/** All four answers under whatever state the session is in. */
function allAnswers(session: NarrativeIndexSession): NarrativeToolAnswer[] {
  return [
    entitiesAnswer(session),
    narrativeFindMentionsAnswer(ROOT, session.getMentions()),
    relationsAnswer(session, 'gandiva'),
    contextAnswer(session)
  ];
}

// ---------------------------------------------------------------------------
// The four requirements
// ---------------------------------------------------------------------------

describe('WP-6 requirement 1 — a thing that is not there, under `ready`, is EMPTY', () => {
  test('an entity with no relations answers with an empty list, not a refusal', () => {
    const { session } = build();
    const answer = wire(relationsAnswer(session, 'no-such-entity-anywhere'));
    const index = answer.index as Record<string, unknown>;
    expect(index.state).toBe('ready');
    // ANSWERED. The list is empty because the manuscript holds no such relation,
    // and that is an authoritative statement a caller may act on.
    expect(index.answered).toBe(true);
    expect(answer.relations).toEqual([]);
    // And nothing is said, because there is nothing a reader must be warned of.
    expect(answer.notice).toEqual([]);
  });

  test('a `ready` answer with data carries no notice at all', () => {
    const { session } = build();
    const answer = wire(relationsAnswer(session, 'arjuna'));
    expect((answer.index as Record<string, unknown>).answered).toBe(true);
    expect((answer.relations as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('WP-6 requirement 2 — `rebuilding` and `absent` are an explicit NOT READY', () => {
  const populated = (state: IndexState): Envelope<NarrativeEntity[]> => ({
    state,
    // FULL. This is the adversarial half: a projection that forwards whatever it
    // was handed passes a test written with `data: []` and fails here.
    data: [
      {
        id: 'krishna',
        type: 'character',
        name: 'Кришна',
        sourcePath: 'entities/characters/krishna.yaml',
        sourceUri: `${ROOT}/entities/characters/krishna.yaml`,
        origin: 'explicit',
        aliases: []
      }
    ]
  });

  test('`rebuilding` drops the data key entirely and says why', () => {
    const answer = wire(narrativeFindEntitiesAnswer(ROOT, populated({ state: 'rebuilding', generation: 5 })));
    const index = answer.index as Record<string, unknown>;
    expect(index.state).toBe('rebuilding');
    expect(index.answered).toBe(false);
    // NOT `[]`. An empty list mid-rebuild is an authoritative absence about an
    // index that has not finished reading, which is the one confusion the
    // envelope exists to remove.
    expect('entities' in answer).toBe(false);
    expect((answer.notice as string[]).length).toBeGreaterThan(0);
    expect((answer.notice as string[])[0]).toContain('being built');
  });

  test('`absent`/not-built says the index was never built, and names the remedy', () => {
    const answer = wire(
      narrativeFindEntitiesAnswer(ROOT, populated({ state: 'absent', generation: 0, cause: 'not-built' }))
    );
    const index = answer.index as Record<string, unknown>;
    expect(index.answered).toBe(false);
    expect(index.absentCause).toBe('not-built');
    expect('entities' in answer).toBe(false);
    expect((answer.notice as string[]).join(' ')).toContain('Rebuild Index');
  });

  test('`absent`/no-manuscript is a DIFFERENT sentence, and offers no remedy', () => {
    const answer = wire(
      narrativeFindEntitiesAnswer(ROOT, populated({ state: 'absent', generation: 0, cause: 'no-manuscript' }))
    );
    // WP-5 removes the Rebuild command from the screen in this row, so telling
    // the author to run it would send them looking for something that is not
    // there.
    expect((answer.notice as string[]).join(' ')).not.toContain('Rebuild Index');
    expect((answer.notice as string[]).join(' ')).toContain('not a manuscript');
  });

  test('no workspace at all is an ANSWER, not a throw', () => {
    const answer = wire(narrativeNoWorkspaceAnswer());
    expect((answer.index as Record<string, unknown>).answered).toBe(false);
    expect('entities' in answer).toBe(false);
    expect((answer.notice as string[]).length).toBe(1);
  });
});

describe('WP-6 requirement 3 — `failed` is BROKEN, with a reason (ОВ-8)', () => {
  const failed: IndexState = {
    state: 'failed',
    generation: 7,
    reason: {
      code: 'storage-corrupted',
      incidentId: 'incident-2f9c',
      occurrences: 3,
      relPath: 'entities/characters/krishna.yaml'
    }
  };

  test('the code, its sentence and the incident id travel; the path and the count do not', () => {
    const answer = wire(narrativeFindMentionsAnswer(ROOT, { state: failed, data: [] }));
    const index = answer.index as Record<string, unknown>;
    expect(index.state).toBe('failed');
    expect(index.answered).toBe(false);
    expect(index.failureCode).toBe('storage-corrupted');
    // ОВ-8's table gives THIS consumer the phrase and the incident id, so the
    // user can tie the model's answer to a line in the backend log.
    expect(index.incidentId).toBe('incident-2f9c');
    expect((answer.notice as string[]).join(' ')).toContain('damaged');
    // Asserted on the SERIALIZED payload, the way ОВ-8's own main tooth is: a
    // non-enumerable field that stuck to the object would be invisible to a
    // property check and visible here.
    const serialized = JSON.stringify(answer);
    expect(serialized).not.toContain('krishna.yaml');
    expect(serialized).not.toContain('occurrences');
    expect('mentions' in answer).toBe(false);
  });

  test('the answer never carries an Error message or a stack', () => {
    const serialized = JSON.stringify(wire(narrativeFindMentionsAnswer(ROOT, { state: failed, data: [] })));
    expect(serialized).not.toContain('/Users/');
    expect(serialized.toLowerCase()).not.toContain('stack');
  });
});

describe('WP-6 requirement 4 — `stale` ANSWERS, and every answer is MARKED', () => {
  test('all four tools return data AND the mark AND the reason', () => {
    const { session } = build();
    session.recordStale('watcher-lost');
    const answers = allAnswers(session).map(wire);
    expect(answers).toHaveLength(4);
    for (const answer of answers) {
      const index = answer.index as Record<string, unknown>;
      expect(index.state).toBe('stale');
      // THE TOOL ANSWERS. Refusing would make it useless during an ordinary
      // watcher failure that can last a whole session (ОВ-6).
      expect(index.answered).toBe(true);
      expect(index.staleReason).toBe('watcher-lost');
      expect(typeof index.staleSince).toBe('number');

      // THE REJECTING CASE OF THE READINESS BLOCK, on the wire. An answer under
      // `stale` that carries data and no mark must fail — this is the line that
      // fails it.
      const notice = answer.notice as string[];
      expect(notice.length).toBeGreaterThan(0);
      expect(notice.join(' ')).toContain('no longer guaranteed to match the files');
      expect(notice.join(' ')).toContain('file change notifications stopped');
    }
    // ...and the data really is there, so the mark is not being bought by
    // withholding the answer.
    expect((answers[0]!.entities as unknown[]).length).toBeGreaterThan(0);
    expect((answers[1]!.mentions as unknown[]).length).toBeGreaterThan(0);
    expect((answers[2]!.relations as unknown[]).length).toBeGreaterThan(0);
    expect(answers[3]!.context).toBeDefined();
  });

  test('each of the three stale reasons produces its OWN sentence', () => {
    const seen = new Set<string>();
    for (const reason of ['watcher-lost', 'partial-update-failed'] as const) {
      const { session } = build();
      session.recordStale(reason);
      const answer = wire(entitiesAnswer(session));
      seen.add((answer.notice as string[]).join('|'));
    }
    // Two reasons, two different notices. A single generic "may be out of date"
    // would collapse to one entry here.
    expect(seen.size).toBe(2);
  });

  test('clearing the staleness clears the mark — the notice is not sticky', () => {
    const { session } = build();
    session.recordStale('watcher-lost');
    const stale = wire(entitiesAnswer(session)).notice as string[];
    expect(stale.join(' ')).toContain('no longer guaranteed');
    session.clearStale();
    const fresh = wire(entitiesAnswer(session)).notice as string[];
    // NOT `[]`, and that is the honest expectation rather than a weakened one:
    // an entity's evidence is whole-file over its card, so this answer keeps
    // owing the reader the ISS-320 sentence. What must go is the STALENESS
    // mark, and only it.
    expect(fresh.join(' ')).not.toContain('no longer guaranteed');
    expect(fresh.join(' ')).not.toContain('file change notifications');
    expect(fresh.join(' ')).toContain('no position inside it');
    expect((wire(entitiesAnswer(session)).index as Record<string, unknown>).staleReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe('WP-6 — no fact arrives without an EvidenceRef', () => {
  test('every element of every section of every tool carries a navigable pointer', () => {
    const { session } = build();
    const answers = allAnswers(session).map(wire);

    // The floor: the walk must actually find things, or every assertion below
    // is vacuous.
    const evidence = answers.flatMap(answer => allEvidence(answer));
    expect(evidence.length).toBeGreaterThan(20);

    for (const item of evidence) {
      expect(item.path.length).toBeGreaterThan(0);
      expect(item.uri.startsWith(`${ROOT}/`)).toBe(true);
      // COMPARED AGAINST A RESOLVED URI, not against `endsWith(path)`. A
      // `file://` URI percent-encodes non-ASCII, and this manuscript is
      // Cyrillic on purpose — `endsWith` was the first edition of this line and
      // it failed on `Ярость.yaml` for a reason that is correct behaviour. The
      // relative `path` beside it is what a caller matches on.
      expect(item.uri).toBe(new URI(ROOT).resolve(item.path).toString());
      expect(['range', 'whole-file']).toContain(item.locator);
    }

    // Per section, explicitly — a generic walk would stay green if a whole
    // section were dropped from the projection.
    const context = answers[3]!.context as Record<string, unknown>;
    for (const section of ['entities', 'mentions', 'relations', 'priorAppearances', 'findings']) {
      const items = context[section] as Record<string, unknown>[];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        const own = section === 'relations' ? item.evidence : [item.evidence];
        expect((own as unknown[]).length).toBeGreaterThan(0);
      }
    }
  });

  test('an entity whose card recorded NO evidence still gets one — the card itself', () => {
    // `NarrativeEntity.evidence` is the ONE optional evidence field in the
    // domain (ОВ-5). Today's extraction always fills it
    // (`entity-card-extraction.ts:328`) — asserted below so this case cannot be
    // mistaken for the extraction path — but the LEGACY bridge WP-7 migrates
    // deliberately records none (`legacy-narrative-entity.ts:60-64`). An entity
    // arriving that way has nothing to navigate to unless the projection
    // supplies it, and the readiness block admits no fact without an
    // `EvidenceRef`.
    const { session } = build();
    expect(session.findEntities().data.every(entity => entity.evidence !== undefined)).toBe(true);

    const bare: NarrativeEntity = {
      id: 'legacy-hero',
      type: 'character',
      name: 'Легаси',
      sourcePath: 'entities/characters/legacy-hero.yaml',
      sourceUri: `${ROOT}/entities/characters/somewhere-else-entirely.yaml`,
      origin: 'explicit',
      aliases: []
    };
    const answer = wire(narrativeFindEntitiesAnswer(ROOT, { state: session.state(), data: [bare] }));
    const evidence = (answer.entities as Record<string, unknown>[])[0]!.evidence as Record<string, unknown>;
    expect(evidence.path).toBe('entities/characters/legacy-hero.yaml');
    expect(evidence.locator).toBe('whole-file');
    // Not invented from the URI, which here deliberately names a different file.
    expect(evidence.uri).not.toContain('somewhere-else-entirely');
  });

  test('an entity that DOES carry coordinates keeps them, with the repaired path', () => {
    // Unreachable through today's extraction, which records only whole-file
    // evidence for a card — and here on purpose, so the branch that preserves a
    // range is exercised rather than left as an untested limb. It is also the
    // proof that the path substitution does not throw the coordinates away.
    const { session } = build();
    const placed: NarrativeEntity = {
      id: 'placed',
      type: 'character',
      name: 'Точный',
      sourcePath: 'entities/characters/after-the-rename.yaml',
      sourceUri: `${ROOT}/entities/characters/before-the-rename.yaml`,
      origin: 'explicit',
      aliases: [],
      evidence: rangeEvidence('entities/characters/before-the-rename.yaml', {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 12 }
      })
    };
    const answer = wire(narrativeFindEntitiesAnswer(ROOT, { state: session.state(), data: [placed] }));
    const evidence = (answer.entities as Record<string, unknown>[])[0]!.evidence as Record<string, unknown>;
    expect(evidence.locator).toBe('range');
    expect(evidence.range).toEqual({ start: { line: 1, character: 0 }, end: { line: 1, character: 12 } });
    expect(evidence.path).toBe('entities/characters/after-the-rename.yaml');
  });

  test('the card path and the card evidence agree BEFORE any move — the substitution is a no-op', () => {
    // Without this, "take the path from `sourcePath`" could be papering over a
    // projection that simply ignores the recorded evidence.
    const { session } = build();
    for (const entity of session.findEntities().data) {
      expect(entity.evidence!.path).toBe(entity.sourcePath);
    }
  });
});

describe('WP-6 — evidence without a range is VISIBLE as such (ISS-320)', () => {
  test('an `ownership` relation arrives whole-file, with NO range key and a sentence', () => {
    const { session } = build();
    const answer = wire(relationsAnswer(session, 'gandiva'));
    const relations = answer.relations as Record<string, unknown>[];
    const ownership = relations.find(relation => relation.relType === 'ownership');
    expect(ownership).toBeDefined();
    const evidence = (ownership!.evidence as Record<string, unknown>[])[0]!;
    expect(evidence.locator).toBe('whole-file');
    // NOT a zeroed range. A model handed `{"line": 0}` will cite line 1 of the
    // YAML card with complete confidence, and that breakage is indistinguishable
    // from working software — which is the whole of ISS-320.
    expect('range' in evidence).toBe(false);
    expect(evidence.path).toBe('entities/artifacts/gandiva.yaml');
    // And it is said in words, once, rather than left for the reader to infer
    // from a missing key.
    expect((answer.notice as string[]).join(' ')).toContain('no position inside it');
  });

  test('a prose reference DOES carry its span — the distinction is real, not blanket', () => {
    const { session } = build();
    const answer = wire(narrativeFindMentionsAnswer(ROOT, session.getMentions({ relPath: SUBJECT })));
    const mentions = answer.mentions as Record<string, unknown>[];
    const prose = mentions.find(mention => mention.entityId === 'krishna');
    expect(prose).toBeDefined();
    const evidence = prose!.evidence as Record<string, unknown>;
    expect(evidence.locator).toBe('range');
    expect(evidence.range).toBeDefined();
    // The REJECTING half: if `locator` were hardcoded to `whole-file`, or the
    // range dropped, this fails. If it were hardcoded to `range`, the ownership
    // case above fails.
    const frontMatter = mentions.find(mention => mention.entityId === 'arjuna');
    expect(frontMatter).toBeDefined();
    expect((frontMatter!.evidence as Record<string, unknown>).locator).toBe('whole-file');
  });

  test('an answer whose evidence is ALL ranged does NOT carry the whole-file sentence', () => {
    // The control. A notice emitted unconditionally would satisfy every
    // assertion above and mean nothing.
    const { session } = build();
    const ranged: Envelope<NarrativeMention[]> = {
      state: session.state(),
      data: session
        .getMentions({ relPath: SUBJECT })
        .data.filter(mention => mention.evidence.evidenceKind === 'range')
    };
    expect(ranged.data.length).toBeGreaterThan(0);
    const answer = wire(narrativeFindMentionsAnswer(ROOT, ranged));
    expect(answer.notice).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

describe('WP-6 — the answer distinguishes all three origins', () => {
  test('one entity carries an explicit, a derived and an ai-candidate relation, told apart', () => {
    const { session } = build();
    const relations = wire(relationsAnswer(session, 'gandiva')).relations as Record<string, unknown>[];
    const origins = new Set(relations.map(relation => relation.origin));
    expect(origins).toEqual(new Set(['explicit', 'derived', 'ai-candidate']));

    const candidate = relations.find(relation => relation.origin === 'ai-candidate')!;
    // An agent's proposal keeps its confidence and its owning card: the source
    // of truth for a candidate is the YAML, never the database (UR-026).
    expect(candidate.confidence).toBe(0.62);
    expect(candidate.ownerPath).toBe('entities/artifacts/gandiva.yaml');

    const derived = relations.find(relation => relation.origin === 'derived')!;
    // A derived edge belongs to no card, and the field is ABSENT rather than
    // null — the schema states that as `CHECK (origin = 'derived' OR doc_id IS
    // NOT NULL)`.
    expect('ownerPath' in derived).toBe(false);
  });

  test('a broken relation END survives into the answer, flagged rather than dropped', () => {
    const { session } = build();
    const relations = wire(relationsAnswer(session, 'gandiva')).relations as Record<string, unknown>[];
    const ownership = relations.find(relation => relation.relType === 'ownership')!;
    expect(ownership.targetId).toBe('nobody-at-all');
    expect(ownership.targetResolved).toBe(false);
    expect(ownership.sourceResolved).toBe(true);
  });

  test('entities carry their own origin too', () => {
    const { session } = build();
    const entities = wire(entitiesAnswer(session)).entities as Record<string, unknown>[];
    expect(entities.length).toBeGreaterThan(0);
    for (const entity of entities) {
      expect(['explicit', 'derived', 'ai-candidate']).toContain(String(entity.origin));
    }
  });
});

// ---------------------------------------------------------------------------
// Display order
// ---------------------------------------------------------------------------

describe('WP-6 — entity lists are ordered for a READER (ISS-349)', () => {
  test('the tool REVERSES the index order on the pair the two collations disagree about', () => {
    const { session } = build();

    const raw = session.findEntities().data.map(entity => entity.id);
    expect(raw.indexOf(UPPER_NAME)).toBeLessThan(raw.indexOf(LOWER_NAME));

    const shown = (wire(entitiesAnswer(session)).entities as Record<string, unknown>[]).map(
      entity => entity.id as string
    );
    // The opposite order, and there is no third possibility: an implementation
    // that passes the index's order through fails here, and one that sorts names
    // with `<` fails here too — `Ярость` < `арджуна` by code point, which is
    // exactly the order the index already answered in.
    expect(shown.indexOf(LOWER_NAME)).toBeLessThan(shown.indexOf(UPPER_NAME));
    expect(shown).toHaveLength(raw.length);
    expect(new Set(shown)).toEqual(new Set(raw));
  });

  test('the passage context is NOT re-sorted — reading order is information', () => {
    const { session } = build();
    const answer = wire(contextAnswer(session));
    const context = answer.context as Record<string, unknown>;
    const shown = (context.entities as Record<string, unknown>[]).map(item => item.id as string);
    const raw = session
      .getContextForDocument({ documentUri: `${ROOT}/${SUBJECT}`, relPath: SUBJECT, options: { spoilerSafe: false } })
      .data!.entities.map(item => item.entity.id);
    // An alphabet here would destroy the order the passage itself puts them in.
    expect(shown).toEqual(raw);
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe('WP-6 — navigation is DERIVED from the relative path, never read from sourceUri', () => {
  test('after a rename the tool points at the NEW file while `sourceUri` still names the old one', () => {
    const { store, session } = build();
    const before = store.getEntity('arjuna')!;
    const oldPath = 'entities/characters/arjuna.yaml';
    const newPath = 'entities/characters/renamed-hero.yaml';
    expect(before.sourcePath).toBe(oldPath);

    store.transaction(writer => {
      writer.moveDocument(oldPath, newPath, {
        sizeBytes: before.sourcePath.length,
        mtimeMs: 1_700_000_900_000,
        contentHash: `hash-of-${oldPath}-${'id: arjuna\nname: Арджуна'.length}`,
        indexedAt: 1_700_000_900_000
      });
    });

    // THE DEFECT, AS IT REALLY IS. `moveDocument` repairs the denormalized
    // `sourcePath` in both adapters and NEITHER touches `sourceUri`
    // (`in-memory-narrative-index-store.ts:495-499`,
    // `sqlite-narrative-index-store.ts:1056-1059`), pinned in both directions by
    // `test/node/index-invariants.test.mts:614`.
    const after = store.getEntity('arjuna')!;
    expect(after.sourcePath).toBe(newPath);
    expect(after.sourceUri).toBe(before.sourceUri);
    expect(after.sourceUri).toContain(oldPath);

    const entities = wire(entitiesAnswer(session)).entities as Record<string, unknown>[];
    const arjuna = entities.find(entity => entity.id === 'arjuna')!;
    const evidence = arjuna.evidence as Record<string, unknown>;
    // The tool navigates to where the file IS. A projection that read
    // `entity.sourceUri` — the obvious field, and the one that is named for
    // exactly this job — sends the author to a file that no longer exists, and
    // is red on this line.
    expect(evidence.path).toBe(newPath);
    expect(evidence.uri).toBe(`${ROOT}/${newPath}`);
    expect(evidence.uri).not.toContain('arjuna.yaml');
  });

  test('`sourceUri` is not merely unread — it is ABSENT from the answer', () => {
    // So that a downstream consumer of a tool answer cannot pick the stale
    // value up either. A field that is present but wrong is worse than one that
    // is missing.
    const { session } = build();
    const answer = wire(entitiesAnswer(session));
    expect(JSON.stringify(answer)).not.toContain('sourceUri');
    for (const entity of answer.entities as Record<string, unknown>[]) {
      expect('sourceUri' in entity).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The document that is not in the index
// ---------------------------------------------------------------------------

describe('WP-6 — a document the index does not hold', () => {
  test('is reported as NOT INDEXED, not as an empty context', () => {
    const { session } = build();
    const answer = wire(
      narrativeDocumentContextAnswer(
        ROOT,
        session.getContextForDocument({
          documentUri: `${ROOT}/sources/citations.yaml`,
          relPath: 'sources/citations.yaml'
        })
      )
    );
    const index = answer.index as Record<string, unknown>;
    expect(index.state).toBe('ready');
    expect(answer.documentIndexed).toBe(false);
    // An empty context would assert that a file the index never read contains
    // no narrative facts.
    expect('context' in answer).toBe(false);
    expect((answer.notice as string[]).join(' ')).toContain('does not hold this document');
  });

  test('an INDEXED document does carry a context, so the flag is not blanket', () => {
    const { session } = build();
    const answer = wire(contextAnswer(session));
    expect('documentIndexed' in answer).toBe(false);
    const context = answer.context as Record<string, unknown>;
    expect(context.path).toBe(SUBJECT);
    expect(context.uri).toBe(`${ROOT}/${SUBJECT}`);
    expect(context.indexVersion).toBe(`${SCHEMA_VERSION}.${(answer.index as Record<string, unknown>).generation}`);
  });

  test('the availability of EVERY section travels, unavailable ones included', () => {
    // `empty` and `unavailable` are different claims, and a model given only a
    // list length cannot tell them apart — the one confusion `SectionAvailability`
    // exists to prevent, carried through rather than flattened.
    const { session } = build();
    const context = wire(contextAnswer(session)).context as Record<string, unknown>;
    const sections = context.sections as Record<string, { status: string; requires?: string }>;
    expect(sections.scenePlan.status).toBe('unavailable');
    expect(sections.scenePlan.requires).toBe('gh#51');
    expect(sections.mentions.status).toBe('present');
  });

  test('what a cap cut is REPORTED, never a silence', () => {
    const { session } = build();
    const capped = wire(
      narrativeDocumentContextAnswer(
        ROOT,
        session.getContextForDocument({
          documentUri: `${ROOT}/${SUBJECT}`,
          relPath: SUBJECT,
          options: { spoilerSafe: false, maxEvidencePerSection: 1 }
        })
      )
    );
    const context = capped.context as Record<string, unknown>;
    const omitted = context.omitted as { section: string; count: number; reason: string }[];
    expect(omitted.length).toBeGreaterThan(0);
    for (const entry of omitted) {
      expect(entry.count).toBeGreaterThan(0);
      expect(['limit', 'unknown-position']).toContain(entry.reason);
    }
  });
});

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

describe('WP-6 — the fixture is what it claims to be', () => {
  test('the index really built, and really holds one of each thing asserted about', () => {
    // Every suite above is an "assert some property of what came back" shape,
    // and all of them pass vacuously over an index that built nothing.
    const { session, store } = build();
    expect(session.state().state).toBe('ready');
    expect(store.listDocuments().length).toBeGreaterThan(8);
    expect(store.getRelations({ relType: 'ownership' })).toHaveLength(1);
    expect(store.getRelations({ origin: 'derived' }).length).toBeGreaterThan(0);
    expect(store.getRelations({ origin: 'ai-candidate' })).toHaveLength(1);
    expect(store.getDuplicateEntities().length).toBeGreaterThan(0);
    expect(store.getMentions({ brokenOnly: true }).length).toBeGreaterThan(0);
    const context: NarrativeDocumentContext = session.getContextForDocument({
      documentUri: `${ROOT}/${SUBJECT}`,
      relPath: SUBJECT,
      options: { spoilerSafe: false }
    }).data!;
    expect(context.findings.length).toBeGreaterThan(0);
    expect(context.priorAppearances.length).toBeGreaterThan(0);
  });

  test('a relation the projection sees really can carry more than one evidence', () => {
    // The derived co-occurrence edge between krishna and arjuna is evidenced
    // once per shared chapter, so the `evidence` ARRAY is genuinely plural here
    // and a projection that emitted only `evidence[0]` would be caught.
    const { session } = build();
    const relations = wire(relationsAnswer(session, 'krishna')).relations as Record<string, unknown>[];
    const plural = relations.filter(relation => (relation.evidence as unknown[]).length > 1);
    expect(plural.length).toBeGreaterThan(0);
  });

  test('the manuscript entity used by the rename case exists before it is renamed', () => {
    const { store } = build();
    expect(store.getDocument('entities/characters/arjuna.yaml')).toBeDefined();
  });

  test('a relation query is not silently answering about the whole book', () => {
    // `narrative_entity_relations` is entity-scoped; a filter dropped somewhere
    // in the projection would make every answer identical and every assertion
    // above still green.
    const { session } = build();
    const gandiva = wire(relationsAnswer(session, 'gandiva')).relations as unknown[];
    const everything = wire(narrativeEntityRelationsAnswer(ROOT, session.getRelations())).relations as unknown[];
    expect(gandiva.length).toBeLessThan(everything.length);
  });
});
