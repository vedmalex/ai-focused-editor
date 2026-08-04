/**
 * `ExtractedRelation` — a {@link NarrativeRelation} that is GUARANTEED to carry
 * its position in the list it was read from (TASK-022 WP-2, R-14; narrowed by
 * WP-7 / UR-031).
 *
 * WHAT THIS TYPE USED TO SAY, AND WHY IT NO LONGER SAYS IT. Until schema v3 this
 * module declared four fields of its own — `listPosition`, `storyTimeFrom`,
 * `storyTimeTo`, `note` — and justified keeping them OFF `NarrativeRelation` on
 * the grounds that "the schema has no columns for them". That justification was
 * TRUE and its consequence was a LOSS: the fields were extracted from the
 * author's YAML and then discarded at the storage boundary, while the Narrative
 * Map went on rendering exactly those facts from a separate filesystem read. v3
 * adds the columns (tech_spec ОВ-1, "Схема v3"), the four fields now live on
 * {@link NarrativeRelation} where the storage port can actually carry them, and
 * the old note is REPLACED rather than annotated — a module that explains why a
 * field is absent, beside the field, is a document asserting two things.
 *
 * WHAT IS LEFT HERE IS A NARROWING, AND IT IS A REAL ONE. On the shared contract
 * `listPosition` is OPTIONAL, because a co-occurrence edge is a fold over the
 * whole mention set and came from no list. On an `ExtractedRelation` it is
 * REQUIRED, because every extraction source IS a list — `ownership:` entries and
 * card mentions both — so a producer here that cannot name a position has lost
 * track of its input. The type is what stops that from compiling.
 *
 * WHY IT EXTENDS RATHER THAN WRAPS. An `ExtractedRelation` IS a
 * `NarrativeRelation`: it is assignable wherever one is expected and no consumer
 * unwraps a `.relation` property. A wrapper would force every reader of an
 * extraction result to know about the wrapper.
 *
 * THE NAMING IS STILL THE POINT (R-14 / UR-023). `ownership.from`/`to` LOOK like
 * an interval and are not; the field names on {@link NarrativeRelation} say so,
 * and sorting, comparing or date-parsing the labels is FORBIDDEN.
 */

import type { NarrativeRelation } from '../graph';

/**
 * Relation type of an `ownership:` entry in an artifact card — the one TYPED
 * author-written relation in the whole project.
 *
 * An opaque string, like every `relType`: nothing in this package validates it
 * against a vocabulary, and the registry that will is gh#57's.
 */
export const OWNERSHIP_REL_TYPE = 'ownership';

/**
 * Relation type of an entity mention found inside another card's free text.
 *
 * The source carries NO name, type or direction (plan WP-2, source 3) — the
 * author wrote `[[krishna]]` in a backstory and meant only "this is relevant
 * here". `mentions` is therefore a NAME FOR THE ABSENCE of a type, not a claim
 * about the relationship; direction runs from the card that contains the text
 * to the card it names, which is the only direction the data states.
 */
export const CARD_MENTION_REL_TYPE = 'mentions';

export interface ExtractedRelation extends NarrativeRelation {
  /**
   * Zero-based position of this relation within the list it was read from —
   * the `ownership:` list for an ownership relation, mention order for a card
   * mention.
   *
   * REQUIRED HERE, optional on {@link NarrativeRelation}. See the module note:
   * every extraction source is a list, so a position always exists; the fold
   * that produces co-occurrence edges has no list and therefore no position.
   */
  listPosition: number;
}
