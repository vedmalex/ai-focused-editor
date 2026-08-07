/**
 * `manifest.yaml`: chapter ORDER, and the absence that means "not a manuscript"
 * (TASK-022 WP-2).
 *
 * THE MANIFEST IS THE ONLY CHAPTER ORDER THERE IS. `document.chapter_order` is
 * nullable precisely because a `.md` file outside the manifest has no position,
 * and the index must be able to say so rather than invent one from a directory
 * listing.
 *
 * ABSENT IS NOT AN ERROR, AND THAT DISTINCTION IS LOAD-BEARING. A workspace
 * with no `manifest.yaml` is not a broken manuscript, it is not a manuscript:
 * the plan says the index is not built, the database file is not created, and
 * `getIndexStatus()` answers `{ state:'absent', cause:'no-manuscript' }` —
 * which is a different branch from `failed`, and consumers must not present it
 * as a problem. That is why {@link ManuscriptManifest.present} is a separate
 * flag and not "an empty chapter list", and why a MALFORMED manifest reports a
 * problem while a MISSING one reports none.
 *
 * THE WALK IS THE ONE ALREADY IN THE TREE. Leaf `.md`/`.mdx` entries in depth
 * first order, `include: false` inherited by children, title falling back to
 * the file name — byte-identical to `NodeNarrativeGraphService.collectChapters`
 * (`node-narrative-graph-service.ts:206-228`), because the timeline this index
 * replaces is ordered by exactly that walk and a different order would silently
 * renumber every chapter.
 */

import { parse as parseYaml } from 'yaml';
import { asString, isRecord, normalizeWorkspacePath } from './yaml-values';

/** One chapter file, as the manifest orders it. */
export interface ManifestChapter {
  /** Workspace-relative path, forward slashes, no leading `./`. */
  path: string;
  /** Display title; the file name when the entry states none. */
  title: string;
  /** Zero-based position in the manifest walk. `document.chapter_order`. */
  order: number;
  /**
   * Whether the chapter is part of the built book.
   *
   * INHERITED: an `include: false` on a part excludes everything under it, so a
   * chapter can be excluded without saying so itself.
   */
  buildIncluded: boolean;
}

/** Machine-readable code for each way a manifest can fail to order chapters. */
export type ManifestProblemCode =
  /** The YAML failed to parse. */
  | 'invalid-yaml'
  /** The document parsed but has no `content:` list to walk. */
  | 'invalid-shape';

/** One problem found while reading `manifest.yaml`. */
export interface ManifestProblem {
  code: ManifestProblemCode;
  /** Human-readable, English. Localisation happens at the presentation layer. */
  message: string;
}

/** What `manifest.yaml` says, and whether it exists at all. */
export interface ManuscriptManifest {
  /**
   * Whether a manifest was present.
   *
   * `false` means NOT A MANUSCRIPT — `cause: 'no-manuscript'`, not an error.
   * A present-but-broken manifest is `true` with a problem.
   */
  present: boolean;
  /** Chapters in manifest order. Empty when absent or unwalkable. */
  chapters: ManifestChapter[];
  problems: ManifestProblem[];
}

/** The answer for a workspace with no `manifest.yaml`. */
const ABSENT_MANIFEST: ManuscriptManifest = { present: false, chapters: [], problems: [] };

function walk(entries: readonly unknown[], parentIncluded: boolean, into: ManifestChapter[]): void {
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const path = asString(entry.path);
    if (!path) {
      continue;
    }
    const included = parentIncluded && entry.include !== false;
    if (/\.mdx?$/i.test(path)) {
      const normalized = normalizeWorkspacePath(path);
      into.push({
        path: normalized,
        title: asString(entry.title) || normalized.slice(normalized.lastIndexOf('/') + 1),
        order: into.length,
        buildIncluded: included
      });
    }
    if (Array.isArray(entry.children)) {
      walk(entry.children, included, into);
    }
  }
}

/**
 * Read `manifest.yaml`. Pure: text in, chapter order out, never throws.
 *
 * `undefined` means THE FILE IS NOT THERE — the caller that could not read it
 * says so by passing nothing, rather than by passing `''`, which is a real
 * (empty, therefore unwalkable) manifest and a different answer.
 */
export function extractManifestChapters(text: string | undefined): ManuscriptManifest {
  if (text === undefined) {
    return ABSENT_MANIFEST;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    return {
      present: true,
      chapters: [],
      problems: [{
        code: 'invalid-yaml',
        message: `Invalid manifest.yaml: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.content)) {
    return {
      present: true,
      chapters: [],
      problems: [{ code: 'invalid-shape', message: 'manifest.yaml has no content list to walk.' }]
    };
  }

  const chapters: ManifestChapter[] = [];
  walk(parsed.content, true, chapters);
  return { present: true, chapters, problems: [] };
}
