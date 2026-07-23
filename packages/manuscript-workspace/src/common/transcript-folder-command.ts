import URI from '@theia/core/lib/common/uri';

/**
 * Pure helpers for the U3a navigator context-menu entry point into the
 * "Transcribe..." ingest wizard (UR-003/UR-007 point 2: "a way to migrate old
 * transcripts reachable from the file tree's context menu").
 *
 * Kept in `common/` (rather than inline in `transcript-navigator-contribution
 * .ts`) so they stay unit-testable in isolation: the browser contribution
 * needs `@theia/navigator/lib/browser/navigator-contribution` and `@theia/
 * filesystem/lib/browser`, both of which pull in the DOM-dependent Lumino
 * browser stack at module load (the same reason `welcome-widget.test.ts`
 * needs a `document` shim) — a plain Bun test importing this module instead
 * needs no shim at all, matching the `semantic-link-contribution.test.ts`
 * precedent of testing the extracted pure logic from `common/`, not the
 * contribution module itself.
 */

/**
 * Programmatic answer for the "Transcribe..." wizard's IMPORT branch
 * (structurally a subset of `TranscribeWizardArgs` in
 * `transcript-ingest-contribution.ts`), built from a folder URI picked in the
 * standard file Explorer.
 */
export interface TranscribeFolderWizardArgs {
  mode: 'import';
  importFolder: string;
}

/** Folder URI -> the wizard args that pre-answer STEP 1 (import) + the folder-pick step. */
export function buildTranscribeFolderArgs(folderUri: URI): TranscribeFolderWizardArgs {
  return {
    mode: 'import',
    importFolder: folderUri.toString()
  };
}

/** Structural shape of a navigator `DirNode`/`FileStatNode` — duck-typed so this module never imports `@theia/filesystem/lib/browser`. */
interface DirectorySelectionNode {
  uri: URI;
  fileStat: { isDirectory: boolean };
}

function isDirectorySelectionNode(node: unknown): node is DirectorySelectionNode {
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  const candidate = node as { uri?: unknown; fileStat?: { isDirectory?: unknown } };
  return candidate.uri instanceof URI
    && typeof candidate.fileStat === 'object'
    && candidate.fileStat !== null
    && candidate.fileStat.isDirectory === true;
}

/**
 * Resolve a directory URI from a single navigator selection node — mirrors
 * Theia's `DirNode.is` (`FileStatNode.is(node) && node.fileStat.isDirectory`)
 * without the heavyweight import. Returns `undefined` for files, non-node
 * values, and empty selections.
 */
export function resolveDirectoryUriFromNode(node: unknown): URI | undefined {
  return isDirectorySelectionNode(node) ? node.uri : undefined;
}
