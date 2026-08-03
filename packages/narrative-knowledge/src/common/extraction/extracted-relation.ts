/**
 * `ExtractedRelation` — a {@link NarrativeRelation} plus the facts extraction
 * knows and the domain contract has no field for (TASK-022 WP-2, R-14).
 *
 * WHY IT EXTENDS RATHER THAN WRAPS. An `ExtractedRelation` IS a
 * `NarrativeRelation`: it is assignable wherever one is expected, no consumer
 * unwraps a `.relation` property, and the extra fields are dropped by the
 * storage boundary the same way any excess property is. A wrapper would force
 * every reader of an extraction result to know about the wrapper.
 *
 * WHY THE EXTRA FIELDS ARE NOT IN `NarrativeRelation`. They belong to ONE
 * source (`ownership`) and the schema has no columns for them
 * (tech_spec ОВ-1's `relation` table stores ends, type, origin, confidence,
 * owner document and the two resolved flags — nothing else). Putting them on
 * the shared contract would promise every consumer a chronology that does not
 * exist.
 *
 * THE NAMING IS THE POINT (R-14 / UR-023). `ownership.from`/`to` LOOK like an
 * interval and are not: `yaml-schema-validator.ts:101-103` states outright that
 * "Chronology follows list order; from/to are freeform story-time labels, not
 * real dates". Carrying them as `storyTimeFrom`/`storyTimeTo` makes the reader
 * of the FIELD NAME see what the reader of `from` does not, and
 * {@link ExtractedRelation.listPosition} carries the only ordering the data
 * really has. Sorting, comparing or date-parsing the labels is FORBIDDEN.
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
   * FOR `ownership` THIS IS THE CHRONOLOGY AND THE ONLY ONE (R-14). It is a
   * field rather than an array index because an array index survives exactly
   * until something re-sorts, and the whole risk R-14 records is a reader who
   * sorts by the story-time labels.
   */
  listPosition: number;
  /**
   * `ownership.from`, verbatim.
   *
   * A FREE-FORM STORY-TIME LABEL ("before the siege"), not a date, and not
   * comparable between two cards. Never parsed, never sorted, never compared.
   */
  storyTimeFrom?: string;
  /** `ownership.to`, verbatim. Same rules as {@link storyTimeFrom}. */
  storyTimeTo?: string;
  /** `ownership.note`, verbatim. Author prose about the transfer. */
  note?: string;
}
