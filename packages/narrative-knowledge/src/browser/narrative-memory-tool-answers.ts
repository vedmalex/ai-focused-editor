import URI from '@theia/core/lib/common/uri';
import {
  NARRATIVE_TOOL_NOTICE_KEYS,
  compareEntitiesForDisplay,
  isRangeEvidence,
  narrativeToolIndexReport,
  type EntityAppearanceResult,
  type Envelope,
  type ExcerptUnavailableReason,
  type MentionOrderExclusion,
  type EvidenceKind,
  type EvidenceRange,
  type EvidenceRef,
  type IndexAbsentCause,
  type IndexFailureCode,
  type IndexStaleReason,
  type IndexState,
  type NarrativeDocumentContext,
  type NarrativeEntity,
  type NarrativeFinding,
  type NarrativeMention,
  type NarrativeOrigin,
  type NarrativeRelation,
  type NarrativeToolIndexReport,
  type OmittedInfo,
  type SectionAvailability
} from '../common';
import { localizeNarrativeMemoryKey } from './narrative-memory-render';

/**
 * What the four read-only AI tools actually HAND BACK (TASK-022 WP-6).
 *
 * SEPARATE FROM THE `ToolProvider` CLASSES, AND TESTED WHERE THEY CANNOT BE.
 * This module imports `@theia/core/lib/common/uri` and
 * `@theia/core/lib/common/nls` (through `narrative-memory-render`) and nothing
 * else — both load under `bun`, which is why every assertion of WP-6's readiness
 * block runs in the ordinary `test:packages` lane. The contribution beside it
 * pulls `inversify` and `@theia/ai-core`, and is left with nothing in it but
 * argument parsing and a `JSON.stringify`. The precedent is
 * `narrative-memory-markers.ts` against `narrative-memory-contribution.ts`.
 *
 * TWO DECISIONS ARE MADE HERE AND THEY ARE WORTH FINDING QUICKLY.
 *
 * (1) NAVIGATION IS DERIVED FROM A RELATIVE PATH, NEVER READ FROM
 * `entity.sourceUri`. That field is a LIVE DEFECT: `moveDocument` repairs the
 * denormalized `sourcePath` in both adapters and neither touches the URI
 * (`sqlite-narrative-index-store.ts:1056-1059`,
 * `in-memory-narrative-index-store.ts:495-499`), so after a rename an entity
 * still names the file it used to live at — pinned in both directions by
 * `test/node/index-invariants.test.mts:614`, with the blast radius recorded (a
 * full rebuild repairs it). These tools are the first surface that NAVIGATES
 * from an entity, so reading that field would send an author to a file that no
 * longer exists. Every `uri` below is `root.resolve(<relative path>)`, and
 * `sourceUri` is not merely unread — it is ABSENT from the projection, so a
 * downstream consumer of a tool answer cannot pick the stale value up either.
 * WP-5's diagnostics publisher took the same route for the same reason.
 *
 * (2) EVIDENCE WITHOUT A RANGE IS VISIBLE AS SUCH (ISS-320). Every evidence
 * carries `locator`, and a `whole-file` one carries NO `range` key at all —
 * not a zeroed one. The answer additionally says so in words, once, when any
 * evidence in it is whole-file: a model handed `{"line": 0}` will cite line 1 of
 * a YAML card with complete confidence, and that breakage is indistinguishable
 * from working software.
 */

// ---------------------------------------------------------------------------
// The shapes a tool answers in
// ---------------------------------------------------------------------------

/** One navigable pointer, as a tool renders it. */
export interface NarrativeToolEvidence {
  /** Workspace-relative path — the index's own document key. */
  readonly path: string;
  /** The same file as a URI, DERIVED from `path` (see the module note). */
  readonly uri: string;
  /**
   * Whether this evidence locates a span or only a file.
   *
   * Named `locator` rather than `evidenceKind` because the reader here is a
   * language model rather than a TypeScript consumer, and `kind` already means
   * something else in this domain (`NarrativeMention.kind` is the tag kind).
   */
  readonly locator: EvidenceKind;
  /** Present exactly when `locator === 'range'`. */
  readonly range?: EvidenceRange;
}

/** An entity card, as a tool renders it. `sourceUri` is deliberately absent. */
export interface NarrativeToolEntity {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly origin: NarrativeOrigin;
  readonly summary?: string;
  readonly aliases?: readonly string[];
  readonly epithets?: readonly string[];
  readonly arc?: string;
  /**
   * Where the card is.
   *
   * REQUIRED HERE THOUGH `NarrativeEntity.evidence` IS OPTIONAL. The readiness
   * block admits no fact without an `EvidenceRef`, and an entity always has one
   * available: the card file itself. When the reader recorded no evidence, this
   * is `whole-file` over `sourcePath` — which is the truth (a card is a file,
   * and the extraction discarded offsets) rather than a fabricated range.
   */
  readonly evidence: NarrativeToolEvidence;
}

/** One reference to an entity, as a tool renders it. */
export interface NarrativeToolMention {
  readonly entityId: string;
  readonly kind?: string;
  readonly label?: string;
  readonly raw: string;
  /** False when no card defines `entityId`. Such references are RETURNED. */
  readonly resolved: boolean;
  readonly evidence: NarrativeToolEvidence;
}

/** One directed relation, as a tool renders it. */
export interface NarrativeToolRelation {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relType: string;
  readonly origin: NarrativeOrigin;
  readonly confidence?: number;
  /** Workspace-relative path of the card that owns it. Absent for `derived`. */
  readonly ownerPath?: string;
  readonly sourceResolved: boolean;
  readonly targetResolved: boolean;
  /** At least one. A relation with no evidence is unrepresentable upstream. */
  readonly evidence: readonly NarrativeToolEvidence[];
}

/** One defect, as a tool renders it. */
export interface NarrativeToolFinding {
  readonly kind: NarrativeFinding['kind'];
  readonly entityId: string;
  readonly relType?: string;
  readonly unresolvedEnd?: NarrativeFinding['unresolvedEnd'];
  readonly keptRelPath?: string;
  readonly evidence: NarrativeToolEvidence;
}

/** The passage answer of `narrative_document_context`. */
export interface NarrativeToolContext {
  readonly path: string;
  readonly uri: string;
  readonly chapterOrder?: number;
  readonly manifestIncluded: boolean;
  readonly resolvedRange?: EvidenceRange;
  /** `${schemaVersion}.${generation}` — safe to cache against. */
  readonly indexVersion: string;
  readonly entities: readonly (NarrativeToolEntity & { readonly referencedAt: NarrativeToolEvidence })[];
  readonly mentions: readonly NarrativeToolMention[];
  readonly relations: readonly NarrativeToolRelation[];
  readonly priorAppearances: readonly NarrativeToolMention[];
  readonly findings: readonly NarrativeToolFinding[];
  /**
   * Availability of EVERY section, the ones #46 cannot build included.
   *
   * CARRIED THROUGH VERBATIM. `empty` and `unavailable` are different claims —
   * "there are no plot threads here" versus "nothing computes plot threads yet"
   * — and a model given only a list length cannot tell them apart, which is the
   * one confusion `SectionAvailability` exists to prevent.
   */
  readonly sections: Record<string, SectionAvailability>;
  /** What was cut, from where, and why. Never a silence. */
  readonly omitted: readonly OmittedInfo[];
}

/** What every tool answer says about the index, minus the localization keys. */
export interface NarrativeToolIndexBlock {
  readonly state: IndexState['state'];
  readonly generation: number;
  readonly answered: boolean;
  readonly absentCause?: IndexAbsentCause;
  readonly staleReason?: IndexStaleReason;
  readonly staleSince?: number;
  readonly failureCode?: IndexFailureCode;
  readonly incidentId?: string;
}

/**
 * One tool answer.
 *
 * THE DATA KEY IS ABSENT, NOT EMPTY, WHENEVER `index.answered` IS FALSE. An
 * empty list would assert "there is no such thing" about an index that has not
 * finished reading, or is broken, or was never built — which is the single
 * failure mode this whole epic exists to remove.
 */
export interface NarrativeToolAnswer {
  readonly index: NarrativeToolIndexBlock;
  /**
   * Sentences the caller must not drop, in order.
   *
   * EMPTY EXACTLY WHEN the index is `ready` and no whole-file evidence is in
   * the answer. Under `stale` it always carries the staleness mark AND its
   * reason — requirement 4, whose rejecting case is this array missing them.
   */
  readonly notice: readonly string[];
  readonly entities?: readonly NarrativeToolEntity[];
  readonly mentions?: readonly NarrativeToolMention[];
  readonly relations?: readonly NarrativeToolRelation[];
  readonly context?: NarrativeToolContext;
  /**
   * Present only on `narrative_document_context`, and only as `false`.
   *
   * `data: undefined` from `getContextForDocument` means THIS DOCUMENT IS NOT
   * IN THE INDEX — a different statement from every section being empty, and
   * a fifth answer alongside the four states. It is reported as its own flag
   * rather than as an empty context for the same reason the data key vanishes
   * above.
   */
  readonly documentIndexed?: false;
  /** gh#47. Present only on `narrative_entity_appearances`. */
  readonly appearances?: readonly NarrativeToolAppearance[];
  /** Present only when the caller asked for the spread. */
  readonly documentCount?: number;
  readonly documents?: readonly NarrativeToolAppearanceDocument[];
}

/** One appearance, as a model sees it (gh#47). */
export interface NarrativeToolAppearance {
  readonly entityId: string;
  readonly evidence: NarrativeToolEvidence;
  readonly chapterTitle?: string;
  readonly chapterOrder?: number;
  /** Present exactly when this appearance has no place in the built book. */
  readonly notInBookOrder?: MentionOrderExclusion;
  readonly excerpt?: string;
  /** Present exactly when {@link excerpt} is absent and one was asked for. */
  readonly excerptUnavailable?: ExcerptUnavailableReason;
}

/** One document holding mentions, with its count (gh#47). */
export interface NarrativeToolAppearanceDocument {
  readonly path: string;
  readonly mentions: number;
  readonly title?: string;
  readonly notInBookOrder?: MentionOrderExclusion;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Where an entity card is, taking the PATH from `sourcePath` and the
 * coordinates — if any were ever recorded — from `evidence`.
 *
 * THE PATH SUBSTITUTION IS THE FIX FOR A SECOND INSTANCE OF THE MOVE DEFECT,
 * found by the rename tooth in `narrative-memory-tool-answers.test.ts`.
 * `moveDocument` repairs the denormalized `entity.sourcePath` in both adapters
 * (`in-memory-narrative-index-store.ts:495-499`,
 * `sqlite-narrative-index-store.ts:1056-1059`) and repairs `mention.evidence.path`
 * and the relation evidence too — but an ENTITY's own `evidence.path` is left
 * behind alongside `sourceUri`. Both adapters agree, so the divergence is not an
 * adapter bug to fix in one of them; and repairing it in the port is the ОВ-5
 * problem all over again. So the fix is here, at the layer that renders it:
 * `sourcePath` IS the repaired field, and it is the one this answer navigates by.
 *
 * `evidence` IS OPTIONAL, AND THE ABSENT CASE IS NOT HYPOTHETICAL. Today's
 * extraction always records `wholeFileEvidence(document.path)`
 * (`entity-card-extraction.ts:328`), but the legacy bridge WP-7 migrates
 * deliberately records NONE (`legacy-narrative-entity.ts:60-64`) — so an entity
 * that reaches a tool through that path has nothing to navigate to unless this
 * function supplies it. It supplies the card, whole-file, which is the truth
 * rather than an invention.
 *
 * THE `range` ARM IS UNREACHABLE WITH TODAY'S EXTRACTION and is here anyway,
 * because `EvidenceRef` has two branches and silently discarding the coordinates
 * of the first entity that ever gets them would be a data loss nothing reports.
 * It is exercised by a test rather than left as an untested limb.
 */
function entityEvidence(entity: NarrativeEntity): EvidenceRef {
  const recorded = entity.evidence;
  if (recorded !== undefined && isRangeEvidence(recorded)) {
    return { path: entity.sourcePath, evidenceKind: 'range', range: recorded.range };
  }
  return { path: entity.sourcePath, evidenceKind: 'whole-file' };
}

/**
 * Collects evidence as it is projected, so the answer can say ONCE — rather
 * than fifty times — that some of it names no position.
 */
class EvidenceProjector {
  private readonly root: URI;
  /** True once any projected evidence turned out to be `whole-file`. */
  sawWholeFile = false;

  constructor(rootUri: string) {
    this.root = new URI(rootUri);
  }

  uriOf(relPath: string): string {
    return this.root.resolve(relPath).toString();
  }

  of(evidence: EvidenceRef): NarrativeToolEvidence {
    const base = { path: evidence.path, uri: this.uriOf(evidence.path) };
    if (isRangeEvidence(evidence)) {
      return { ...base, locator: 'range', range: evidence.range };
    }
    // NO `range` KEY AT ALL. Not `range: undefined` and emphatically not a
    // zeroed one: `JSON.stringify` drops an `undefined` value, so both spell the
    // same wire bytes — but writing zeros here is the exact failure ISS-320
    // names, and there is no reason to type a shape that permits it.
    this.sawWholeFile = true;
    return { ...base, locator: 'whole-file' };
  }

  entity(entity: NarrativeEntity): NarrativeToolEntity {
    return {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      origin: entity.origin,
      ...(entity.summary === undefined ? {} : { summary: entity.summary }),
      ...(entity.aliases.length === 0 ? {} : { aliases: entity.aliases }),
      ...(entity.epithets === undefined || entity.epithets.length === 0
        ? {}
        : { epithets: entity.epithets }),
      ...(entity.arc === undefined ? {} : { arc: entity.arc }),
      evidence: this.of(entityEvidence(entity))
    };
  }

  mention(mention: NarrativeMention): NarrativeToolMention {
    return {
      entityId: mention.entityId,
      ...(mention.kind === undefined ? {} : { kind: mention.kind }),
      ...(mention.label === undefined ? {} : { label: mention.label }),
      raw: mention.raw,
      resolved: mention.resolved,
      evidence: this.of(mention.evidence)
    };
  }

  relation(relation: NarrativeRelation): NarrativeToolRelation {
    return {
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      relType: relation.relType,
      origin: relation.origin,
      ...(relation.confidence === undefined ? {} : { confidence: relation.confidence }),
      ...(relation.ownerPath === undefined ? {} : { ownerPath: relation.ownerPath }),
      sourceResolved: relation.sourceResolved,
      targetResolved: relation.targetResolved,
      evidence: relation.evidence.map(item => this.of(item))
    };
  }

  finding(finding: NarrativeFinding): NarrativeToolFinding {
    return {
      kind: finding.kind,
      entityId: finding.entityId,
      ...(finding.relType === undefined ? {} : { relType: finding.relType }),
      ...(finding.unresolvedEnd === undefined ? {} : { unresolvedEnd: finding.unresolvedEnd }),
      ...(finding.keptRelPath === undefined ? {} : { keptRelPath: finding.keptRelPath }),
      evidence: this.of(finding.evidence)
    };
  }
}

/** The machine half of the report, with the localization keys stripped off. */
function indexBlock(report: NarrativeToolIndexReport): NarrativeToolIndexBlock {
  const { noticeKeys: _ignored, ...block } = report;
  return block;
}

function localize(keys: readonly string[]): string[] {
  return keys.map(localizeNarrativeMemoryKey);
}

/**
 * Assemble an answer from a report, the projected data, and whatever the
 * projector saw.
 *
 * ONE PLACE WHERE `notice` IS BUILT, so no tool can forget it. That is the
 * whole defence for requirement 4: `narrativeToolIndexReport` decides that a
 * `stale` index owes the caller two sentences, and every tool goes through
 * here.
 */
function assemble(
  state: IndexState,
  projector: EvidenceProjector,
  data: (report: NarrativeToolIndexReport) => Partial<NarrativeToolAnswer>
): NarrativeToolAnswer {
  const report = narrativeToolIndexReport(state);
  const payload = report.answered ? data(report) : {};
  return {
    index: indexBlock(report),
    notice: localize([
      ...report.noticeKeys,
      ...(projector.sawWholeFile ? [NARRATIVE_TOOL_NOTICE_KEYS.wholeFileEvidence] : [])
    ]),
    ...payload
  };
}

// ---------------------------------------------------------------------------
// The four answers
// ---------------------------------------------------------------------------

/**
 * `narrative_find_entities`.
 *
 * ORDERED FOR A READER (ISS-349, decided in `narrative-memory-tools.ts`). The
 * index answers in code-point order, which puts `Ярость` before `арджуна`
 * because every upper-case Cyrillic letter sorts before every lower-case one;
 * this is the first surface that renders a list of NAMES to a person, so it
 * collates them under an explicit locale. Nothing else in this module reorders
 * anything — mentions and relations arrive in document-path order, which is a
 * reading order rather than an alphabet.
 */
export function narrativeFindEntitiesAnswer(
  rootUri: string,
  result: Envelope<NarrativeEntity[]>
): NarrativeToolAnswer {
  const projector = new EvidenceProjector(rootUri);
  return assemble(result.state, projector, () => ({
    entities: [...result.data]
      .sort(compareEntitiesForDisplay)
      .map(entity => projector.entity(entity))
  }));
}

/** `narrative_find_mentions`. */
export function narrativeFindMentionsAnswer(
  rootUri: string,
  result: Envelope<NarrativeMention[]>
): NarrativeToolAnswer {
  const projector = new EvidenceProjector(rootUri);
  return assemble(result.state, projector, () => ({
    mentions: result.data.map(mention => projector.mention(mention))
  }));
}

/**
 * `narrative_entity_relations`.
 *
 * DIRECT RELATIONS ONLY — one hop — and that is the boundary with gh#59, not a
 * simplification: sets, subgraphs and neighbourhoods of depth N are that issue's
 * territory (plan, "Граница scope после разбора связей"). SYMMETRIC PAIRS ARE
 * NOT FOLDED (ISS-326): a fact the author wrote into both cards is two rows with
 * two owners and two pieces of evidence, and folding them is a read rule that
 * belongs to the relation-type registry in gh#57.
 */
export function narrativeEntityRelationsAnswer(
  rootUri: string,
  result: Envelope<NarrativeRelation[]>
): NarrativeToolAnswer {
  const projector = new EvidenceProjector(rootUri);
  return assemble(result.state, projector, () => ({
    relations: result.data.map(relation => projector.relation(relation))
  }));
}

/**
 * The answer for a call that named no entity (gh#47).
 *
 * `answered: false` AND NO DATA KEY, which is the discipline the whole tool
 * surface follows: a data key present but empty asserts that the question was
 * asked and came back empty. It was not asked at all.
 */
export function narrativeMissingEntityIdAnswer(): NarrativeToolAnswer {
  return {
    index: { state: 'absent', generation: 0, answered: false, absentCause: 'no-manuscript' },
    notice: localize([NARRATIVE_TOOL_NOTICE_KEYS.missingEntityId])
  };
}

/**
 * `narrative_entity_appearances` (gh#47).
 *
 * THE TWO HONESTIES THIS ANSWER OWES A MODEL, and both are the difference
 * between a useful recall and a confident invention:
 *
 *  - an appearance with `orderExclusion` is NOT a first or latest appearance.
 *    It is returned, because it is a real mention, and it carries WHY it cannot
 *    be placed. A model told only "here are the appearances in order" would
 *    happily report a chapter cut from the build as where a character debuts.
 *  - an appearance with `excerptUnavailable` has NO quotation, and the reason
 *    travels with it. Passing the field through as an absent string would let a
 *    model narrate silence as "the passage is empty".
 */
export function narrativeEntityAppearancesAnswer(
  rootUri: string,
  result: Envelope<EntityAppearanceResult>
): NarrativeToolAnswer {
  const projector = new EvidenceProjector(rootUri);
  return assemble(result.state, projector, () => ({
    appearances: result.data.appearances.map(appearance => ({
      entityId: appearance.mention.entityId,
      evidence: projector.of(appearance.mention.evidence),
      ...(appearance.chapterTitle === undefined ? {} : { chapterTitle: appearance.chapterTitle }),
      ...(appearance.chapterOrder === undefined ? {} : { chapterOrder: appearance.chapterOrder }),
      // Present ONLY when it applies, so its presence is the signal rather than
      // a value the model has to compare against a sentinel.
      ...(appearance.orderExclusion === undefined
        ? {}
        : { notInBookOrder: appearance.orderExclusion }),
      ...(appearance.excerpt === undefined ? {} : { excerpt: appearance.excerpt }),
      ...(appearance.excerptUnavailable === undefined
        ? {}
        : { excerptUnavailable: appearance.excerptUnavailable })
    })),
    ...(result.data.spread === undefined
      ? {}
      : {
          documentCount: result.data.spread.length,
          documents: result.data.spread.map(row => ({
            path: row.relPath,
            mentions: row.mentionCount,
            ...(row.title === undefined ? {} : { title: row.title }),
            ...(row.orderExclusion === undefined ? {} : { notInBookOrder: row.orderExclusion })
          }))
        })
  }));
}

/** `narrative_document_context`. */
export function narrativeDocumentContextAnswer(
  rootUri: string,
  result: Envelope<NarrativeDocumentContext | undefined>
): NarrativeToolAnswer {
  const projector = new EvidenceProjector(rootUri);
  const context = result.data;
  if (context === undefined) {
    // The index does not hold this document. Reported as its own flag with its
    // own sentence, never as an empty context — an empty context would assert
    // that a file the index never read contains no narrative facts.
    const report = narrativeToolIndexReport(result.state);
    return {
      index: indexBlock(report),
      notice: localize([
        ...report.noticeKeys,
        ...(report.answered ? [NARRATIVE_TOOL_NOTICE_KEYS.documentNotIndexed] : [])
      ]),
      ...(report.answered ? { documentIndexed: false as const } : {})
    };
  }
  return assemble(result.state, projector, () => ({
    context: {
      path: context.document.relPath,
      uri: projector.uriOf(context.document.relPath),
      ...(context.document.chapterOrder === undefined
        ? {}
        : { chapterOrder: context.document.chapterOrder }),
      manifestIncluded: context.document.manifestIncluded,
      ...(context.resolvedRange === undefined ? {} : { resolvedRange: context.resolvedRange }),
      indexVersion: context.indexVersion,
      // NOT re-sorted: this list is in the order the extraction READ the
      // document, which is the order the passage itself puts them in. An
      // alphabet here would destroy information the reader wants.
      entities: context.entities.map(item => ({
        ...projector.entity(item.entity),
        referencedAt: projector.of(item.evidence)
      })),
      mentions: context.mentions.map(mention => projector.mention(mention)),
      relations: context.relations.map(relation => projector.relation(relation)),
      priorAppearances: context.priorAppearances.map(mention => projector.mention(mention)),
      findings: context.findings.map(finding => projector.finding(finding)),
      sections: context.sections,
      omitted: context.omitted
    }
  }));
}

/**
 * The answer when no manuscript is open at all.
 *
 * A REAL ANSWER RATHER THAN A THROW. A tool that rejects gives the model an
 * error string it will paraphrase into something invented; a tool that says "no
 * manuscript is open" gives it a fact.
 */
export function narrativeNoWorkspaceAnswer(): NarrativeToolAnswer {
  return {
    index: { state: 'absent', generation: 0, answered: false, absentCause: 'no-manuscript' },
    notice: localize([NARRATIVE_TOOL_NOTICE_KEYS.noWorkspace])
  };
}
