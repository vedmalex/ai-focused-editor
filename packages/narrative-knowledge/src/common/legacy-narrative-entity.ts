/**
 * The bridge between the entity shape this package owns and the pre-rename
 * transport shape (TASK-022 WP-1, tech_spec ОВ-5).
 *
 * `LegacyNarrativeEntity` is THIS PACKAGE'S OWN declaration of that shape, not
 * an import of it. Importing it from the consumer package would create the
 * package cycle prohibition (f) exists to prevent — and the build chain, a hand
 * ordered sequence, has no position that is both before and after that package.
 *
 * WHY A BRIDGE AT ALL RATHER THAN DUAL-NAMED FIELDS. `kind`/`label`/`uri` are
 * GONE from {@link NarrativeEntity}, not deprecated aliases of the new names. A
 * type carrying both spellings lets a consumer nobody migrated keep reading the
 * old field and keep COMPILING, and then neither `tsc` nor any characterization
 * test can distinguish "ported" from "forgotten". An explicit, obviously-lossy
 * conversion at a named seam does distinguish them.
 *
 * WHAT THE CONVERSION LOSES, AND ALL IT LOSES: `origin` and `evidence`. The old
 * shape has nowhere to put either, so a round trip through it returns an entity
 * whose provenance has collapsed to the default and whose evidence is gone.
 * That is asserted explicitly in the tests rather than left to be discovered.
 *
 * `toLegacyNarrativeEntity` exists ONLY for the frozen list of thin adapters in
 * WP-7. If that list turns out to be empty, this function and the type go with
 * it — that is WP-7's call, not this file's.
 */

import type { NarrativeEntity } from './graph';
import { DEFAULT_NARRATIVE_ORIGIN } from './graph';
import type { NarrativeEntityKindFromRegistry } from './entity-type-registry';

/**
 * The entity shape as it was before the rename: `kind`/`label`/`uri` where this
 * package now says `type`/`name`/`sourceUri`, `path` where it says
 * `sourcePath`, and no provenance or evidence at all.
 *
 * `kind` keeps the registry-derived literal union rather than widening to
 * `string`, because that is what the shape being mirrored declares — at runtime
 * it may hold any author-declared type id, and the seam that produces it casts.
 */
export interface LegacyNarrativeEntity {
  kind: NarrativeEntityKindFromRegistry;
  id: string;
  label: string;
  path: string;
  uri: string;
  summary?: string;
  aliases: string[];
  epithets?: string[];
  backstory?: string;
  arc?: string;
  speechPatterns?: string[];
  notes?: string;
}

/**
 * Read a legacy entity as a {@link NarrativeEntity}.
 *
 * `origin` becomes {@link DEFAULT_NARRATIVE_ORIGIN} — the legacy shape predates
 * provenance entirely, so every value in it is something the author wrote.
 * `evidence` is left absent rather than synthesised from `path`: inventing a
 * whole-file pointer here would make "this entity has evidence" true for
 * entities nobody ever recorded evidence for, which is precisely the kind of
 * silently-plausible value this task exists to eliminate.
 */
export function toNarrativeEntity(legacy: LegacyNarrativeEntity): NarrativeEntity {
  return {
    id: legacy.id,
    type: legacy.kind,
    name: legacy.label,
    sourcePath: legacy.path,
    sourceUri: legacy.uri,
    origin: DEFAULT_NARRATIVE_ORIGIN,
    aliases: legacy.aliases,
    ...(legacy.summary !== undefined ? { summary: legacy.summary } : {}),
    ...(legacy.epithets !== undefined ? { epithets: legacy.epithets } : {}),
    ...(legacy.backstory !== undefined ? { backstory: legacy.backstory } : {}),
    ...(legacy.arc !== undefined ? { arc: legacy.arc } : {}),
    ...(legacy.speechPatterns !== undefined ? { speechPatterns: legacy.speechPatterns } : {}),
    ...(legacy.notes !== undefined ? { notes: legacy.notes } : {})
  };
}

/**
 * Render a {@link NarrativeEntity} in the legacy shape.
 *
 * LOSSY BY CONSTRUCTION: `origin` and `evidence` have nowhere to go. The cast
 * on `type` is the honest one — the legacy declaration narrows to the built-in
 * type ids while both shapes have always carried author-declared ids at
 * runtime.
 */
export function toLegacyNarrativeEntity(entity: NarrativeEntity): LegacyNarrativeEntity {
  return {
    kind: entity.type as NarrativeEntityKindFromRegistry,
    id: entity.id,
    label: entity.name,
    path: entity.sourcePath,
    uri: entity.sourceUri,
    aliases: entity.aliases,
    ...(entity.summary !== undefined ? { summary: entity.summary } : {}),
    ...(entity.epithets !== undefined ? { epithets: entity.epithets } : {}),
    ...(entity.backstory !== undefined ? { backstory: entity.backstory } : {}),
    ...(entity.arc !== undefined ? { arc: entity.arc } : {}),
    ...(entity.speechPatterns !== undefined ? { speechPatterns: entity.speechPatterns } : {}),
    ...(entity.notes !== undefined ? { notes: entity.notes } : {})
  };
}
