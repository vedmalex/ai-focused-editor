/**
 * The catalog that decides whether a reference RESOLVES (TASK-022 WP-2,
 * ISS-319).
 *
 * TWO JOBS, AND THEY ARE THE SAME JOB. Duplicate-id detection and
 * resolvedness are both "which ids does this manuscript actually define", asked
 * once from the writing side and once from the reading side. Building them
 * together is what guarantees they agree: a card excluded as a duplicate must
 * not silently keep resolving references, and a card that resolves references
 * must be a card the index really holds.
 *
 * WHY RESOLVEDNESS IS COMPUTED HERE AND NOT LEFT TO THE STORE (ISS-319). Today
 * `readOwnership` resolves an unknown owner id as
 * `labels.byId.get(owner) ?? owner` (`node-narrative-graph-service.ts:353`) —
 * a missing entity silently becomes its own display label, and the broken link
 * is indistinguishable from a working one at every layer above. Reproducing
 * that fallback is FORBIDDEN by the plan. The replacement is a flag computed
 * once, from a catalog that knows what exists, and carried on the value.
 *
 * DUPLICATES: FIRST CARD WINS, LOSER IS REPORTED. The two live precedents
 * disagree — `NodeAiModeRegistryService.parseModes` keeps a `seen` set and
 * emits a diagnostic (`node-domain-knowledge-service.ts:887-923`), while
 * `readEntityDirectory` inserts unconditionally. The plan names the FIRST as
 * the pattern to follow, and the schema agrees: `entity.entity_id` is a PRIMARY
 * KEY and `entity_duplicate` is a table of the losers, so "insert both" is not
 * representable at all.
 */

import type { EntityTypeDescriptor } from '../entity-type-registry';
import type { NarrativeEntity } from '../graph';

/**
 * One entity card that lost an id collision.
 *
 * It is REPORTED, not dropped-and-forgotten: the manuscript has two files
 * claiming one id, which is a defect the author has to see, and the index has
 * exactly one row to give it (`entity_duplicate`, tech_spec ОВ-1).
 *
 * DELIBERATELY NOT `DuplicateEntityRecord` (the store port's shape, WP-3). That
 * one groups an id with EVERY path that defines it, which is what a reader
 * wants; this one names the card that was EXCLUDED and the card that took its
 * place, which only the extraction knows and which the storage shape throws
 * away. Collapsing them would lose that, and the direction of the loss is the
 * one that matters: "which of the two is in the index" is the first question
 * the author will ask.
 */
export interface EntityDuplicate {
  /** The contested id. */
  entityId: string;
  /** Workspace-relative path of the card that was EXCLUDED. */
  sourcePath: string;
  /** Workspace-relative path of the card that is in the index. */
  keptSourcePath: string;
}

/**
 * What ids a manuscript defines, in the two spellings a reference can use.
 *
 * `taggedIds` holds `${tag}:${id}` under EVERY tag spelling of the owning type
 * — both the type id (`character:krishna`) and the type's `tagKind`
 * (`char:krishna`). That mirrors `EntityCardsWidget.buildMentionIndex`
 * (`entity-cards-widget.ts:203-214`), which indexes an entity under both, and
 * it is the reason `[[char:krishna]]` and `[[character:krishna]]` both resolve
 * today.
 */
export interface EntityCatalog {
  /** Every defined id, whatever its type — the key a bare `[[id]]` matches. */
  readonly ids: ReadonlySet<string>;
  /** `${tag}:${id}` for every defined entity under every tag spelling. */
  readonly taggedIds: ReadonlySet<string>;
}

/** The catalog plus the collision report that building it produced. */
export interface EntityCatalogResult {
  catalog: EntityCatalog;
  /** The entities the index keeps — one per id, first card in input order. */
  entities: NarrativeEntity[];
  /** Every card excluded by an id collision. Empty in a healthy manuscript. */
  duplicates: EntityDuplicate[];
}

/**
 * Fold entity cards into a catalog, reporting id collisions.
 *
 * `types` supplies the tag spellings; a card whose `type` names no descriptor
 * is still catalogued under its own type id, because an author type declared in
 * `entities/types.yaml` and an author type the caller forgot to pass are
 * indistinguishable here, and dropping the card would be the worse of the two
 * mistakes.
 */
export function buildEntityCatalog(
  entities: readonly NarrativeEntity[],
  types: readonly EntityTypeDescriptor[]
): EntityCatalogResult {
  const tagKindByTypeId = new Map(types.map(type => [type.id, type.tagKind]));

  const ids = new Set<string>();
  const taggedIds = new Set<string>();
  const kept: NarrativeEntity[] = [];
  const keptPathById = new Map<string, string>();
  const duplicates: EntityDuplicate[] = [];

  for (const entity of entities) {
    const keptPath = keptPathById.get(entity.id);
    if (keptPath !== undefined) {
      duplicates.push({ entityId: entity.id, sourcePath: entity.sourcePath, keptSourcePath: keptPath });
      continue;
    }
    keptPathById.set(entity.id, entity.sourcePath);
    kept.push(entity);
    ids.add(entity.id);
    taggedIds.add(`${entity.type}:${entity.id}`);
    const tagKind = tagKindByTypeId.get(entity.type);
    if (tagKind !== undefined) {
      taggedIds.add(`${tagKind}:${entity.id}`);
    }
  }

  return { catalog: { ids, taggedIds }, entities: kept, duplicates };
}

/** A catalog of nothing — every reference against it is unresolved. */
export const EMPTY_ENTITY_CATALOG: EntityCatalog = { ids: new Set(), taggedIds: new Set() };

/**
 * Whether a reference resolves to a card this manuscript defines.
 *
 * THE TWO RULES ARE DIFFERENT, AND THAT IS THE CONTRACT (plan WP-1, rule 2). A
 * reference WITHOUT a kind — the bare `[[id]]` form — is matched BY ID ALONE,
 * across every type. A reference WITH a kind must match that kind's card; a
 * `[[char:dharma]]` pointing at a TERM called `dharma` is a broken reference,
 * not a working one, and collapsing the two would hide it.
 */
export function isReferenceResolved(catalog: EntityCatalog, kind: string | undefined, id: string): boolean {
  return kind === undefined ? catalog.ids.has(id) : catalog.taggedIds.has(`${kind}:${id}`);
}

/**
 * Whether a RELATION END resolves.
 *
 * By id alone, always: `ownership.owner` and a mention inside a card both name
 * a bare id with no type beside it, so there is no kind to check even in
 * principle.
 */
export function isRelationEndResolved(catalog: EntityCatalog, id: string): boolean {
  return catalog.ids.has(id);
}
