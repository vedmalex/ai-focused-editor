/**
 * The entity card's view model, assembled from index answers (gh#47 WP-3).
 *
 * ## Why this file is pure and lives in `common/`
 *
 * Two reasons, and the second is the one that would otherwise be discovered
 * late. First, the widget must receive a MODEL and never scan the workspace —
 * the service boundary gh#47 sets. Second, `packages/manuscript-workspace/src/browser/typography/`
 * already runs in its own test lane because its happy-dom bootstrap installs
 * PROCESS-WIDE globals; a card whose logic lived in the React widget would drag
 * its tests into that same shape. Everything decidable without a DOM is decided
 * here, so the widget is left with rendering and the tests with plain data.
 *
 * ## Generic over entity types, not "characters"
 *
 * gh#47 is written about characters, but `character` is one row of
 * `entity-type-registry.ts` and an author can declare their own kinds in
 * `entities/types.yaml`. A character-only model would be a second vocabulary
 * beside the registry — the divergence gh#57 exists to end. So the model is
 * built for whatever kind the entity has, and the descriptor is looked up
 * rather than assumed.
 */

import type {
  EffectiveEntityType,
  EntityAppearance,
  IndexState,
  MentionDocumentCount,
  NarrativeEntity,
  NarrativeRelation
} from '@ai-focused-editor/narrative-knowledge';

/**
 * One authored fact, ready to render.
 *
 * `field` is the entity-schema field id (`summary`, `backstory`, …) rather than
 * a translated label: the label belongs to i18n keyed by that id, and putting a
 * rendered string here would make the model locale-dependent and untestable
 * without one.
 */
export interface EntityCardFact {
  field: string;
  /** A paragraph, or a list. Never empty, never blank — see {@link buildEntityCard}. */
  value: string | readonly string[];
}

export interface EntityCardViewModel {
  entity: NarrativeEntity;
  /**
   * The registry's descriptor for {@link NarrativeEntity.type}.
   *
   * ABSENT IS A REAL STATE, not a defect to paper over: a card can name a type
   * the author has since removed from `entities/types.yaml`. The card still
   * renders — the entity is real and its mentions are real — it simply has no
   * icon or label to borrow, and the consumer says so rather than inventing one.
   */
  type?: EffectiveEntityType;
  /** Authored fields that HAVE a value, in schema order. */
  explicitFacts: EntityCardFact[];
  /** Names beside {@link NarrativeEntity.name}, deduplicated against it. */
  otherNames: string[];
  /**
   * Where the entity is first and last seen IN THE BUILT BOOK.
   *
   * Absent when nothing placeable exists — an entity mentioned only in an
   * unlisted chapter has appearances but no first appearance, and saying
   * otherwise is the exact defect gh#47's ordering fix closed.
   */
  firstAppearance?: EntityAppearance;
  latestAppearance?: EntityAppearance;
  /** Most recent first. May include unplaceable appearances, which trail. */
  recentAppearances: EntityAppearance[];
  /** Every document the entity is mentioned in, with counts, in book order. */
  chapterSpread: MentionDocumentCount[];
  /** Documents that hold at least one mention. */
  chapterCount: number;
  relations: NarrativeRelation[];
  /**
   * The index state the answers came from.
   *
   * CARRIED RATHER THAN COLLAPSED TO A BOOLEAN: "the entity has no relations"
   * and "the index is rebuilding, so no relations are known yet" are different
   * claims to the author, and a card that renders an empty section for both is
   * the silence the whole envelope discipline exists to prevent.
   */
  indexState: IndexState;
}

/** What {@link buildEntityCard} needs. Every field is an answer already
 *  obtained; this function performs no I/O and issues no queries. */
export interface EntityCardInput {
  entity: NarrativeEntity;
  type?: EffectiveEntityType;
  /** Ascending manuscript order, as `getEntityAppearances` returns it. */
  ascending: readonly EntityAppearance[];
  /** Descending manuscript order — the recent list AND the latest appearance. */
  descending: readonly EntityAppearance[];
  chapterSpread: readonly MentionDocumentCount[];
  relations: readonly NarrativeRelation[];
  indexState: IndexState;
}

/**
 * The authored fields a card shows, in the order it shows them.
 *
 * A LIST HERE RATHER THAN `Object.keys(entity)`, because the iteration order of
 * an object is not a design decision anybody made, and because `id`, `type`,
 * `sourcePath`, `sourceUri`, `origin` and `evidence` are machinery rather than
 * facts the author wrote about their character.
 */
const FACT_FIELDS = ['summary', 'backstory', 'arc', 'speechPatterns', 'notes'] as const;

/** Blank is absent. A field the author left as spaces is not a fact. */
function present(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function presentList(value: readonly string[] | undefined): string[] {
  return (value ?? []).filter(entry => entry.trim().length > 0);
}

/**
 * Assemble the model.
 *
 * ONE RULE RUNS THROUGH ALL OF IT: a field with nothing to say is ABSENT from
 * the model rather than present and empty. gh#47's UX section asks that empty
 * fields be hidden instead of shown as a long blank questionnaire, and making
 * that true in the TYPE means a renderer cannot forget it — the alternative is
 * a `value && <Row/>` guard at every call site, which is exactly the kind of
 * check that gets forgotten in the sixth one.
 */
export function buildEntityCard(input: EntityCardInput): EntityCardViewModel {
  const { entity } = input;
  const explicitFacts: EntityCardFact[] = [];
  for (const field of FACT_FIELDS) {
    const raw = entity[field];
    if (typeof raw === 'string') {
      if (present(raw)) {
        explicitFacts.push({ field, value: raw });
      }
      continue;
    }
    const list = presentList(raw);
    if (list.length > 0) {
      explicitFacts.push({ field, value: list });
    }
  }

  // AC of gh#47: "merges YAML metadata with indexed appearances WITHOUT
  // DUPLICATING ALIASES". Aliases and epithets are separate fields on the card
  // and routinely overlap — an author writes `Говинда` in both — and the display
  // name itself is frequently repeated in `aliases`. Deduplicating on the way
  // out is what makes the card readable; doing it in the renderer would mean
  // doing it in each of the two places that render names.
  const seen = new Set<string>([entity.name.trim()]);
  const otherNames: string[] = [];
  for (const candidate of [...presentList(entity.aliases), ...presentList(entity.epithets)]) {
    const trimmed = candidate.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      otherNames.push(trimmed);
    }
  }

  // FIRST AND LATEST ARE NOT `[0]` OF EACH LIST. Unplaceable appearances trail
  // the ordered ones in BOTH directions (see `MentionOrderExclusion`), so a
  // list that contains ONLY unplaceable appearances still has a first element —
  // and taking it would report a chapter outside the built book as where the
  // entity first appears. That is precisely the defect the ordering fix closed
  // at the port level; repeating the check here is deliberate, because this is
  // the layer that names the value "first appearance".
  const firstAppearance = input.ascending.find(entry => entry.orderExclusion === undefined);
  const latestAppearance = input.descending.find(entry => entry.orderExclusion === undefined);

  return {
    entity,
    ...(input.type === undefined ? {} : { type: input.type }),
    explicitFacts,
    otherNames,
    ...(firstAppearance === undefined ? {} : { firstAppearance }),
    ...(latestAppearance === undefined ? {} : { latestAppearance }),
    recentAppearances: [...input.descending],
    chapterSpread: [...input.chapterSpread],
    chapterCount: input.chapterSpread.length,
    relations: [...input.relations],
    indexState: input.indexState
  };
}
