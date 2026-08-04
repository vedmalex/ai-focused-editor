/**
 * The incremental update, as pure functions (TASK-022 WP-4b, tech_spec ОВ-3).
 *
 * WHAT IS HERE AND WHY IT IS SEPARATE FROM BOTH ITS NEIGHBOURS. The maintainer
 * owns timers, the guard and the config; the session owns the store and the
 * state. Between them sits a body of decisions that is neither — how a batch of
 * watcher events folds into three sets, which delete pairs with which add, and
 * what an update is allowed to do incrementally at all. Every one of those is a
 * function from data to data, so it is testable without a clock, without a
 * store, and without a promise.
 *
 * THE ONE DECISION IN THIS FILE THAT IS NOT IN THE TECH SPEC, STATED PLAINLY.
 * tech_spec ОВ-3 describes a batch as if every change were incrementally
 * applicable. It is not, and WP-4a already said why in its own header:
 * extraction is WORKSPACE-LEVEL — resolvedness needs every card, duplicate
 * detection needs every card — and the index stores no text, so there is nothing
 * to re-resolve a skipped chapter's mentions FROM. A card added, changed or
 * removed can flip a `[[char:x]]` from broken to resolved in a chapter nobody
 * touched, and no amount of cleverness recovers that without re-reading the
 * prose. So this file draws the line where the data draws it:
 *
 *   - a CHAPTER changed, added or removed  -> genuinely incremental;
 *   - a paired MOVE of anything            -> incremental (bytes identical);
 *   - a CARD, the MANIFEST or `types.yaml` -> ESCALATES to a full rebuild;
 *   - a file the index does not read       -> IGNORED entirely.
 *
 * The escalation is REPORTED ({@link NarrativeUpdateReport.mode}) rather than
 * hidden, so a later work package that narrows it can prove it narrowed
 * something, and so a test can tell "the index is right" from "the index is
 * right because it quietly rebuilt everything".
 */

import { classifyDocument, ENTITY_TYPES_PATH, MANIFEST_PATH } from './extraction/document-classification';
import type { ManifestChapter } from './extraction/manifest-extraction';
import { normalizeWorkspacePath } from './extraction/yaml-values';
import type { EffectiveEntityType } from './entity-type-registry';
import type { IndexedDocument } from './graph';
import type { NarrativeFileChange } from './narrative-file-watcher';
import type { IndexableFile, NarrativeRebuildReport } from './narrative-index-session';

/** What the batch became after `path` collisions were resolved. */
export interface FoldedFileChanges {
  added: string[];
  updated: string[];
  deleted: string[];
}

/**
 * Fold a batch by path, LAST EVENT WINNING (ОВ-3 step 1).
 *
 * LAST WINS, AND THE ORDER IS THE ARRIVAL ORDER. A file created and then deleted
 * inside one window is a deletion; deleted and then re-created is an addition.
 * Any other rule would have to invent a story about what happened in between.
 *
 * ONE EXCEPTION, AND IT IS THE ONE THAT MATTERS: `deleted` followed by `added`
 * for the SAME path is an UPDATE, not an addition. Editors that write by
 * rename-over (which is most of them, and it is how atomic saves work) produce
 * exactly that pair, and treating it as an addition would drop the document row
 * and renumber its `docId` on every single save.
 */
export function foldFileChanges(changes: readonly NarrativeFileChange[]): FoldedFileChanges {
  const state = new Map<string, { type: NarrativeFileChange['type']; wasDeleted: boolean }>();
  for (const change of changes) {
    const path = normalizeWorkspacePath(change.path);
    const previous = state.get(path);
    const wasDeleted = previous?.wasDeleted === true || previous?.type === 'deleted';
    state.set(path, {
      type: change.type === 'added' && wasDeleted ? 'updated' : change.type,
      wasDeleted: wasDeleted || change.type === 'deleted'
    });
  }
  const folded: FoldedFileChanges = { added: [], updated: [], deleted: [] };
  for (const [path, entry] of state) {
    folded[entry.type === 'added' ? 'added' : entry.type === 'deleted' ? 'deleted' : 'updated'].push(path);
  }
  for (const list of [folded.added, folded.updated, folded.deleted]) {
    list.sort(byCodePoint);
  }
  return folded;
}

/** One inferred move: an old path, and the file that now holds its bytes. */
export interface PairedMove {
  from: string;
  to: IndexableFile;
}

export interface PairingResult {
  moves: PairedMove[];
  /** Deleted paths that paired with nothing. */
  unpairedDeletes: string[];
  /** Added files that paired with nothing. */
  unpairedAdds: IndexableFile[];
}

/**
 * Pair deletes with adds by `contentHash` (ОВ-3 step 4).
 *
 * THE KEY IS THE HASH AND NOT THE NAME, and that choice is the whole content of
 * ОВ-3's second tooth. If the pairing key were the basename, a file moved AND
 * edited in one window would still pair, the rename would be applied without
 * re-extraction, and the index would keep the OLD text's mentions under the new
 * path — wrong, and invisible. Keyed by hash, a move-with-edit simply does not
 * pair: it becomes a delete plus an add, the add is extracted, and the answer is
 * right at the cost of one extraction.
 *
 * THE TIE-BREAK IS DETERMINISTIC AND ALSO IRRELEVANT, and both halves are true.
 * Two files with the same hash have IDENTICAL payloads, so any pairing of them
 * yields the same index — which is precisely why the hash was chosen as the key.
 * The rule (basename match first, then path order) exists so two runs over the
 * same batch produce the same `docId` assignment, not because one pairing is
 * more correct than another.
 *
 * A DELETE'S HASH COMES FROM THE STILL-EXISTING DOCUMENT ROW, because the file
 * is already gone and cannot be read. That is why ОВ-3 applies deletions LAST.
 */
export function pairMovedDocuments(
  deleted: readonly IndexedDocument[],
  added: readonly IndexableFile[]
): PairingResult {
  const addsByHash = new Map<string, IndexableFile[]>();
  for (const file of added) {
    const bucket = addsByHash.get(file.contentHash) ?? [];
    bucket.push(file);
    addsByHash.set(file.contentHash, bucket);
  }
  const claimed = new Set<string>();
  const moves: PairedMove[] = [];
  const unpairedDeletes: string[] = [];

  // Deletes in path order, so the pairing does not depend on the order the
  // watcher happened to report them in.
  for (const document of [...deleted].sort((left, right) => byCodePoint(left.relPath, right.relPath))) {
    const candidates = (addsByHash.get(document.contentHash) ?? []).filter(file => !claimed.has(file.path));
    if (candidates.length === 0) {
      unpairedDeletes.push(document.relPath);
      continue;
    }
    const wantedBase = basename(document.relPath);
    const chosen =
      candidates.find(file => basename(file.path) === wantedBase) ??
      [...candidates].sort((left, right) => byCodePoint(left.path, right.path))[0]!;
    claimed.add(chosen.path);
    moves.push({ from: document.relPath, to: chosen });
  }

  return {
    moves,
    unpairedDeletes,
    unpairedAdds: added.filter(file => !claimed.has(file.path))
  };
}

/**
 * Whether one changed path forces a FULL rebuild.
 *
 * `undefined` classification means the index does not read the file at all —
 * `sources/citations.yaml`, `sources/excerpts.jsonl`, `knowledge/**`, build
 * output — and such a change is ignored rather than escalated. That is the same
 * boundary ОВ-1's tooth B12 draws, applied to the incremental path: a file that
 * produces nothing on a rebuild must also cost nothing on an edit, or every save
 * of a citation file would rebuild the manuscript.
 */
export function changeForcesRebuild(path: string, types: readonly EffectiveEntityType[]): boolean {
  const normalized = normalizeWorkspacePath(path);
  if (normalized === MANIFEST_PATH || normalized === ENTITY_TYPES_PATH) {
    return true;
  }
  const classification = classifyDocument(normalized, types);
  if (classification === undefined) {
    return false;
  }
  // A card is the workspace-level case: its id decides what resolves ANYWHERE.
  return classification.kind !== 'chapter';
}

/** Whether the index reads this path at all. */
export function isIndexablePath(path: string, types: readonly EffectiveEntityType[]): boolean {
  return classifyDocument(normalizeWorkspacePath(path), types) !== undefined;
}

/** Everything one incremental pass is asked to write. Already read, so the
 *  session that applies it needs no filesystem — the WP-4a arrangement. */
export interface IndexUpdatePlan {
  /** Renames to apply first, before anything else can collide with them. */
  moves: PairedMove[];
  /** Files to (re)index. Their freshness key decides whether they really are. */
  upsert: IndexableFile[];
  /** Documents to drop. */
  remove: string[];
  /** Effective entity types, for classification and the resolution catalog. */
  types: readonly EffectiveEntityType[];
  /** Manifest chapters, for `chapterOrder` on moved and new documents. */
  chapters: readonly ManifestChapter[];
  /** Paths that were supposed to be readable and were not (ОВ-6). */
  unreadable: string[];
}

/** What one maintenance pass did. Every field is something a test can assert. */
export interface NarrativeUpdateReport {
  /** `incremental` or the escalation to a full rebuild, stated out loud. */
  mode: 'incremental' | 'rebuild';
  /** Documents whose content was re-extracted this pass. */
  documentsReindexed: string[];
  /** Documents dropped. */
  documentsRemoved: string[];
  /** Renames applied without re-extraction. */
  documentsMoved: { from: string; to: string }[];
  /** Documents offered whose freshness key proved them identical. */
  unchangedDocuments: string[];
  /** Mention rows written this pass. */
  mentionsWritten: number;
  /** Derived (co-occurrence) relations after the recompute. */
  derivedRelations: number;
  /** Paths whose read failed — the input to `stale/partial-update-failed`. */
  unreadableDocuments: string[];
  /**
   * The full rebuild's own report, present exactly when `mode` is `rebuild`.
   *
   * Carried rather than flattened: a rebuild counts entities, duplicates and
   * relation sources that an increment has no equivalent for, and folding them
   * into the fields above would either lose them or make those fields mean two
   * different things depending on `mode`.
   */
  rebuild?: NarrativeRebuildReport;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Code-point order — see ISS-349; never `localeCompare`. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
