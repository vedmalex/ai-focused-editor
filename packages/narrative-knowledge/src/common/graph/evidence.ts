/**
 * `EvidenceRef` — the navigable pointer every mention and every relation must
 * carry (TASK-022 WP-1, tech_spec ОВ-1 / ISS-320).
 *
 * WHY A KIND AND NOT JUST OPTIONAL COORDINATES. Some facts genuinely have no
 * range: an `ownership` entry lives in a structural YAML field, and a
 * front-matter mention is read through a YAML parser that has already discarded
 * offsets by the time the value is seen. If the coordinates were merely
 * optional, an implementation would fill them with zeros to satisfy a
 * `NOT NULL`, the "every element carries evidence" check would stay green, and
 * the user would be sent to the top of the file — a breakage indistinguishable
 * from working. `evidenceKind` makes the difference OBSERVABLE all the way up
 * to the UI, which is the actual decision here; the optional coordinates are
 * only its consequence.
 *
 * SPELLING. The schema column in tech_spec ОВ-1 is `evidence_kind`, and the
 * domain field here is `evidenceKind` — the same one-field-two-spellings split
 * those documents already use between `mention.tag_kind` (column) and
 * `NarrativeMention.kind` (field, plan WP-1 rule 1), and between
 * `document.rel_path` and `sourcePath`. SQL names stay in the DDL.
 *
 * WHY A DISCRIMINATED UNION AND NOT `range?`. The DDL states the pairing as
 * `CHECK ((evidence_kind = 'range') = (start_line IS NOT NULL))` — the two
 * fields are not independently optional, they are two shapes. Encoding that as
 * a union means the forbidden combinations are UNCONSTRUCTIBLE rather than
 * merely unwritten, and no consumer ever needs a `range!`.
 *
 * PATHS, NEVER URIs. This folder is the separable graph core (AD-6): a module
 * that drags `@theia/core` in cannot be lifted out, so identity is a plain
 * workspace-relative `string` and the conversion to a URI lives on the
 * boundary. `path` is the same key the index uses for document identity
 * (`document.rel_path`, tech_spec ОВ-1).
 */

/** One position inside a text document, zero-based on both axes.
 *
 *  Structurally identical to the range type the semantic-tag parser already
 *  produces, on purpose: the extraction in WP-2 maps one to the other by
 *  assignment, with no field renaming to get wrong. It is redeclared rather
 *  than imported because the core may import nothing from outside this folder
 *  (prohibition (e)). */
export interface EvidencePosition {
  line: number;
  character: number;
}

/** A half-open span inside a single document. */
export interface EvidenceRange {
  start: EvidencePosition;
  end: EvidencePosition;
}

/**
 * How precisely a piece of evidence locates the fact it supports.
 *
 * CLOSED UNION. A third member would be a new state for every consumer that
 * renders evidence, and the DDL pairs these two values with the nullability of
 * the coordinate columns. Needing a third value is a finding to report, not a
 * member to add.
 */
export type EvidenceKind = 'range' | 'whole-file';

/** Every member of {@link EvidenceKind}, as data — see {@link NARRATIVE_ORIGINS}. */
export const EVIDENCE_KINDS = ['range', 'whole-file'] as const satisfies readonly EvidenceKind[];

/** Evidence that points at an exact span — a semantic tag in prose. */
export interface RangeEvidenceRef {
  /** Workspace-relative path of the file the evidence is in. */
  path: string;
  evidenceKind: 'range';
  range: EvidenceRange;
}

/**
 * Evidence that points at a file and no further — a structural YAML field, or
 * a front-matter mention.
 *
 * `range` is declared as `?: undefined` rather than omitted so that a value
 * carrying a range cannot be widened into this branch by excess-property
 * elision. Consumers must present this as what it is: opening the file WITHOUT
 * positioning the cursor. Moving such a fact to `'range'` later is ADDITIVE —
 * the value of one field changes, the shape does not.
 */
export interface WholeFileEvidenceRef {
  /** Workspace-relative path of the file the evidence is in. */
  path: string;
  evidenceKind: 'whole-file';
  range?: undefined;
}

/** A navigable pointer to where a fact was read from. */
export type EvidenceRef = RangeEvidenceRef | WholeFileEvidenceRef;

/** Narrow an {@link EvidenceRef} to the branch that carries coordinates. */
export function isRangeEvidence(evidence: EvidenceRef): evidence is RangeEvidenceRef {
  return evidence.evidenceKind === 'range';
}

/** Evidence for a fact whose source file offers no computable offset. */
export function wholeFileEvidence(path: string): WholeFileEvidenceRef {
  return { path, evidenceKind: 'whole-file' };
}

/** Evidence for a fact located at an exact span. */
export function rangeEvidence(path: string, range: EvidenceRange): RangeEvidenceRef {
  return { path, evidenceKind: 'range', range };
}
