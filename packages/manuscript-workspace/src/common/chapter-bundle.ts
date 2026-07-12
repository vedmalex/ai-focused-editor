/**
 * Pure (Theia-free) assembly of a chapter "working set" — the chapter plus the
 * knowledge/source material it references — so an author can attach a whole
 * chapter's context to the AI chat in one action.
 *
 * The bundle is derived purely from the chapter's Markdown text plus the
 * workspace citation/excerpt index; no filesystem or Theia access happens here,
 * which keeps the assembly rules unit-testable under `bun test`. The browser
 * contribution feeds in the text + snapshots and turns the returned items into
 * chat-context variable attachments.
 *
 * Assembly rules (see `buildChapterBundle`):
 *  - The chapter itself is always the FIRST item.
 *  - Entities come from the chapter's semantic tags (`[[kind:id|label]]` and the
 *    bare `[[id]]` form), unique by `kind`+`id`, in first-seen order, labeled
 *    with the tag label (falling back to the id).
 *  - Citations come from `[@cite:id]` occurrences, unique by id, in first-seen
 *    order, labeled with the citation title when the id is known.
 *  - Sources are the source files of the matched citations (a citation's `path`
 *    and the `sourcePath` of any excerpt tied to a matched citation) plus any
 *    `sources/…` path referenced directly in the prose. Unique by path.
 *  - Every item is de-duplicated by `variable`+`arg`; order is stable.
 */

import { extractEntityMentions } from './entity-mentions';
import { tagKindToEntityKind } from './entity-type-registry';
import type { CitationEntry, SourceExcerpt } from './source-library-protocol';

/** Which chat-context variable a bundle item attaches through. */
export type ChapterBundleVariable = 'chapter' | 'entity' | 'citation' | 'source';

/** One attachable member of a chapter working set. */
export interface ChapterBundleItem {
  /** Chat-context variable name this item resolves through. */
  variable: ChapterBundleVariable;
  /** Argument passed to the variable (chapter/source path, entity/citation id). */
  arg: string;
  /** Human-readable label for the multi-select row. */
  label: string;
  /** Secondary text (path or id) for the multi-select row. */
  detail?: string;
}

/** Inputs to {@link buildChapterBundle}. */
export interface ChapterBundleInput {
  /** Workspace-relative path of the chapter (the `#chapter` argument). */
  chapterPath: string;
  /** Display label for the chapter row; defaults to the path's base name. */
  chapterLabel?: string;
  /** Workspace citation index, used to label citations and find their sources. */
  citations?: readonly CitationEntry[];
  /** Workspace excerpt index, used to add the sources tied to matched citations. */
  excerpts?: readonly SourceExcerpt[];
}

/** `[@cite:id]` reference, mirroring the repo's citation link syntax. */
const CITE_PATTERN = /\[@cite:([^\]\s]+)\]/g;

/**
 * A `sources/…` file path referenced directly in prose (Markdown link target,
 * inline path, …). Requires a file extension so bare `sources/` folder mentions
 * and links to sub-pages without a file suffix do not match.
 */
const SOURCE_PATH_PATTERN = /(?:\.\/)?(sources\/[^\s)>\]"'`]+\.[A-Za-z0-9]+)/g;

/** Last path segment of a workspace-relative path. */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * Build an ordered, de-duplicated chapter working set from the chapter's text
 * and the workspace citation/excerpt indexes. See the module doc for the rules.
 */
export function buildChapterBundle(chapterText: string, input: ChapterBundleInput): ChapterBundleItem[] {
  const items: ChapterBundleItem[] = [];
  const seen = new Set<string>();

  const push = (item: ChapterBundleItem): void => {
    const arg = item.arg.trim();
    if (!arg) {
      return;
    }
    const key = `${item.variable}:${arg}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    items.push({ ...item, arg });
  };

  // 1. The chapter itself, always first.
  push({
    variable: 'chapter',
    arg: input.chapterPath,
    label: input.chapterLabel?.trim() || baseName(input.chapterPath),
    detail: input.chapterPath
  });

  // 2. Entities from the chapter's semantic tags (unique by kind+id, in order).
  for (const mention of extractEntityMentions(chapterText)) {
    const entityKind = mention.kind ? tagKindToEntityKind(mention.kind) : undefined;
    push({
      variable: 'entity',
      arg: mention.id,
      label: mention.label?.trim() || mention.id,
      detail: entityKind ? `${entityKind}:${mention.id}` : mention.id
    });
  }

  // 3. Citations from [@cite:id] occurrences (unique by id, in order). Collect
  //    the matched ids so their source files can be pulled into the sources set.
  const citationById = new Map<string, CitationEntry>(
    (input.citations ?? []).map(citation => [citation.id, citation])
  );
  const matchedCitationIds = new Set<string>();
  const sourcePaths: string[] = [];
  const addSourcePath = (path: string | undefined): void => {
    if (!path) {
      return;
    }
    const normalized = path.replace(/^\.\//, '').trim();
    if (normalized && !sourcePaths.includes(normalized)) {
      sourcePaths.push(normalized);
    }
  };

  CITE_PATTERN.lastIndex = 0;
  let citeMatch: RegExpExecArray | null;
  while ((citeMatch = CITE_PATTERN.exec(chapterText)) !== null) {
    const id = citeMatch[1];
    if (matchedCitationIds.has(id)) {
      continue;
    }
    matchedCitationIds.add(id);
    const citation = citationById.get(id);
    push({
      variable: 'citation',
      arg: id,
      label: citation?.title?.trim() || id,
      detail: id
    });
    addSourcePath(citation?.path);
  }

  // 4a. Sources tied to a matched citation via an excerpt's originating file.
  for (const excerpt of input.excerpts ?? []) {
    if (excerpt.sourceId && matchedCitationIds.has(excerpt.sourceId)) {
      addSourcePath(excerpt.sourcePath);
    }
  }

  // 4b. Source paths referenced directly in the prose.
  SOURCE_PATH_PATTERN.lastIndex = 0;
  let sourceMatch: RegExpExecArray | null;
  while ((sourceMatch = SOURCE_PATH_PATTERN.exec(chapterText)) !== null) {
    addSourcePath(sourceMatch[1]);
  }

  for (const path of sourcePaths) {
    push({ variable: 'source', arg: path, label: baseName(path), detail: path });
  }

  return items;
}
