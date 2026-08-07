/**
 * `NarrativeMention` — one occurrence of a reference to an entity (TASK-022
 * WP-1).
 *
 * `kind` IS OPTIONAL, AND THAT IS THE CONTRACT (plan WP-1, F-P7-3). The
 * unmarked wiki form `[[id]]` carries no kind at all — the parser's own
 * signature is `record(kind: string | undefined, id, label?)` — so three rules
 * follow and none of them is negotiable:
 *
 *   1. `kind` is an OPTIONAL field;
 *   2. a mention WITHOUT `kind` is matched to a card BY `id` ALONE;
 *   3. a mention without `kind` takes part in NEITHER "create the missing
 *      card" NOR "unknown kind".
 *
 * The price of getting this wrong is already recorded in this repository: the
 * TASK-013 U-B regression. If `kind` were REQUIRED the bare form would have no
 * valid representation left and that regression would return.
 *
 * `resolved` MODELS A BROKEN LINK AS DATA. A mention pointing at an id no card
 * defines is STORED with `resolved: false`, never dropped — a dropped fact
 * cannot be shown to the author, and showing it is the entire point.
 */

import type { EvidenceRange, EvidenceRef } from './evidence';

export interface NarrativeMention {
  /** The referenced entity id, exactly as written. Never a URI. */
  entityId: string;
  /**
   * The tag kind when the reference was written as `kind:id`.
   *
   * ABSENT for the bare `[[id]]` form — see the three rules above. Opaque: the
   * core does not own the vocabulary of kinds.
   */
  kind?: string;
  /** The full matched text, e.g. `[[персонаж:krishna|Кришна]]` or `[[krishna]]`. */
  raw: string;
  /**
   * The display label when the reference carried one.
   *
   * ABSENT for the bare form, and by a SECOND, INDEPENDENT reason: the
   * semantic-tag pattern REQUIRES `|label`, so the bare form has no label
   * anywhere in any file — not merely an unrecorded one.
   */
  label?: string;
  /** False when no card defines {@link entityId}. Such mentions are kept. */
  resolved: boolean;
  /** Where the mention is. Required — a mention that cannot be navigated to is
   *  the failure this whole index exists to prevent. */
  evidence: EvidenceRef;
  /**
   * Span of the `|label` part alone, for consumers that highlight it
   * separately.
   *
   * MEANINGFUL ONLY when `evidence.evidenceKind === 'range'`: the DDL states
   * this as `CHECK (label_start_line IS NULL OR evidence_kind = 'range')`,
   * which FORBIDS a label span on a whole-file mention rather than merely
   * tolerating its absence. The schema in `narrative-schema.ts` rejects the
   * forbidden combination; the DDL rejects it again one layer down.
   */
  labelRange?: EvidenceRange;
}
