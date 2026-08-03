/**
 * `NarrativeRelation` — one directed, typed link between two entities
 * (TASK-022 WP-1, UR-012 / UR-013 / UR-025 / UR-026, ISS-319).
 *
 * FOUR THINGS ARE FIXED HERE, AND THEY HOLD NO MATTER WHO LATER BUILDS THE
 * RELATION-TYPE REGISTRY (gh#57):
 *
 *   1. `relType` is an OPAQUE STRING. Neither this type nor the index ever
 *      validates it against a list of allowed values. Vocabulary validation and
 *      the "unknown relation type" diagnostic are a SEPARATE layer, modelled on
 *      `EntityTypeProblem` — putting an enum here would make gh#57
 *      unimplementable without a schema migration.
 *   2. `relType` is PART OF IDENTITY. Two relations between the same ends with
 *      different types are TWO relations.
 *   3. DIRECTION IS STORED, NOT DERIVED. (`sourceId`, `targetId`) is an ORDERED
 *      pair. Whether a given type is semantically symmetric is a property of
 *      the registry, not of this type — and a symmetric type written into both
 *      cards lands as TWO rows with different owners, each with its own
 *      evidence in its own file. Folding them is a READ rule, and it is not
 *      promised here.
 *   4. EACH END CARRIES ITS RESOLVEDNESS. A relation whose end names an id no
 *      card defines is STORED WITH THE FLAG and FEEDS A FINDING — it is
 *      neither dropped nor stored silently. Silently is today's behaviour and
 *      it is the defect: an owner id that matches nothing currently becomes its
 *      own label and disappears.
 *
 * WHERE THE TRUTH LIVES. A relation has no file of its own — it lives in the
 * CARD OF ITS `sourceId`, which {@link NarrativeRelation.ownerPath} names. That
 * is not a style choice: the database is a fully rebuildable cache, so an
 * author decision recorded only there is erased by the first rebuild. An
 * `ai-candidate` accepted by the author is an `origin` transition IN THAT SAME
 * YAML; a rejected one is DELETED, and its absence from the source IS the
 * decision. The SYNTAX of writing one, and the confirmation lifecycle, are
 * gh#57/gh#58's territory — the INVARIANT is here.
 */

import type { EvidenceRef } from './evidence';
import type { NarrativeOrigin } from './narrative-origin';

export interface NarrativeRelation {
  /** The end the relation points FROM. An entity id, never a URI. */
  sourceId: string;
  /** The end the relation points TO. */
  targetId: string;
  /** Opaque relation-type discriminator. Part of identity. Never validated here. */
  relType: string;
  /** Provenance. `ai-candidate` is a normal mode, not an edge case (UR-026). */
  origin: NarrativeOrigin;
  /**
   * Agent confidence, when the producer had one. Absent for author-written and
   * for computed relations; a number nobody produced is worse than no number.
   */
  confidence?: number;
  /**
   * Workspace-relative path of the card that OWNS this relation — the card of
   * `sourceId`.
   *
   * REQUIRED for `explicit` and `ai-candidate`, and ABSENT ONLY for `derived`.
   * The schema states that as `CHECK (origin = 'derived' OR doc_id IS NOT
   * NULL)` and the constraint lives in the DDL rather than in an adapter
   * because an adapter can be bypassed by a migration or a repair script.
   *
   * It is modelled as an optional field rather than as a discriminant of a
   * two-branch union because `origin` is a value consumers FILTER on, not a
   * shape they switch on; making it a discriminant would force every reader of
   * `ownerPath` to narrow first even when it does not care.
   */
  ownerPath?: string;
  /** False when no card defines {@link sourceId}. The relation is still stored. */
  sourceResolved: boolean;
  /** False when no card defines {@link targetId}. The relation is still stored. */
  targetResolved: boolean;
  /**
   * Where the relation was read from. At least one, and possibly several: a
   * relation restated in more than one document has evidence in each.
   *
   * Required, and required to be non-empty: "every mention and every relation
   * carries navigable evidence" is a delivery criterion, and an empty array
   * would satisfy the type while failing the criterion.
   */
  evidence: EvidenceRef[];
}

/** True when either end of `relation` names an id no card defines. This is the
 *  domain reading of the partial `relation_broken` index, and the reason such a
 *  relation is stored rather than dropped. */
export function isRelationBroken(relation: NarrativeRelation): boolean {
  return !relation.sourceResolved || !relation.targetResolved;
}
