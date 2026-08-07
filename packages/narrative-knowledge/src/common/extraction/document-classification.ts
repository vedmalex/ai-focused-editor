/**
 * Which files the index reads, and — just as importantly — which it does NOT
 * (TASK-022 WP-2).
 *
 * FOUR KINDS, AND THE ENUM GAINS NO FIFTH. The union itself is
 * {@link NarrativeDocumentKind}, declared ONCE beside the storage port in
 * `graph/narrative-index-store.ts` and imported here — this module DECIDES
 * which kind a path is, it does not get a second opinion about what the kinds
 * are. The plan is explicit that no source in scope needs a new member: a
 * front-matter mention lives in the chapter FILE, so it is a new place, not a
 * new document.
 *
 * SOURCE 5 IS THE ABSENCE THIS MODULE MAKES CHECKABLE. `sources/citations.yaml`
 * and `sources/excerpts.jsonl` are real files with real content, and they
 * connect a SOURCE to a PLACE IN THE MANUSCRIPT — never one entity to another.
 * `relation` models entity↔entity, so a citation stored there would arrive with
 * BOTH ends unresolved on EVERY row, and `relation_broken` — the mechanism
 * built to surface genuine defects — would fire on correct data and drown the
 * one finding it exists for (ISS-319). The honest answer is that they classify
 * as NOTHING and never reach extraction at all. Their real home is gh#52
 * (Research Mode) or an issue of their own; they are refused here, not
 * forgotten.
 *
 * CLASSIFICATION IS BY PATH, WHICH IS WHY IT NEEDS THE EFFECTIVE TYPES. An
 * author type declared in `entities/types.yaml` owns a directory
 * (`entities/<directory>/`), so what counts as an entity card is not knowable
 * from the built-in list alone.
 */

import type { EntityTypeDescriptor } from '../entity-type-registry';
import type { NarrativeDocumentKind } from '../graph';
import { normalizeWorkspacePath } from './yaml-values';

/** Workspace-relative path of the manuscript manifest. */
export const MANIFEST_PATH = 'manifest.yaml';

/** Workspace-relative path of the author entity-type declarations. */
export const ENTITY_TYPES_PATH = 'entities/types.yaml';

/** An entity-card classification, with the type whose directory it sits in. */
export interface EntityCardClassification {
  kind: 'entity-card';
  type: EntityTypeDescriptor;
}

/**
 * What one workspace-relative path is to the index, or `undefined` for
 * "nothing".
 *
 * The non-card branch is `Exclude<NarrativeDocumentKind, 'entity-card'>` rather
 * than a re-spelled list of three literals: a fifth document kind added to the
 * port would then have to be handled HERE, visibly, instead of quietly failing
 * to be classifiable.
 */
export type DocumentClassification =
  | { kind: Exclude<NarrativeDocumentKind, 'entity-card'> }
  | EntityCardClassification;

/**
 * Classify one workspace-relative path.
 *
 * `undefined` means the index does not read this file — the answer for
 * `sources/citations.yaml`, `sources/excerpts.jsonl`, `knowledge/**`, build
 * output, and everything else in a manuscript that is not one of the four
 * kinds. It is a DECISION, not an oversight: see the header.
 *
 * A card is recognised by sitting DIRECTLY in `entities/<directory>/` — a
 * nested subdirectory is not a card, because nothing in the repository writes
 * one there and treating an arbitrary depth as cards would sweep in whatever an
 * author files under `entities/` for their own reasons.
 *
 * A CHAPTER IS A MARKDOWN FILE UNDER `content/`, NOT "A FILE THE MANIFEST
 * LISTS". Those are two different questions and the schema keeps them apart:
 * `document.chapter_order` is NULLABLE precisely so a `content/` chapter the
 * manifest omits is still INDEXED (its mentions are real) while having no
 * position. Classifying by manifest membership instead would make such a file
 * invisible, and would also make classification depend on a second file. The
 * prefix is what excludes `sources/documents/*.md` and `knowledge/**` — real
 * markdown that is not manuscript prose.
 */
export function classifyDocument(
  path: string,
  types: readonly EntityTypeDescriptor[]
): DocumentClassification | undefined {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === MANIFEST_PATH) {
    return { kind: 'manifest' };
  }
  if (normalized === ENTITY_TYPES_PATH) {
    return { kind: 'entity-types' };
  }

  if (normalized.startsWith('entities/') && /\.ya?ml$/i.test(normalized)) {
    const segments = normalized.split('/');
    if (segments.length === 3) {
      const type = types.find(candidate => candidate.directory === segments[1]);
      if (type !== undefined) {
        return { kind: 'entity-card', type };
      }
    }
    return undefined;
  }

  if (normalized.startsWith('content/') && /\.mdx?$/i.test(normalized)) {
    return { kind: 'chapter' };
  }

  return undefined;
}
