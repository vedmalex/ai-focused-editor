/**
 * The whole extraction, as one pure function (TASK-022 WP-2).
 *
 * WHAT IT IS. `(files) -> (entities, mentions, relations, chapters, problems)`.
 * No filesystem, no URI construction, no Theia, no clock, no randomness: the
 * caller reads the workspace and hands over text, and everything from there is
 * deterministic. That is not a stylistic preference — prohibitions (a) and (c)
 * enforce it mechanically over `src/common`, and it is what lets the whole
 * index be exercised under plain `bun test` with a hand-written file list.
 *
 * WHY A WORKSPACE-LEVEL ENTRY POINT AND NOT ONLY PER-DOCUMENT ONES. Three of
 * the facts this task promises are not properties of any single document:
 * resolvedness needs every id the manuscript defines, duplicate detection needs
 * every card, and "these files produce NOTHING" (relation source 5) is only
 * observable at the level where all the files are present at once. A per
 * document function cannot state any of the three, so its tests cannot either.
 *
 * ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER:
 *
 *   1. `entities/types.yaml` — the EFFECTIVE type list decides which
 *      directories hold cards, so nothing can be classified before it;
 *   2. classify every file — sources 5's files fall out HERE, by classifying
 *      as nothing, and never reach an extractor at all;
 *   3. parse every card — entities exist, but no resolvedness yet;
 *   4. build the catalog — first card wins an id collision, losers reported;
 *   5. relations and mentions — both need the catalog to say what resolves.
 *
 * THE MANIFEST IS READ BUT NOT REQUIRED. Its absence means "not a manuscript"
 * and is reported as {@link ExtractedNarrativeIndex.manifestPresent} `false`;
 * deciding what to do about that (do not build, do not create the database,
 * answer `{ state:'absent', cause:'no-manuscript' }`) is the service's call, not
 * this function's — a pure extractor that refuses to extract is a pure
 * extractor nobody can test.
 */

import { BASE_ENTITY_TYPES, mergeEntityTypes, parseEntityTypesYaml } from '../entity-type-registry';
import type { EffectiveEntityType, EntityTypeProblem } from '../entity-type-registry';
import type { NarrativeEntity, NarrativeMention } from '../graph';
import { extractChapterMentions } from './chapter-extraction';
import { classifyDocument, ENTITY_TYPES_PATH, MANIFEST_PATH } from './document-classification';
import { buildEntityCatalog, type EntityDuplicate } from './entity-catalog';
import {
  extractCardRelations,
  parseEntityCard,
  type EntityCardProblem,
  type ParsedEntityCard
} from './entity-card-extraction';
import type { ExtractedRelation } from './extracted-relation';
import { extractManifestChapters, type ManifestChapter, type ManifestProblem } from './manifest-extraction';
import { normalizeWorkspacePath } from './yaml-values';

/** One file of the workspace, as the extraction sees it. */
export interface WorkspaceFile {
  /** Workspace-relative path. */
  path: string;
  /**
   * URI of the same file, for the entity rows that carry one.
   *
   * OPTIONAL because only entity cards need it. A caller indexing chapters
   * alone has nothing to supply and should not have to invent a string.
   */
  uri?: string;
  /** Raw file text. */
  text: string;
}

/** Everything one workspace yields. */
export interface ExtractedNarrativeIndex {
  /** The effective type list: built-ins plus author types, in that order. */
  effectiveTypes: EffectiveEntityType[];
  /** Whether `manifest.yaml` was present. `false` means: not a manuscript. */
  manifestPresent: boolean;
  /** Chapters in manifest order. Empty when there is no usable manifest. */
  chapters: ManifestChapter[];
  /** One entity per id — the first card in input order wins a collision. */
  entities: NarrativeEntity[];
  /** Every card excluded by an id collision. */
  duplicates: EntityDuplicate[];
  /** Every mention, chapter by chapter, in the order the chapters were given. */
  mentions: NarrativeMention[];
  /** Every relation (sources 2 and 3). Never from `sources/**` — see source 5. */
  relations: ExtractedRelation[];
  /** `entities/types.yaml` validation problems. */
  typeProblems: EntityTypeProblem[];
  /** Malformed entity cards. */
  cardProblems: EntityCardProblem[];
  /** Malformed `manifest.yaml`. Empty when the manifest is merely absent. */
  manifestProblems: ManifestProblem[];
}

/**
 * Resolve the EFFECTIVE entity types, with BOTH outputs.
 *
 * Both, always: a caller that takes the types and drops the problems has
 * silently accepted a `types.yaml` the author got wrong, and the author is the
 * only one who can fix it. `undefined` text means the file is absent — a
 * manuscript with no author types, which is not a problem.
 */
export function resolveEffectiveEntityTypes(
  text: string | undefined
): { types: EffectiveEntityType[]; problems: EntityTypeProblem[] } {
  const parsed = parseEntityTypesYaml(text ?? '');
  return { types: mergeEntityTypes(BASE_ENTITY_TYPES, parsed.types), problems: parsed.problems };
}

/** Extract everything the index holds from a set of workspace files. */
export function extractNarrativeIndex(files: readonly WorkspaceFile[]): ExtractedNarrativeIndex {
  const byPath = new Map(files.map(file => [normalizeWorkspacePath(file.path), file]));

  const { types: effectiveTypes, problems: typeProblems } =
    resolveEffectiveEntityTypes(byPath.get(ENTITY_TYPES_PATH)?.text);
  const manifest = extractManifestChapters(byPath.get(MANIFEST_PATH)?.text);

  const cards: ParsedEntityCard[] = [];
  const chaptersToScan: { path: string; text: string }[] = [];
  const cardProblems: EntityCardProblem[] = [];

  for (const file of files) {
    const path = normalizeWorkspacePath(file.path);
    const classification = classifyDocument(path, effectiveTypes);
    if (classification === undefined) {
      // Source 5 lands here, and so does everything else out of scope. No
      // extractor is called, so there is no path by which such a file could
      // contribute an entity, a mention or a relation.
      continue;
    }
    if (classification.kind === 'entity-card') {
      const result = parseEntityCard(
        { path, uri: file.uri ?? '', text: file.text },
        classification.type
      );
      cardProblems.push(...result.problems);
      if (result.card !== undefined) {
        cards.push(result.card);
      }
      continue;
    }
    if (classification.kind === 'chapter') {
      chaptersToScan.push({ path, text: file.text });
    }
  }

  const { catalog, entities, duplicates } = buildEntityCatalog(cards.map(card => card.entity), effectiveTypes);
  const keptPaths = new Set(entities.map(entity => entity.sourcePath));

  const relations: ExtractedRelation[] = [];
  for (const card of cards) {
    // A card that LOST an id collision contributes no relations either. Its
    // entity is not in the index, so a relation owned by it would name a
    // `sourceId` the index does not hold — a broken end manufactured by the
    // extractor rather than found in the manuscript.
    if (!keptPaths.has(card.document.path)) {
      continue;
    }
    relations.push(...extractCardRelations(card, catalog));
  }

  const mentions: NarrativeMention[] = [];
  for (const chapter of chaptersToScan) {
    mentions.push(...extractChapterMentions(chapter, catalog));
  }

  return {
    effectiveTypes,
    manifestPresent: manifest.present,
    chapters: manifest.chapters,
    entities,
    duplicates,
    mentions,
    relations,
    typeProblems,
    cardProblems,
    manifestProblems: manifest.problems
  };
}
