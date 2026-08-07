/**
 * The domain contracts of TASK-022 WP-1, held to their fixtures.
 *
 * HOW THE REJECTING CASES WORK HERE. The readiness block does not ask for
 * "a fixture that fails"; it asks, repeatedly, for a case of the form "a schema
 * that required X MUST fail this test". So each such case PERTURBS the schema —
 * compiles the variant the contract forbids — and asserts that the SAME fixture
 * the real schema accepts is REJECTED by the variant. That is what proves the
 * fixture is discriminating rather than merely passing: a contract nobody could
 * violate is a contract nobody is keeping.
 *
 * `useDefaults` MUTATES the value it validates, so every fixture is cloned
 * before use. Sharing one would let an earlier test's default leak into a later
 * test's "this field was absent" claim.
 */

import { describe, expect, test } from 'bun:test';
import Ajv from 'ajv';
import {
  EVIDENCE_KINDS,
  NARRATIVE_ORIGINS,
  graphEdgeKey,
  isRelationBroken,
  type EvidenceRef,
  type NarrativeEntity,
  type NarrativeMention,
  type NarrativeRelation
} from './graph';
import { INDEX_ABSENT_CAUSES, INDEX_STALE_REASONS, type IndexState } from './index-state';
import { INDEX_FAILURE_CODES, type IndexFailureReason } from './index-failure';
import { NarrativeSchemaValidator, narrativeSchemaFor, type NarrativeSchemaKind } from './narrative-schema';

const validator = new NarrativeSchemaValidator();

/** Deep clone, so `useDefaults` cannot leak between cases. */
function fresh<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function accepts(kind: NarrativeSchemaKind, value: unknown): void {
  expect(validator.problems(kind, fresh(value))).toEqual([]);
}

function rejects(kind: NarrativeSchemaKind, value: unknown): void {
  expect(validator.problems(kind, fresh(value)).length).toBeGreaterThan(0);
}

/**
 * Compile a hand-perturbed variant of one of the real schemas and return a
 * predicate. `mutate` receives the real schema document (already cloned) and
 * edits the `$defs` entry named by `def`.
 */
function perturbed(
  kind: NarrativeSchemaKind,
  def: string,
  mutate: (definition: Record<string, unknown>) => void
): (value: unknown) => boolean {
  const document = fresh(narrativeSchemaFor(kind)) as { $defs: Record<string, Record<string, unknown>> };
  mutate(document.$defs[def]);
  const validate = new Ajv({ allErrors: true, useDefaults: true }).compile(document);
  return value => validate(fresh(value)) as boolean;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const rangeEvidence: EvidenceRef = {
  path: 'chapters/01-arrival.md',
  evidenceKind: 'range',
  range: { start: { line: 12, character: 4 }, end: { line: 12, character: 29 } }
};

const wholeFileEvidence: EvidenceRef = {
  path: 'entities/artifacts/sudarshana.yaml',
  evidenceKind: 'whole-file'
};

/** An entity card as the reader assembles it, with everything filled in. */
const richEntity: NarrativeEntity = {
  id: 'krishna',
  type: 'character',
  name: 'Кришна',
  sourcePath: 'entities/characters/krishna.yaml',
  sourceUri: 'file:///workspace/entities/characters/krishna.yaml',
  origin: 'ai-candidate',
  evidence: wholeFileEvidence,
  summary: 'Восьмое воплощение.',
  aliases: ['Говинда'],
  epithets: ['Мурлидхара'],
  backstory: 'Вриндаван.',
  arc: 'от пастуха к царю',
  speechPatterns: ['цитирует шастры'],
  notes: 'проверить главу 4'
};

/** A card written before provenance existed: no `origin:` key at all. */
const legacyCard = {
  id: 'sudarshana',
  type: 'artifact',
  name: 'Сударшана',
  sourcePath: 'entities/artifacts/sudarshana.yaml',
  sourceUri: 'file:///workspace/entities/artifacts/sudarshana.yaml',
  aliases: []
};

/** The unmarked wiki form `[[id]]`: no kind, no label, no computable offset. */
const bareMention: NarrativeMention = {
  entityId: 'krishna',
  raw: '[[krishna]]',
  resolved: true,
  evidence: wholeFileEvidence
};

const taggedMention: NarrativeMention = {
  entityId: 'krishna',
  kind: 'персонаж',
  raw: '[[персонаж:krishna|Кришна]]',
  label: 'Кришна',
  resolved: true,
  evidence: rangeEvidence,
  labelRange: { start: { line: 12, character: 20 }, end: { line: 12, character: 27 } }
};

const ownershipRelation: NarrativeRelation = {
  sourceId: 'sudarshana',
  targetId: 'krishna',
  relType: 'ownership',
  origin: 'explicit',
  ownerPath: 'entities/artifacts/sudarshana.yaml',
  sourceResolved: true,
  targetResolved: true,
  evidence: [wholeFileEvidence]
};

const candidateRelation: NarrativeRelation = {
  ...ownershipRelation,
  relType: 'выковал-для',
  origin: 'ai-candidate',
  confidence: 0.61
};

const derivedRelation: NarrativeRelation = {
  sourceId: 'krishna',
  targetId: 'arjuna',
  relType: 'co-occurrence',
  origin: 'derived',
  sourceResolved: true,
  targetResolved: true,
  evidence: [rangeEvidence]
};

/** `ownership.owner` naming an id no card defines — ISS-319's live case. */
const brokenTargetRelation: NarrativeRelation = {
  ...ownershipRelation,
  targetId: 'kamsa-the-nonexistent',
  targetResolved: false
};

/** The other end, which the live case does not happen to exercise. Both ends
 *  carry the flag, so both ends need a fixture — otherwise half the contract is
 *  asserted by a test that would pass with that half missing. */
const brokenSourceRelation: NarrativeRelation = {
  ...ownershipRelation,
  sourceId: 'artifact-that-was-deleted',
  sourceResolved: false
};

// ---------------------------------------------------------------------------
// The closed unions
// ---------------------------------------------------------------------------

describe('closed unions', () => {
  // A closed union is a promise, and these assertions are where the promise is
  // kept: enlarging one of these sets means editing a line that says, in
  // words, that it is closed. That is the point — not the count.
  test('origin has exactly the three values, entities and relations alike', () => {
    expect([...NARRATIVE_ORIGINS]).toEqual(['explicit', 'derived', 'ai-candidate']);
  });

  test('evidence kind has exactly two values', () => {
    expect([...EVIDENCE_KINDS]).toEqual(['range', 'whole-file']);
  });

  test('stale has exactly three entrances — a fourth candidate is rebuilding or failed', () => {
    expect([...INDEX_STALE_REASONS]).toEqual(['foreign-writer', 'watcher-lost', 'partial-update-failed']);
  });

  test('every failure code is a member of the union the ru bundle is checked against', () => {
    expect([...INDEX_FAILURE_CODES]).toEqual([
      'storage-unavailable',
      'storage-corrupted',
      'disk-full',
      'permission-denied',
      'manifest-unreadable',
      'extraction-failed',
      'internal'
    ]);
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe('EvidenceRef', () => {
  test('both kinds validate', () => {
    accepts('evidence', rangeEvidence);
    accepts('evidence', wholeFileEvidence);
  });

  test('an unknown kind is rejected — the union is closed', () => {
    rejects('evidence', { path: 'a.md', evidenceKind: 'approximate' });
  });

  test("'range' without coordinates is rejected", () => {
    rejects('evidence', { path: 'a.md', evidenceKind: 'range' });
  });

  test("'whole-file' WITH coordinates is rejected — the half optional fields would miss", () => {
    rejects('evidence', { ...wholeFileEvidence, range: rangeEvidence.range });
  });

  // REJECTING CASE for the design itself. If evidence had been modelled as one
  // shape with optional coordinates — the obvious alternative — the forbidden
  // combination above would pass, and an implementation could claim a precise
  // location it does not have. This proves the previous test has teeth.
  test('a schema with merely-optional coordinates ACCEPTS the forbidden value', () => {
    const permissive = new Ajv({ allErrors: true }).compile({
      type: 'object',
      required: ['path', 'evidenceKind'],
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        evidenceKind: { enum: [...EVIDENCE_KINDS] },
        range: { type: 'object' }
      }
    });
    expect(permissive({ ...wholeFileEvidence, range: rangeEvidence.range })).toBe(true);
    expect(validator.validate('evidence', { ...wholeFileEvidence, range: rangeEvidence.range })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

describe('NarrativeEntity', () => {
  test('a fully populated card validates, ai-candidate included', () => {
    accepts('entity', richEntity);
  });

  test('a legacy card with no origin passes AND comes out explicit', () => {
    const card = fresh(legacyCard) as Record<string, unknown>;
    expect(validator.problems('entity', card)).toEqual([]);
    expect(card.origin).toBe('explicit');
  });

  test('an entity with no id is rejected', () => {
    const { id, ...withoutId } = fresh(richEntity);
    void id;
    rejects('entity', withoutId);
  });

  test('an unknown origin is rejected — this is the vocabulary ajv owns, not the DDL', () => {
    rejects('entity', { ...richEntity, origin: 'probably-explicit' });
  });

  // ОВ-5 tooth 3 — the rejecting case for the REMOVAL of the old names.
  test('a card written with the OLD names is rejected outright', () => {
    rejects('entity', {
      kind: 'character',
      id: 'krishna',
      label: 'Кришна',
      path: 'entities/characters/krishna.yaml',
      uri: 'file:///workspace/entities/characters/krishna.yaml',
      aliases: []
    });
  });

  test('a card carrying BOTH spellings is rejected — removal, not aliasing', () => {
    rejects('entity', { ...richEntity, kind: 'character', label: 'Кришна', uri: 'file:///x' });
  });
});

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

describe('NarrativeMention', () => {
  test('the bare form — no kind, no label, no offset — MUST validate', () => {
    accepts('mention', bareMention);
  });

  // REJECTING CASE required by the readiness block: a schema demanding `kind`
  // must fail on this fixture. If it did not, the bare form would have no valid
  // representation and the TASK-013 U-B regression would return.
  test('a schema requiring `kind` rejects the bare form', () => {
    const demandsKind = perturbed('mention', 'narrativeMention', definition => {
      definition.required = [...(definition.required as string[]), 'kind'];
    });
    expect(demandsKind(bareMention)).toBe(false);
    expect(validator.validate('mention', bareMention)).toBe(true);
  });

  test('a tagged mention with a label span validates', () => {
    accepts('mention', taggedMention);
  });

  test('a mention with no entityId is rejected', () => {
    const { entityId, ...withoutEntityId } = fresh(taggedMention);
    void entityId;
    rejects('mention', withoutEntityId);
  });

  test('an unresolved mention is stored, not refused — a dropped fact cannot be shown', () => {
    accepts('mention', { ...bareMention, entityId: 'nobody', resolved: false });
  });

  test('a label span on a whole-file mention is FORBIDDEN, not merely unusual', () => {
    rejects('mention', { ...bareMention, labelRange: taggedMention.labelRange });
  });
});

// ---------------------------------------------------------------------------
// Relations — the four cases the readiness block names
// ---------------------------------------------------------------------------

describe('NarrativeRelation', () => {
  test('all three origins validate', () => {
    accepts('relation', ownershipRelation);
    accepts('relation', candidateRelation);
    accepts('relation', derivedRelation);
  });

  // Case 1. `ai-candidate` is a NORMAL mode (UR-026), not an edge case.
  test("a schema with only two origins rejects 'ai-candidate'", () => {
    const twoOrigins = perturbed('relation', 'narrativeRelation', definition => {
      (definition.properties as Record<string, unknown>).origin = { enum: ['explicit', 'derived'] };
    });
    expect(twoOrigins(candidateRelation)).toBe(false);
    expect(validator.validate('relation', candidateRelation)).toBe(true);
  });

  // Case 2. `relType` is an opaque string, forever.
  test('an invented relType validates', () => {
    accepts('relation', { ...ownershipRelation, relType: 'подарил-на-свадьбу' });
  });

  test('a schema with an enum over relType rejects the invented one', () => {
    const enumeratedTypes = perturbed('relation', 'narrativeRelation', definition => {
      (definition.properties as Record<string, unknown>).relType = { enum: ['ownership', 'co-occurrence'] };
    });
    expect(enumeratedTypes({ ...ownershipRelation, relType: 'подарил-на-свадьбу' })).toBe(false);
    expect(validator.validate('relation', { ...ownershipRelation, relType: 'подарил-на-свадьбу' })).toBe(true);
  });

  // Case 3. relType is part of identity: same ends, different types, two relations.
  test('two relations between the same ends with different types coexist', () => {
    const asOwner = { ...ownershipRelation, relType: 'ownership' };
    const asDevotee = { ...ownershipRelation, relType: 'devotion' };
    accepts('relation', asOwner);
    accepts('relation', asDevotee);

    const ends = (relation: NarrativeRelation) => `${relation.sourceId} -> ${relation.targetId}`;
    const identity = (relation: NarrativeRelation) =>
      graphEdgeKey({
        source: { id: relation.sourceId, type: 'entity' },
        target: { id: relation.targetId, type: 'entity' },
        relType: relation.relType
      });

    // The ends ALONE do not separate them — which is exactly why an identity
    // that ignored relType would collapse the two into one.
    expect(ends(asOwner)).toBe(ends(asDevotee));
    expect(identity(asOwner)).not.toBe(identity(asDevotee));
  });

  // Case 4. A broken end is stored WITH THE FLAG (ISS-319).
  test('a relation with EITHER end unresolved validates, and reads as broken', () => {
    accepts('relation', brokenTargetRelation);
    accepts('relation', brokenSourceRelation);
    expect(isRelationBroken(brokenTargetRelation)).toBe(true);
    expect(isRelationBroken(brokenSourceRelation)).toBe(true);
    expect(isRelationBroken(ownershipRelation)).toBe(false);
  });

  test('a schema demanding a resolved end rejects the broken one — once per end', () => {
    for (const end of ['sourceResolved', 'targetResolved'] as const) {
      const broken = end === 'sourceResolved' ? brokenSourceRelation : brokenTargetRelation;
      const demandsResolved = perturbed('relation', 'narrativeRelation', definition => {
        (definition.properties as Record<string, unknown>)[end] = { const: true };
      });
      expect(demandsResolved(broken)).toBe(false);
      expect(validator.validate('relation', broken)).toBe(true);
    }
  });

  // The owner rule: the author's decision must survive a rebuild from scratch.
  test('an author-facing relation with no owning card is rejected; derived is not', () => {
    const { ownerPath, ...orphanCandidate } = fresh(candidateRelation);
    void ownerPath;
    rejects('relation', orphanCandidate);
    accepts('relation', derivedRelation);
  });

  test('a relation with no evidence at all is rejected', () => {
    rejects('relation', { ...ownershipRelation, evidence: [] });
  });
});

// ---------------------------------------------------------------------------
// The state envelope — one fixture per variant
// ---------------------------------------------------------------------------

describe('IndexState envelope', () => {
  const failureReason: IndexFailureReason = {
    code: 'storage-corrupted',
    relPath: '.theia/narrative-index.db',
    incidentId: 'inc-1',
    occurrences: 2
  };

  const variants: IndexState[] = [
    { state: 'ready', generation: 7 },
    { state: 'rebuilding', generation: 7 },
    ...INDEX_ABSENT_CAUSES.map(cause => ({ state: 'absent' as const, generation: 0, cause })),
    { state: 'failed', generation: 7, reason: failureReason },
    ...INDEX_STALE_REASONS.map(staleReason => ({
      state: 'stale' as const,
      generation: 7,
      staleReason,
      staleSince: 1_754_000_000_000
    }))
  ];

  test('every branch of the envelope has a fixture and every fixture validates', () => {
    // 2 + 2 causes + 1 failed + 3 stale reasons.
    expect(variants).toHaveLength(8);
    for (const variant of variants) {
      accepts('index-state', variant);
    }
  });

  test('generation is on EVERY branch — "rebuilding" must be tellable from "no such thing"', () => {
    for (const variant of variants) {
      expect(typeof variant.generation).toBe('number');
    }
    rejects('index-state', { state: 'ready' });
  });

  test('an unknown state is rejected', () => {
    rejects('index-state', { state: 'degraded', generation: 1 });
  });

  test('absent without a cause is rejected — "not a manuscript" is not "never built"', () => {
    rejects('index-state', { state: 'absent', generation: 0 });
  });

  test('a fourth stale reason is rejected', () => {
    rejects('index-state', { state: 'stale', generation: 1, staleReason: 'probably-fine', staleSince: 1 });
  });

  test('a failure reason carrying a free-form message is rejected — nothing free-form crosses', () => {
    rejects('index-state', {
      state: 'failed',
      generation: 1,
      reason: { ...failureReason, message: 'ENOENT: /Users/someone/manuscript/x.md' }
    });
  });
});
