/**
 * `NarrativeEntity` — one entity card, as the index holds it (TASK-022 WP-1).
 *
 * FIELD NAMES ARE THE ONES tech_spec ОВ-5 DECIDED, and the old ones are GONE,
 * not deprecated: `kind → type`, `label → name`, `uri → sourceUri`, `path`
 * stays as `sourcePath`. Keeping both spellings would let a consumer nobody
 * migrated keep reading the old field and keep COMPILING, and then neither the
 * compiler nor any test can tell "ported" from "forgotten". Removing them
 * outright makes `tsc` part of the migration check.
 *
 * `sourcePath` SURVIVES ALONGSIDE `sourceUri` on purpose. The index keys
 * documents by workspace-relative path (`document.rel_path`, ОВ-1) while a
 * frontend navigates by URI, and deriving one from the other requires knowing
 * the workspace root — which `src/common` neither knows nor should. One extra
 * field on the wire is cheaper than every consumer parsing URIs by hand.
 *
 * `type` IS AN OPAQUE STRING HERE. The registry that knows which type ids are
 * legal lives outside this folder, and the core may not import it (prohibition
 * (e)); the same rule already applies to `NarrativeGraphNode.type` and to
 * `relType`. Validating a type id against the effective registry is a separate
 * layer that reports `EntityTypeProblem`s, not something this type can express.
 */

import type { EvidenceRef } from './evidence';
import type { NarrativeOrigin } from './narrative-origin';

export interface NarrativeEntity {
  /** Stable, rebuild-surviving identity. Unique per `type`. */
  id: string;
  /** Entity type id (`character`, `term`, an author-declared type…). Opaque. */
  type: string;
  /** Display name, verbatim from the card — no trimming, no case folding. */
  name: string;
  /** Workspace-relative path of the card file. The index's document key. */
  sourcePath: string;
  /** URI of the same card, for consumers that navigate by URI. */
  sourceUri: string;
  /**
   * Provenance. A card with no `origin:` key reads as `explicit` — see
   * {@link DEFAULT_NARRATIVE_ORIGIN}; by the time an entity is a
   * `NarrativeEntity` the default has already been applied, which is why this
   * field is REQUIRED here and optional on disk.
   */
  origin: NarrativeOrigin;
  /**
   * Where the card itself is, when the reader recorded it.
   *
   * OPTIONAL, and it is the one evidence field that is: ОВ-5's conversion table
   * marks it `evidence?` because the legacy transport shape cannot carry one,
   * and the round-trip through that shape must be able to state exactly which
   * two fields it loses. Mentions and relations, whose whole purpose is to
   * point somewhere, carry it REQUIRED.
   */
  evidence?: EvidenceRef;
  summary?: string;
  aliases: string[];
  /** Alternate honorifics/titles. */
  epithets?: string[];
  /** Longer-form history behind the entity. */
  backstory?: string;
  /** How the entity changes across the manuscript. */
  arc?: string;
  /** Characteristic ways this entity speaks or is referred to. */
  speechPatterns?: string[];
  /** Free-form authoring notes. */
  notes?: string;
}
