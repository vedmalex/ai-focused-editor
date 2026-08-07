/**
 * `getContextForDocument` — the shapes (TASK-022 WP-4a, tech_spec ОВ-2).
 *
 * THIS IS THE ONE READING METHOD WHOSE SEMANTICS WERE AN OPEN QUESTION, and
 * ОВ-2 is its single printed edition. What is restated here is only what a type
 * declaration cannot avoid restating; the reasoning stays there.
 *
 * WHY THESE TYPES ARE OUTSIDE `graph/`. They describe what the SERVICE hands a
 * consumer — `IndexState`, availability of capabilities that do not exist yet,
 * what was truncated and why. None of it is graph domain, and prohibition (e)
 * half 2 forbids the core from importing its neighbours, so a context type
 * inside `graph/` could not name `IndexState` at all.
 *
 * THE METHOD RETURNS NO PROSE. Only `EvidenceRef`s — a path and, when the
 * source had one, a range. The manuscript text is read by the assembler in
 * gh#51 at render time. That is not tidiness: WP-9a's memory budget exists
 * precisely to catch "the index kept chapter text instead of ranges", and a
 * context object carrying prose would defeat it one layer above the store.
 */

import type { EvidenceRange, EvidenceRef, NarrativeEntity, NarrativeMention, NarrativeRelation } from './graph';

/**
 * The sections a context can carry.
 *
 * FIVE ARE REAL IN #46 AND FIVE ARE NOT, and the ones that are not are named
 * here rather than omitted. A section absent from this union could only be
 * reported by not appearing, and "not appearing" is what an EMPTY section looks
 * like — which is the exact confusion {@link SectionAvailability} exists to
 * prevent.
 */
export type NarrativeContextSection =
  /** Entities referenced inside the resolved range. Real in #46. */
  | 'entities'
  /** Every reference inside the resolved range, each with its evidence. Real. */
  | 'mentions'
  /** Relations incident to those entities. Real. */
  | 'relations'
  /** The same entities in EARLIER chapters. Real. */
  | 'priorAppearances'
  /** Broken references, id collisions, broken relation ends. Real. */
  | 'findings'
  /** Character Cards — gh#47. */
  | 'characterProfiles'
  /** Story Timeline — gh#48. */
  | 'timeline'
  /** Plot Thread Map — gh#49. */
  | 'plotThreads'
  /** Explicit author questions and notes — gh#50. */
  | 'openQuestions'
  /** Scene subdivision of the chapter — gh#51. */
  | 'scenePlan';

/** Every member of {@link NarrativeContextSection}, as data. A test walks it. */
export const NARRATIVE_CONTEXT_SECTIONS = [
  'entities',
  'mentions',
  'relations',
  'priorAppearances',
  'findings',
  'characterProfiles',
  'timeline',
  'plotThreads',
  'openQuestions',
  'scenePlan'
] as const satisfies readonly NarrativeContextSection[];

/**
 * Which sections #46 cannot build yet, and the issue that will.
 *
 * `scenePlan` IS THE INTERESTING ONE and it is here for a reason recorded in
 * ISS-309: scenes DO exist in this product — `ScenePlanEntry` is generated and
 * persisted under `knowledge/plans/` — but `beats` are prose with no offsets,
 * so a scene cannot be resolved into a range by anything the index has. Saying
 * `empty` would assert "there are no scenes here" about a manuscript that has
 * a scene plan on disk. Saying `unavailable, requires gh#51` says the true
 * thing: the capability that turns a scene into an address is the assembler's,
 * and it is not built.
 */
export const UNAVAILABLE_CONTEXT_SECTIONS: Readonly<Record<string, string>> = Object.freeze({
  // AMENDED AT gh#47's LANDING, because silence was not an option (architecture
  // §3.4). gh#47 shipped the card as an INTERACTIVE surface with its own RPC
  // (`getEntityAppearances`), which the rule permits — but it did not fill this
  // section, and leaving `gh#47` here would make the record promise a task that
  // has already landed. The address moves to gh#51, whose recall assembler is
  // the consumer that actually needs profiles inside a document's context; the
  // card's own data path does not go through here at all.
  characterProfiles: 'gh#51',
  timeline: 'gh#48',
  plotThreads: 'gh#49',
  openQuestions: 'gh#50',
  scenePlan: 'gh#51'
});

/**
 * Whether a section has data, has none, or does not exist yet.
 *
 * THE DIFFERENCE BETWEEN `empty` AND `unavailable` IS THE WHOLE POINT, not
 * decoration. gh#51's governing rule is that unknown facts must be omitted or
 * explicitly marked unknown; applied to whole capabilities that means an empty
 * `plotThreads` list reads as "this passage has no plot threads", which is a
 * lie until gh#49 exists. A consumer that renders `unavailable` as "not built
 * yet" and `empty` as "nothing here" is telling the truth in both cases; a
 * consumer given only a list length cannot.
 */
export type SectionAvailability =
  | { status: 'present'; count: number }
  | { status: 'empty' }
  | { status: 'unavailable'; requires: string };

/** The default cap on how many items one section may return. */
export const DEFAULT_MAX_EVIDENCE_PER_SECTION = 50;

/**
 * What a caller may ask for.
 *
 * ONE OPTIONS OBJECT RATHER THAN A POSITIONAL `range?`, because a fourth knob
 * would otherwise break the signature. Nothing is broken by starting this way:
 * the method exists in no file of this repository before this work package.
 */
export interface NarrativeContextOptions {
  /**
   * The passage to describe. ABSENT means the whole document.
   *
   * `SemanticRange` in ОВ-2 and {@link EvidenceRange} here are the SAME SHAPE
   * (`{start:{line,character}, end:{...}}`) and assignable in both directions;
   * this package uses its own declaration because the graph core may import
   * nothing outward, and having the option type disagree with the type its
   * results are expressed in would be worse than the naming difference.
   *
   * gh#51's `scope: 'selection'|'scene'|'chapter'` and its `cursor` are NOT
   * here: resolving either needs a Monaco model or fuzzy matching of scene
   * beats against prose, and the index has neither. `resolveScope` belongs to
   * the assembler; the index speaks only in ranges.
   */
  range?: EvidenceRange;
  /**
   * Hard cap PER SECTION. Defaults to {@link DEFAULT_MAX_EVIDENCE_PER_SECTION}.
   *
   * gh#51's `tokenBudget` deliberately does NOT live here: tokens are a
   * property of a model and a renderer, the index stores ranges rather than
   * text, and importing a tokenizer would break prohibition (d) outright.
   */
  maxEvidencePerSection?: number;
  /**
   * Defaults to TRUE: chapters positioned AFTER this one contribute nothing.
   *
   * A document the manifest does not list has no provable position, so under
   * `spoilerSafe` it is EXCLUDED rather than guessed at — and its count lands
   * in {@link NarrativeDocumentContext.omitted} with reason `unknown-position`,
   * so a draft outside the manifest does not vanish silently.
   */
  spoilerSafe?: boolean;
  /**
   * Which sections to build. ABSENT means all of them.
   *
   * IT IS A PROJECTION, NOT A SURVEY, and the difference is worth knowing
   * before relying on it: a section left out is not built, so its entry in
   * {@link NarrativeDocumentContext.sections} reports `empty` — which is what
   * "the service did not look" looks like from the outside. A caller that uses
   * `include` must not read the availability of a section it excluded.
   *
   * The alternative — computing every section's real count and then discarding
   * it — would make the option pointless, since `priorAppearances` is the
   * expensive one and counting it IS building it.
   */
  include?: readonly NarrativeContextSection[];
}

/** Why something did not make it into a section. */
export type OmissionReason =
  /** The section hit {@link NarrativeContextOptions.maxEvidencePerSection}. */
  | 'limit'
  /**
   * The item could not be PROVEN to belong.
   *
   * Two cases, and they are the same case: a document with no `chapterOrder`
   * cannot be shown to precede the current chapter, and a `whole-file` mention
   * carries no coordinates so it cannot be shown to fall inside a requested
   * range. Both are "the index knows this exists and cannot place it", which is
   * a different statement from "it is not there".
   */
  | 'unknown-position';

/** One section's omissions, with a count rather than a silence. */
export interface OmittedInfo {
  section: NarrativeContextSection;
  count: number;
  reason: OmissionReason;
}

/** What kind of defect a finding reports. */
export type NarrativeFindingKind =
  /** `[[kind:id]]` in prose naming an id no card defines. From `mention.resolved = 0`. */
  | 'broken-mention'
  /** Two cards claiming one id. From `entity_duplicate`. */
  | 'duplicate-entity'
  /**
   * A relation end naming an id no card defines. From `relation_broken`.
   *
   * THE THIRD SOURCE, and it is not a duplicate of the first (F-TS3-1): a
   * broken `ownership.owner` is a STRUCTURAL YAML FIELD, not prose, so no
   * `mention` row is ever created for it. Without this kind the acceptance
   * criterion "broken links are visible as diagnostics" held for prose only —
   * and today's `readOwnership` turns an unknown owner into its own label,
   * which is the defect being made visible.
   */
  | 'broken-relation';

/** One defect, always navigable. */
export interface NarrativeFinding {
  kind: NarrativeFindingKind;
  /** The id at the centre of the finding — the unresolved or contested one. */
  entityId: string;
  /**
   * Where to look. REQUIRED on every finding, like every other element of
   * every section: a defect a reader cannot navigate to is a defect they
   * cannot fix.
   */
  evidence: EvidenceRef;
  /** For `duplicate-entity`: the card whose definition the index HOLDS. */
  keptRelPath?: string;
  /** For `broken-relation`: the other end, and the type. */
  relType?: string;
  /** For `broken-relation`: which end could not be resolved. */
  unresolvedEnd?: 'source' | 'target' | 'both';
}

/**
 * An entity in the passage, with the place it was referenced.
 *
 * THE EVIDENCE IS REQUIRED HERE EVEN THOUGH `NarrativeEntity.evidence` IS
 * OPTIONAL, and the two are different facts: the optional one points at the
 * CARD, this one points at the reference IN THIS DOCUMENT. ОВ-2's tooth 4
 * ("no element of any section arrives without an `EvidenceRef`") is about the
 * second — a consumer shown an entity needs to know why it is in the answer.
 */
export interface NarrativeContextEntity {
  entity: NarrativeEntity;
  /** The FIRST reference to this entity inside the resolved range, in the
   *  order the extraction read the document. */
  evidence: EvidenceRef;
}

/**
 * A relation incident to a context entity.
 *
 * AN ALIAS, NOT A WRAPPER, AND DELIBERATELY SO. `NarrativeRelation` already
 * carries `evidence: EvidenceRef[]` as a required, non-empty field, so it
 * already satisfies everything ОВ-2 asks of an element of this section. A
 * wrapper would add a field no consumer needs and force every reader to unwrap;
 * the name exists so that gh#57's registry can later attach fold information
 * here without touching the storage type.
 */
export type NarrativeContextRelation = NarrativeRelation;

/** What the index knows about the document itself. */
export interface NarrativeContextDocument {
  /** Workspace-relative path — the index's own document key. */
  relPath: string;
  /** Position in `manifest.yaml`. ABSENT for a file the manifest does not list. */
  chapterOrder?: number;
  /** Whether `manifest.yaml` lists this file. */
  manifestIncluded: boolean;
}

/** Everything the index can say about one passage. */
export interface NarrativeDocumentContext {
  /** The URI the caller asked about, returned verbatim. */
  documentUri: string;
  /** The range the SERVICE actually used. ABSENT when the whole document was. */
  resolvedRange?: EvidenceRange;
  document: NarrativeContextDocument;
  entities: NarrativeContextEntity[];
  mentions: NarrativeMention[];
  relations: NarrativeContextRelation[];
  /** The same entities in chapters positioned BEFORE this one. */
  priorAppearances: NarrativeMention[];
  findings: NarrativeFinding[];
  /** Availability of EVERY section, including the ones #46 cannot build. */
  sections: Record<NarrativeContextSection, SectionAvailability>;
  /** What was cut, from where, and why. Never a silence. */
  omitted: OmittedInfo[];
  /**
   * `${schemaVersion}.${generation}` — gh#51's cache key.
   *
   * `generation` is the store's WRITE counter (it advances once per committed
   * write transaction), not a count of rebuilds. See `index-state.ts`.
   */
  indexVersion: string;
}
