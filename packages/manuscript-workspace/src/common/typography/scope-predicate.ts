/**
 * Pure scope discriminator for auto-typography (TASK-019 §1.3, ISS-234). Answers
 * "should the engine run on THIS file?" without any Theia/Monaco dependency, so
 * the decision is unit-testable.
 *
 * Two scopes, matching the `aiFocusedEditor.typography.scope` preference:
 *  - `chapters` (default) -> {@link isChapterProse}: a markdown file that is an
 *    AUTHORITATIVELY-identified chapter. A positive signal is REQUIRED — a
 *    front-matter `type: chapter`, or a basename listed in the book manifest.
 *    Being under `content/` is a fast-path hint only, never sufficient (so
 *    `content/notes.md` with no `type: chapter` is correctly excluded — the
 *    ISS-222 class).
 *  - `all-md` -> {@link isMarkdownProse}: any markdown file that is not one of
 *    the structural sidecars (raw.md, proofset.yaml, entity yaml).
 */

import { isRawMdPath } from '../transcript-set-scaffold';
import { isProofsetPath } from '../proofreading-model';

export interface ChapterProseSignals {
  /** The parsed `type:` scalar from the OPEN buffer's front matter, if any. */
  readonly frontMatterType?: string;
  /** Basenames the book manifest lists as chapter content (e.g. `chapter-01.md`). */
  readonly manifestBasenames?: readonly string[];
}

/** Lower-cased file extension including the dot, or '' when there is none. */
function extensionOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** Trailing path segment (basename), forward-slash normalised. */
function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** True for a `.md`/`.markdown` path (case-insensitive). */
function isMarkdownExt(path: string): boolean {
  const ext = extensionOf(path);
  return ext === '.md' || ext === '.markdown';
}

/**
 * True when `uriPath` is editable markdown prose that is NOT a structural
 * sidecar (raw.md / proofset.yaml / entity yaml). This is the `all-md` scope
 * gate and the shared prerequisite of {@link isChapterProse}.
 */
export function isMarkdownProse(uriPath: string): boolean {
  if (!isMarkdownExt(uriPath)) {
    return false;
  }
  if (isRawMdPath(uriPath)) {
    return false;
  }
  // proofset.yaml / entity yaml are non-markdown; the ext check already drops
  // them, but keep the explicit sidecar exclusion for intent and future-proofing.
  if (isProofsetPath(uriPath)) {
    return false;
  }
  return true;
}

/**
 * True when `uriPath` is authoritatively a chapter's prose (the `chapters`
 * scope). Requires {@link isMarkdownProse} AND a positive chapter signal:
 * front-matter `type: chapter`, or a manifest-listed basename. Path shape alone
 * (`content/`) is never sufficient.
 */
export function isChapterProse(uriPath: string, signals: ChapterProseSignals = {}): boolean {
  if (!isMarkdownProse(uriPath)) {
    return false;
  }
  if (signals.frontMatterType !== undefined && signals.frontMatterType.trim().toLowerCase() === 'chapter') {
    return true;
  }
  if (signals.manifestBasenames && signals.manifestBasenames.includes(basenameOf(uriPath))) {
    return true;
  }
  return false;
}

/**
 * Reduce a book manifest's flattened `content:` paths to the set of chapter
 * basenames — the authoritative `chapters`-scope signal for a chapter that
 * carries NO `type: chapter` front matter (the sample-book layout, where
 * `content/chapter-01.md` is listed in the manifest but starts with a plain
 * `# ` heading). Folder/part rows and any non-markdown entry are dropped: only
 * markdown files are chapters. Pure — the membership rule is unit-testable
 * without Theia/Monaco/FileService; the seam only supplies the parsed paths.
 */
export function manifestChapterBasenames(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const base = basenameOf(path);
    if (isMarkdownExt(base)) {
      names.add(base);
    }
  }
  return [...names];
}
