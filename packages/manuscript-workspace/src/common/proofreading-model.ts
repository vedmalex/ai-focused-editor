/**
 * Pure, book-native pairing/progress/mode logic for the Proofreading feature.
 *
 * This is a port of ScanCheck's `src/shared/workspaceMode.js` (mode keying,
 * `workspaceMode.js:1-34`) + `src/shared/utils.js` (basename derivation
 * `utils.js:11-13`, file pairing `matchFiles` `utils.js:59-92`), rewritten to be
 * WORKSPACE-RELATIVE (paths are `<folder>/<name>` relative to the book root, never
 * absolute or `file://` URIs) and Theia/Node/DOM-free so it runs directly under
 * `bun test` — mirroring the conventions in `entity-type-registry.ts`.
 *
 * The two proofreading modes (OCR review vs translation review) are a single
 * boolean off the sidecar: {@link isTranslationMode} derives from the presence of
 * `sourceTextFolder` (ScanCheck keys the mode off `translationFolderPath`), while
 * the explicit `mode` field is kept as the authoritative label.
 */

/** Which proofreading workflow a set drives. */
export type ProofreadingMode = 'ocr' | 'translation';

/**
 * Per-page verified/rework state, keyed by page BASE name (never by index —
 * ScanCheck's `fileStates` map keys by name, `WorkflowManager.js:527-581`, so a
 * folder reorder never desyncs the flags).
 */
export interface ProofreadingPage {
  /** Basename shared by the image and text file (e.g. `page.01`). */
  base: string;
  /** The writer has confirmed this page is correct. */
  verified: boolean;
  /** The writer flagged this page as needing more work. */
  needsRework: boolean;
}

/**
 * A proofreading "set": one images folder paired against one text folder (plus,
 * in translation mode, a read-only source-text folder). All folder paths are
 * workspace-relative.
 */
export interface ProofreadingSet {
  mode: ProofreadingMode;
  /** Workspace-relative folder holding the scan images. */
  imagesFolder: string;
  /** Workspace-relative folder holding the editable text (OCR text OR translation). */
  textFolder: string;
  /** Translation mode only: workspace-relative folder holding the read-only source text. */
  sourceTextFolder?: string;
  /** Accepted image file extensions (lowercase, dot-prefixed). */
  imageExtensions: string[];
  /** Accepted text file extensions (lowercase, dot-prefixed). */
  textExtensions: string[];
  /** Per-page verified/rework state, keyed by base name. */
  pages: ProofreadingPage[];
}

/**
 * One resolved image↔text pairing. There is exactly ONE pair per image file
 * (images drive the list); `missing` is true when no text file matched the
 * image's base. All paths are workspace-relative (`<folder>/<name>`).
 */
export interface ProofreadingPair {
  base: string;
  /** Workspace-relative path to the scan image. */
  imageRelPath: string;
  /**
   * Workspace-relative path to the editable text file. When a matching text file
   * exists it is that file's real path; when `missing`, it is the EXPECTED path
   * `<textFolder>/<base><preferred-text-ext>` where the text would be created.
   */
  textRelPath: string;
  /**
   * Translation mode only (present iff `sourceTextFolder` was supplied):
   * workspace-relative path to the read-only source text (matched file's real
   * path, or the expected path when no source file matched).
   */
  sourceTextRelPath?: string;
  /** True when no text file matched the image's base name. */
  missing: boolean;
}

/** Folder context {@link matchPairs} threads in to build workspace-relative paths. */
export interface ProofreadingFolders {
  imagesFolder: string;
  textFolder: string;
  sourceTextFolder?: string;
}

/** ScanCheck default image extensions (`appConfig.js` defaults). */
export const DEFAULT_IMAGE_EXTENSIONS: readonly string[] = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.bmp'];

/** ScanCheck default text extensions. */
export const DEFAULT_TEXT_EXTENSIONS: readonly string[] = ['.txt', '.md'];

/**
 * Strip the LAST extension via `lastIndexOf('.')` — the exact behavior of
 * ScanCheck `utils.js:11-13`. `page.01.jpg` → `page.01` (only the final `.jpg` is
 * dropped, so a dotted convention is preserved), and a name with no dot is
 * returned whole. NOTE: image and text files must share the SAME dotted
 * convention or they silently mis-pair (documented risk in the design).
 */
export function getBaseName(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index === -1 ? filename : filename.slice(0, index);
}

/**
 * True when the set is a TRANSLATION set. Derived from the presence of
 * `sourceTextFolder` for parity with ScanCheck `workspaceMode.js:1-3` (which keys
 * the mode off `translationFolderPath`), NOT off `set.mode` — the source folder
 * IS the mode switch. `set.mode` is kept as the authoritative persisted label.
 */
export function isTranslationMode(set: Pick<ProofreadingSet, 'sourceTextFolder'>): boolean {
  return Boolean(set.sourceTextFolder);
}

/** Case-insensitive "does this filename end with one of these extensions". */
function hasExtension(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some(ext => lower.endsWith(ext.toLowerCase()));
}

/**
 * Pair image files against text files by BASE name — the port of ScanCheck
 * `matchFiles` (`utils.js:59-92`). Semantics:
 *  - ONE entry per image file (images drive the list); non-image names filtered out.
 *  - Text (and optional source-text) files are looked up in a base→name Map;
 *    the FIRST file per base wins (deterministic on duplicate bases).
 *  - A missing text match sets `missing: true` and points `textRelPath` at the
 *    EXPECTED `<textFolder>/<base><preferred-ext>` location.
 *  - Result sorted by base with a numeric-aware `localeCompare` (so `page.2`
 *    sorts before `page.10`).
 *
 * Folders are threaded in via {@link ProofreadingFolders} so the returned pairs
 * carry ready-to-use workspace-relative paths (the design note's "pass folders
 * in to build imageRelPath" choice). The preferred text extension is the first
 * of `textExts` (falling back to {@link DEFAULT_TEXT_EXTENSIONS}[0]).
 */
export function matchPairs(
  imageNames: string[],
  textNames: string[],
  sourceTextNames: string[] | undefined,
  folders: ProofreadingFolders,
  imageExts: readonly string[],
  textExts: readonly string[]
): ProofreadingPair[] {
  const preferredTextExt = textExts[0] ?? DEFAULT_TEXT_EXTENSIONS[0];

  const firstByBase = (names: readonly string[]): Map<string, string> => {
    const map = new Map<string, string>();
    for (const name of names) {
      if (!hasExtension(name, textExts)) {
        continue;
      }
      const base = getBaseName(name);
      if (!map.has(base)) {
        map.set(base, name);
      }
    }
    return map;
  };

  const textByBase = firstByBase(textNames);
  const sourceByBase = sourceTextNames ? firstByBase(sourceTextNames) : undefined;

  const pairs: ProofreadingPair[] = [];
  for (const imageName of imageNames) {
    if (!hasExtension(imageName, imageExts)) {
      continue;
    }
    const base = getBaseName(imageName);
    const textName = textByBase.get(base);
    const pair: ProofreadingPair = {
      base,
      imageRelPath: `${folders.imagesFolder}/${imageName}`,
      textRelPath: `${folders.textFolder}/${textName ?? `${base}${preferredTextExt}`}`,
      missing: textName === undefined
    };
    if (folders.sourceTextFolder !== undefined) {
      const sourceName = sourceByBase?.get(base);
      pair.sourceTextRelPath = `${folders.sourceTextFolder}/${sourceName ?? `${base}${preferredTextExt}`}`;
    }
    pairs.push(pair);
  }

  pairs.sort((a, b) => a.base.localeCompare(b.base, undefined, { numeric: true }));
  return pairs;
}

/**
 * The workspace-relative path of the EDITABLE text file for a page — the analogue
 * of ScanCheck `workspaceMode.js:27-34`. In BOTH modes the editable file lives in
 * `textFolder` (in OCR mode it is the OCR text; in translation mode `textFolder`
 * IS the translation folder), so this never branches on mode — the mode only
 * governs the extra read-only source pane elsewhere.
 *
 * The extension is `set.textExtensions[0]` (falling back to
 * {@link DEFAULT_TEXT_EXTENSIONS}[0]). This is the EXPECTED path derived from the
 * set config; when a concrete pairing exists prefer `ProofreadingPair.textRelPath`
 * (which carries the actually-paired file's real extension).
 */
export function getEditableRelativePath(set: Pick<ProofreadingSet, 'textFolder' | 'textExtensions'>, base: string): string {
  const ext = set.textExtensions[0] ?? DEFAULT_TEXT_EXTENSIONS[0];
  return `${set.textFolder}/${base}${ext}`;
}

/** Verified/rework progress over a set's pages. `percent` rounds and is 0 when empty. */
export function computeProgress(set: Pick<ProofreadingSet, 'pages'>): {
  verified: number;
  needsRework: number;
  total: number;
  percent: number;
} {
  const total = set.pages.length;
  let verified = 0;
  let needsRework = 0;
  for (const page of set.pages) {
    if (page.verified) {
      verified++;
    }
    if (page.needsRework) {
      needsRework++;
    }
  }
  const percent = total === 0 ? 0 : Math.round((verified / total) * 100);
  return { verified, needsRework, total, percent };
}
