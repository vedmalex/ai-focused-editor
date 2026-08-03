/**
 * The `ajv` schemas that guard the narrative domain at the READ BOUNDARY
 * (TASK-022 WP-1).
 *
 * WHERE THIS LAYER SITS, AND WHY IT IS NOT THE DATABASE'S JOB. tech_spec ОВ-1
 * draws the line explicitly: the DDL guards STRUCTURAL invariants that cannot
 * be reconstructed from the files, while `ajv` guards VOCABULARIES, where a
 * violation is an author's typo. That is not a preference. A `CHECK` fires
 * three layers down and yields a `SQLITE_CONSTRAINT` with no file name in it;
 * a check here fires where there is something to SAY — which file, which line,
 * which category of finding. So `origin` values are validated HERE and
 * deliberately NOT constrained in the DDL.
 *
 * WHAT THESE SCHEMAS VALIDATE. The DOMAIN values — an entity as assembled by
 * the reader from a card, a mention, a relation, an index-state envelope — not
 * the raw YAML text. `origin` is the one field that comes straight from the
 * card and may be missing there, which is why it is the one field with a
 * default: a card written before provenance existed validates, and comes out
 * carrying `explicit`.
 *
 * `additionalProperties: false` IS PART OF THE PROMISE, not tidiness. ОВ-5
 * removed `kind`/`label`/`uri` rather than deprecating them, precisely so that
 * a value still using them cannot pass as valid. Under a permissive schema a
 * card carrying BOTH spellings would validate, and "ported" would again be
 * indistinguishable from "forgotten".
 *
 * WHAT IS DELIBERATELY NOT VALIDATED: `relType`. It is an opaque string and no
 * schema here will ever check it against a vocabulary — an `enum` on it would
 * make the relation-type registry (gh#57) unimplementable without a schema
 * migration. The same goes for entity `type`.
 *
 * `useDefaults` MUTATES. Ajv writes the `origin` default into the value it is
 * handed. That is the intended mechanism, and it means a caller wanting to keep
 * its input pristine must clone before validating.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { EVIDENCE_KINDS, NARRATIVE_ORIGINS, DEFAULT_NARRATIVE_ORIGIN } from './graph';
import { INDEX_ABSENT_CAUSES, INDEX_STALE_REASONS } from './index-state';
import { INDEX_FAILURE_CODES } from './index-failure';

/** Which domain value a caller wants checked. */
export type NarrativeSchemaKind = 'entity' | 'mention' | 'relation' | 'evidence' | 'index-state';

// ---------------------------------------------------------------------------
// Shared definitions
// ---------------------------------------------------------------------------

const evidencePosition = {
  type: 'object',
  required: ['line', 'character'],
  additionalProperties: false,
  properties: {
    line: { type: 'integer', minimum: 0 },
    character: { type: 'integer', minimum: 0 }
  }
} as const;

const evidenceRange = {
  type: 'object',
  required: ['start', 'end'],
  additionalProperties: false,
  properties: {
    start: { $ref: '#/$defs/evidencePosition' },
    end: { $ref: '#/$defs/evidencePosition' }
  }
} as const;

/**
 * The two shapes of evidence, as a `oneOf` rather than one shape with optional
 * coordinates.
 *
 * This is the machine form of `CHECK ((evidence_kind = 'range') = (start_line
 * IS NOT NULL))`: `'range'` WITHOUT a range is rejected, and — the half that a
 * merely-optional field would miss entirely — `'whole-file'` WITH a range is
 * rejected too. Tolerating the second would let an implementation claim a
 * precise location it does not have.
 */
const evidenceRef = {
  type: 'object',
  required: ['evidenceKind'],
  // Stated once here so an unknown kind reports itself as an unknown kind,
  // instead of as the unreadable "must match exactly one schema in oneOf".
  properties: { evidenceKind: { enum: [...EVIDENCE_KINDS] } },
  oneOf: [
    {
      type: 'object',
      required: ['path', 'evidenceKind', 'range'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1 },
        evidenceKind: { const: 'range' },
        range: { $ref: '#/$defs/evidenceRange' }
      }
    },
    {
      type: 'object',
      required: ['path', 'evidenceKind'],
      additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1 },
        evidenceKind: { const: 'whole-file' }
      }
    }
  ]
} as const;

const narrativeEntity = {
  type: 'object',
  required: ['id', 'type', 'name', 'sourcePath', 'sourceUri', 'origin', 'aliases'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    // Opaque on purpose — see the module note.
    type: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    sourcePath: { type: 'string', minLength: 1 },
    sourceUri: { type: 'string', minLength: 1 },
    // The one defaulted field: a card with no `origin:` key is a card the
    // author wrote, and there are years of them.
    origin: { enum: [...NARRATIVE_ORIGINS], default: DEFAULT_NARRATIVE_ORIGIN },
    evidence: { $ref: '#/$defs/evidenceRef' },
    summary: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' } },
    epithets: { type: 'array', items: { type: 'string' } },
    backstory: { type: 'string' },
    arc: { type: 'string' },
    speechPatterns: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' }
  }
} as const;

/**
 * A mention.
 *
 * `kind` IS ABSENT FROM `required`, and that is the contract, not an oversight:
 * the bare `[[id]]` form carries no kind, and a schema demanding one would
 * leave that form with no valid representation at all — the shape of the
 * TASK-013 U-B regression.
 *
 * The `if/then` is the machine form of `CHECK (label_start_line IS NULL OR
 * evidence_kind = 'range')`: a label span on a whole-file mention is FORBIDDEN,
 * not merely unusual.
 */
const narrativeMention = {
  type: 'object',
  required: ['entityId', 'raw', 'resolved', 'evidence'],
  additionalProperties: false,
  properties: {
    entityId: { type: 'string', minLength: 1 },
    kind: { type: 'string', minLength: 1 },
    raw: { type: 'string', minLength: 1 },
    label: { type: 'string' },
    resolved: { type: 'boolean' },
    evidence: { $ref: '#/$defs/evidenceRef' },
    labelRange: { $ref: '#/$defs/evidenceRange' }
  },
  if: { required: ['labelRange'] },
  then: {
    properties: {
      evidence: { type: 'object', properties: { evidenceKind: { const: 'range' } } }
    }
  }
} as const;

/**
 * A relation.
 *
 * The `if/then` is the machine form of `CHECK (origin = 'derived' OR doc_id IS
 * NOT NULL)`: an author-facing relation must name the card that owns it, or the
 * author's decision would live only in a rebuildable cache and the first
 * rebuild would erase it.
 *
 * `sourceResolved`/`targetResolved` are REQUIRED and may freely be `false`: a
 * relation with an end nothing defines is a FINDING to show, so it is stored
 * with the flag rather than dropped or stored silently.
 */
const narrativeRelation = {
  type: 'object',
  required: ['sourceId', 'targetId', 'relType', 'origin', 'sourceResolved', 'targetResolved', 'evidence'],
  additionalProperties: false,
  properties: {
    sourceId: { type: 'string', minLength: 1 },
    targetId: { type: 'string', minLength: 1 },
    // NO `enum` here, ever. See the module note.
    relType: { type: 'string', minLength: 1 },
    origin: { enum: [...NARRATIVE_ORIGINS] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    ownerPath: { type: 'string', minLength: 1 },
    sourceResolved: { type: 'boolean' },
    targetResolved: { type: 'boolean' },
    evidence: { type: 'array', minItems: 1, items: { $ref: '#/$defs/evidenceRef' } }
  },
  if: { properties: { origin: { enum: ['explicit', 'ai-candidate'] } }, required: ['origin'] },
  then: { required: ['ownerPath'] }
} as const;

const indexFailureReason = {
  type: 'object',
  required: ['code', 'incidentId', 'occurrences'],
  additionalProperties: false,
  properties: {
    code: { enum: [...INDEX_FAILURE_CODES] },
    relPath: { type: 'string', minLength: 1 },
    incidentId: { type: 'string', minLength: 1 },
    occurrences: { type: 'integer', minimum: 1 }
  }
} as const;

/**
 * The state envelope, one branch per member.
 *
 * Every branch carries `generation`: an empty answer during a rebuild has to be
 * distinguishable from an empty answer meaning "there is no such thing", and
 * that is the entire reason the envelope exists.
 */
const indexState = {
  oneOf: [
    {
      type: 'object',
      required: ['state', 'generation'],
      additionalProperties: false,
      properties: {
        state: { enum: ['ready', 'rebuilding'] },
        generation: { type: 'integer', minimum: 0 }
      }
    },
    {
      type: 'object',
      required: ['state', 'generation', 'cause'],
      additionalProperties: false,
      properties: {
        state: { const: 'absent' },
        generation: { type: 'integer', minimum: 0 },
        cause: { enum: [...INDEX_ABSENT_CAUSES] }
      }
    },
    {
      type: 'object',
      required: ['state', 'generation', 'reason'],
      additionalProperties: false,
      properties: {
        state: { const: 'failed' },
        generation: { type: 'integer', minimum: 0 },
        reason: { $ref: '#/$defs/indexFailureReason' }
      }
    },
    {
      type: 'object',
      required: ['state', 'generation', 'staleReason', 'staleSince'],
      additionalProperties: false,
      properties: {
        state: { const: 'stale' },
        generation: { type: 'integer', minimum: 0 },
        staleReason: { enum: [...INDEX_STALE_REASONS] },
        staleSince: { type: 'integer', minimum: 0 }
      }
    }
  ]
} as const;

const $defs = {
  evidencePosition,
  evidenceRange,
  evidenceRef,
  narrativeEntity,
  narrativeMention,
  narrativeRelation,
  indexFailureReason,
  indexState
};

const ROOT_BY_KIND: Record<NarrativeSchemaKind, keyof typeof $defs> = {
  entity: 'narrativeEntity',
  mention: 'narrativeMention',
  relation: 'narrativeRelation',
  evidence: 'evidenceRef',
  'index-state': 'indexState'
};

/** The schema document a caller can inspect or serialize for a given kind. */
export function narrativeSchemaFor(kind: NarrativeSchemaKind): object {
  return { $ref: `#/$defs/${ROOT_BY_KIND[kind]}`, $defs };
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/** One thing wrong with a value, in a form a diagnostic can carry. */
export interface NarrativeSchemaProblem {
  /** JSON pointer into the value, `''` for the value itself. */
  instancePath: string;
  message: string;
}

/**
 * Compiled validators for the narrative domain.
 *
 * Not `@injectable()`: this layer must stay runnable with nothing resolved, and
 * the wiring that needs a DI binding can bind an instance.
 */
export class NarrativeSchemaValidator {
  protected readonly ajv = new Ajv({ allErrors: true, useDefaults: true });

  protected readonly validators: Record<NarrativeSchemaKind, ValidateFunction> = {
    entity: this.ajv.compile(narrativeSchemaFor('entity')),
    mention: this.ajv.compile(narrativeSchemaFor('mention')),
    relation: this.ajv.compile(narrativeSchemaFor('relation')),
    evidence: this.ajv.compile(narrativeSchemaFor('evidence')),
    'index-state': this.ajv.compile(narrativeSchemaFor('index-state'))
  };

  /**
   * True when `value` is a valid instance of `kind`.
   *
   * MUTATES `value`: a missing `origin` is filled in with the default. That is
   * how a card written before provenance existed becomes an `explicit` entity.
   */
  validate(kind: NarrativeSchemaKind, value: unknown): boolean {
    return this.validators[kind](value) as boolean;
  }

  /** Everything wrong with `value`, or an empty array when it is valid. */
  problems(kind: NarrativeSchemaKind, value: unknown): NarrativeSchemaProblem[] {
    const validator = this.validators[kind];
    if (validator(value)) {
      return [];
    }
    return (validator.errors ?? []).map((error: ErrorObject) => ({
      instancePath: error.instancePath,
      message: `${error.instancePath || '(value)'} ${error.message ?? 'is invalid'}`
    }));
  }
}
