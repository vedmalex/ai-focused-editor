/**
 * Pure (Theia-free) scaffolding logic for CREATING a proofreading "set": deriving
 * the book-native folder layout from a slug + mode and building a fresh
 * {@link ProofreadingSet} skeleton (optionally seeding `pages[]` from scan file
 * names already dropped into the images folder).
 *
 * The browser "New Proofreading Set…" command layers `QuickInput`/`FileService`
 * on top of these helpers, exactly as `author-materials-create-contribution.ts`
 * layers UI on the Theia-free `entity-creation` contract. Kept here (not in the
 * widget/service) so the path convention and page seeding are unit-testable in
 * isolation.
 *
 * FOLDER CONVENTION (owner decision, `.plan/proofreading-design.md`):
 *  - scan images live under `sources/scans/<slug>/` (fits the `sources/` scaffold);
 *  - the working copy (editable text, and in translation mode the read-only
 *    source text) lives under a dedicated `proofreading/<slug>/` area holding the
 *    `proofset.yaml` sidecar.
 */

import {
  DEFAULT_IMAGE_EXTENSIONS,
  DEFAULT_TEXT_EXTENSIONS,
  getBaseName,
  ProofreadingMode,
  ProofreadingPage,
  ProofreadingSet,
  PROOFSET_FILE_NAME
} from './proofreading-model';

/** The book-native area holding proofreading working copies + sidecars. */
export const PROOFREADING_AREA = 'proofreading';

/** The book-native area holding proofreading scan images (under `sources/`). */
export const SCANS_AREA = 'sources/scans';

/** The three workspace-relative folders a proofreading set is built from. */
export interface ProofreadingSetFolders {
  /** Where scan images live: `sources/scans/<slug>`. */
  imagesFolder: string;
  /** Where the editable text (OCR text OR translation) lives: `proofreading/<slug>/text`. */
  textFolder: string;
  /** Translation mode only: the read-only source text: `proofreading/<slug>/source`. */
  sourceTextFolder?: string;
}

/**
 * Derive the workspace-relative folder layout for a set from its slug + mode.
 * `sourceTextFolder` is present only in translation mode (its presence is the
 * mode switch, per {@link ProofreadingSet}).
 */
export function proofreadingSetFolders(slug: string, mode: ProofreadingMode): ProofreadingSetFolders {
  const folders: ProofreadingSetFolders = {
    imagesFolder: `${SCANS_AREA}/${slug}`,
    textFolder: `${PROOFREADING_AREA}/${slug}/text`
  };
  if (mode === 'translation') {
    folders.sourceTextFolder = `${PROOFREADING_AREA}/${slug}/source`;
  }
  return folders;
}

/** The set's working-copy folder: `proofreading/<slug>`. */
export function proofreadingSetFolder(slug: string): string {
  return `${PROOFREADING_AREA}/${slug}`;
}

/** The set's sidecar path: `proofreading/<slug>/proofset.yaml`. */
export function proofsetRelPath(slug: string): string {
  return `${PROOFREADING_AREA}/${slug}/${PROOFSET_FILE_NAME}`;
}

/**
 * Case-insensitive "does this filename end with one of these extensions" — the
 * same predicate `matchPairs` uses, duplicated locally so this module stays a
 * self-contained contract.
 */
function hasExtension(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some(ext => lower.endsWith(ext.toLowerCase()));
}

/**
 * Seed `pages[]` from scan file names: one page per image basename (via
 * {@link getBaseName}), `verified`/`needsRework` both false, de-duplicated on
 * base (first wins) and numeric-aware sorted so `page.2` precedes `page.10`.
 * Non-image names are ignored. When no images have been dropped yet the result
 * is `[]` and the widget populates on next open.
 */
export function seedPagesFromImageNames(
  imageNames: readonly string[],
  imageExtensions: readonly string[] = DEFAULT_IMAGE_EXTENSIONS
): ProofreadingPage[] {
  const seen = new Set<string>();
  const pages: ProofreadingPage[] = [];
  for (const name of imageNames) {
    if (!hasExtension(name, imageExtensions)) {
      continue;
    }
    const base = getBaseName(name);
    if (seen.has(base)) {
      continue;
    }
    seen.add(base);
    pages.push({ base, verified: false, needsRework: false });
  }
  pages.sort((a, b) => a.base.localeCompare(b.base, undefined, { numeric: true }));
  return pages;
}

/** Inputs for {@link buildProofreadingSetSkeleton}. */
export interface BuildProofreadingSetInput {
  /** The set slug (folder name) — drives all derived paths. */
  slug: string;
  mode: ProofreadingMode;
  /** Scan file names already present in the images folder, to seed `pages[]`. */
  imageNames?: readonly string[];
  /** Override the default image extensions (defaults to {@link DEFAULT_IMAGE_EXTENSIONS}). */
  imageExtensions?: string[];
  /** Override the default text extensions (defaults to {@link DEFAULT_TEXT_EXTENSIONS}). */
  textExtensions?: string[];
}

/**
 * Build a fresh {@link ProofreadingSet} for a new set: the derived folders, the
 * default (or overridden) extension lists, and `pages[]` seeded from any scans
 * already dropped into the images folder. The result serializes straight through
 * `writeProofsetYaml` into `proofreading/<slug>/proofset.yaml`.
 */
export function buildProofreadingSetSkeleton(input: BuildProofreadingSetInput): ProofreadingSet {
  const imageExtensions = input.imageExtensions && input.imageExtensions.length > 0
    ? input.imageExtensions.slice()
    : [...DEFAULT_IMAGE_EXTENSIONS];
  const textExtensions = input.textExtensions && input.textExtensions.length > 0
    ? input.textExtensions.slice()
    : [...DEFAULT_TEXT_EXTENSIONS];
  const folders = proofreadingSetFolders(input.slug, input.mode);
  return {
    mode: input.mode,
    imagesFolder: folders.imagesFolder,
    textFolder: folders.textFolder,
    ...(folders.sourceTextFolder ? { sourceTextFolder: folders.sourceTextFolder } : {}),
    imageExtensions,
    textExtensions,
    pages: seedPagesFromImageNames(input.imageNames ?? [], imageExtensions)
  };
}
