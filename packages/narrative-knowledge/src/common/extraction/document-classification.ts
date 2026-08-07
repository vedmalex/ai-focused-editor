/**
 * Which files the index reads, and — just as importantly — which it does NOT
 * (TASK-022 WP-2; fifth kind added by gh#48 WP-3).
 *
 * FIVE KINDS, AND THE FOURTH-KIND DECISION WAS REVERSED IN THE OPEN. The union
 * itself is {@link NarrativeDocumentKind}, declared ONCE beside the storage port
 * in `graph/narrative-index-store.ts` and imported here — this module DECIDES
 * which kind a path is, it does not get a second opinion about what the kinds
 * are.
 *
 * This header used to read "FOUR KINDS, AND THE ENUM GAINS NO FIFTH", on the
 * reasoning that no source in scope needed a new member: a front-matter mention
 * lives in the chapter FILE, so it was a new place and not a new document. That
 * reasoning still holds for front-matter, and it does NOT hold for an event. An
 * event lives in its own file, has its own identity, its own references and its
 * own order, and there is no existing document it could be a "new place" inside
 * of. So the decision is reversed rather than worked around — the alternative on
 * offer was a second loader beside the index, which would have duplicated the
 * freshness machinery and been unable to say "I am rebuilding" honestly.
 *
 * THE INVARIANT THAT SURVIVES IS THE IMPORTANT ONE. `knowledge/**` stays
 * invisible to the index EXCEPT for `knowledge/timeline/*.yaml`, strictly with
 * no nested directories, and that boundary is written down HERE — where
 * classification happens — instead of being inferred from precedent by whoever
 * adds the next thing under `knowledge/`. Everything else under `knowledge/` —
 * AI candidates, decision journals, run logs, scene plans — remains unread, and
 * gh#50 and gh#52 depend on exactly that.
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

/** The directory holding everything the index deliberately does NOT read. */
export const KNOWLEDGE_DIRECTORY = 'knowledge';

/** The ONE readable directory under {@link KNOWLEDGE_DIRECTORY} (gh#48). */
export const TIMELINE_DIRECTORY = 'knowledge/timeline';

/**
 * Whether a path is a timeline file — the fifth kind's whole boundary.
 *
 * STRICTLY ONE LEVEL DEEP. `knowledge/timeline/nested/dir/x.yaml` is NOT a
 * timeline file, for the same reason a card must sit directly in
 * `entities/<directory>/`: an author who files their own material in a
 * subdirectory has not asked the index to read it, and an arbitrary-depth rule
 * would sweep it in. `knowledge/timeline.yaml` is not one either — the
 * directory, not the word, is the boundary.
 *
 * EXPORTED BECAUSE THE WALK NEEDS THE SAME ANSWER, not because a second caller
 * turned up. See {@link narrativeIndexMayReadUnder}: two independent spellings
 * of one boundary are two things to keep in step, and this package has already
 * paid for that once (`buildIncluded` vs `manifestIncluded`).
 */
export function isTimelineDocumentPath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  const prefix = `${TIMELINE_DIRECTORY}/`;
  if (!normalized.startsWith(prefix)) {
    return false;
  }
  const leaf = normalized.slice(prefix.length);
  return leaf.length > 0 && !leaf.includes('/') && /\.ya?ml$/i.test(leaf);
}

/**
 * Whether the disk walk should even OPEN this file (gh#48, F-12).
 *
 * THE WALK'S QUESTION, ANSWERED BY THE CLASSIFICATION MODULE. The disk walk is
 * documented as deliberately liberal — it gathers every plausibly-narrative file
 * so that "the pipeline produces nothing from these" is a statement about the
 * PIPELINE and not about a filter upstream (`narrative-workspace-scan.ts`). That
 * stays true for `sources/**`, which still arrives and is still refused.
 *
 * `knowledge/**` IS THE ONE EXEMPTION, and it is a cost decision with a named
 * payer. Under `knowledge/` live gh#50's `decisions.jsonl` and gh#52's per-run
 * candidate journals — append-only files whose `mtime` moves on EVERY write, so
 * the `(size, mtime)` prefilter misses them by construction and each sweep pays
 * a full read and SHA-256 for a file that can never become a document. Reading
 * them to refuse them is a real bill for a foregone conclusion.
 *
 * IT ANSWERS ABOUT FILES, AND DIRECTORIES ARE NOT PRUNED. The walk still
 * descends into `knowledge/**` and still `stat`s what it finds; what it skips is
 * the READ and the SHA-256, which is the entire cost F-12 names. Pruning whole
 * directories would save one `readdir` per journal folder and cost something
 * far more valuable, as this work package found out by measuring it: with
 * `knowledge/timeline/nested/` pruned, a `classifyDocument` MUTATED to accept
 * nested files stayed green end to end, because the file it wrongly accepted
 * never arrived. That is the "green by coincidence" shape this package exists to
 * refuse — a second guard upstream making the first one's failure invisible. One
 * guard, at the file, is worth more than two that hide each other.
 *
 * ONE RULE, TWO CONSUMERS. Both walks (`scanWorkspaceFiles` and
 * `NodeNarrativeWorkspaceSource.stat`) call THIS function, so the set a rebuild
 * sees and the set a sweep sees stay identical by construction.
 *
 * IT IS DERIVED FROM {@link isTimelineDocumentPath}, not written a second time:
 * "the index may read it" and "the index classifies it" have to agree, and the
 * only way to guarantee that is to ask the same function.
 */
export function narrativeIndexMayReadUnder(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  if (normalized !== KNOWLEDGE_DIRECTORY && !normalized.startsWith(`${KNOWLEDGE_DIRECTORY}/`)) {
    return true;
  }
  return isTimelineDocumentPath(normalized);
}

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
 * `sources/citations.yaml`, `sources/excerpts.jsonl`, everything under
 * `knowledge/` OTHER than `knowledge/timeline/*.yaml`, build output, and
 * everything else in a manuscript that is not one of the five kinds. It is a
 * DECISION, not an oversight: see the header.
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
 *
 * A TIMELINE FILE IS `knowledge/timeline/<name>.yaml`, ONE LEVEL DEEP — see
 * {@link isTimelineDocumentPath} for why the depth is part of the rule and not a
 * detail of the regular expression.
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

  if (isTimelineDocumentPath(normalized)) {
    return { kind: 'timeline' };
  }

  return undefined;
}
