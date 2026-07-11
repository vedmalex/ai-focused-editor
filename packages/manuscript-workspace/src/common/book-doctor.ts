/**
 * Pure (Theia-free) check-assembly for the "Book Doctor".
 *
 * The doctor inspects an existing manuscript workspace and reports two kinds of
 * result:
 *  - {@link BookDoctorFix} — an actionable, auto-fixable gap (a missing scaffold
 *    folder/file, or a chapter file the manifest references but that is absent on
 *    disk) that the doctor offers to CREATE. The doctor never deletes anything.
 *  - {@link BookDoctorFinding} — a report-only observation (content on disk that
 *    the manifest does not list, blank metadata, an unparseable sources file). The
 *    doctor surfaces these but does not touch them.
 *
 * All I/O lives in the browser layer; this module takes already-resolved inputs
 * (an exists predicate, parsed manifest rows, on-disk file lists, raw file text)
 * so the check logic is unit-testable under `bun test`.
 */

import { parse } from 'yaml';
import {
  BookScaffoldEntry,
  bookScaffoldEntries,
  buildChapterMarkdown,
  isNewBookOnlyEntry,
  missingScaffoldEntries
} from './book-scaffold';
import { ManifestRow, normalizeManifestPath } from './book-config-forms';
import {
  buildManifestYaml,
  reconstructManifestEntries,
  type DiscoveredManuscriptFile,
  type ReconstructedEntry
} from './manifest-reconstruction';

/**
 * Manifest reconstruction metadata attached to the special `manifest.yaml` fix.
 * Its presence tells the browser to (a) render a localized label carrying the
 * discovered file count + sample paths, and (b) for `append`, MERGE the entries
 * into the existing manifest comment-preservingly rather than create a file.
 */
export interface ManifestReconstructionFix {
  /**
   * `recreate` — the manifest is missing; the fix's `seed` is a fresh manifest
   *   built from the discovered content (a plain file create).
   * `append`   — the manifest exists; the browser reads it and appends `entries`
   *   (comment-preserving) — there is no `seed`, and the file is never rewritten
   *   wholesale.
   */
  mode: 'recreate' | 'append';
  /** Entries to write (recreate) / append (append). */
  entries: ReconstructedEntry[];
  /** Number of discovered (recreate) / newly-added (append) files. */
  fileCount: number;
  /** First few workspace-relative paths, for the label/report. */
  samplePaths: string[];
}

/** An auto-fixable gap the doctor offers to create (folder or seeded file). */
export interface BookDoctorFix {
  /** Workspace-relative path to create (forward slashes, no leading `./`). */
  path: string;
  /** Whether to create a directory or a seeded file. */
  kind: 'folder' | 'file';
  /** Seed content for `file` fixes (absent for folders; absent for `append`). */
  seed?: string;
  /** Human-readable summary of what will be created (QuickPick description). */
  description: string;
  /** Present on the `manifest.yaml` reconstruction/append fix (see above). */
  manifest?: ManifestReconstructionFix;
  /**
   * Stable kebab-case identifier for the fix kind (e.g. `create-folder`). The
   * rendering contribution maps it to a localized {@link description}; when
   * absent/unknown it falls back to the English {@link description}. Purely
   * additive — {@link description} stays the byte-identical English source.
   */
  code?: string;
  /**
   * Positional values interpolated into the localized description, in `{0}`,
   * `{1}`… order. Omitted when the description has no placeholders.
   */
  params?: (string | number)[];
}

/** A report-only observation the doctor surfaces but never auto-changes. */
export interface BookDoctorFinding {
  /** Category, for grouping/telemetry. */
  kind: 'metadata' | 'parse-error';
  /** Short label (path or one-line summary). */
  label: string;
  /** Longer explanation, shown in the QuickPick detail row. */
  detail: string;
  /**
   * Stable kebab-case identifier for the finding kind (e.g. `metadata-title-blank`).
   * The rendering contribution maps it to a localized {@link label}/{@link detail};
   * when absent/unknown it falls back to the English strings. Purely additive —
   * {@link label}/{@link detail} stay the byte-identical English source.
   */
  code?: string;
  /**
   * Positional values interpolated into the localized {@link label}/{@link detail},
   * in `{0}`, `{1}`… order (e.g. a 1-based line number, then a parser message).
   * Omitted when neither string has a placeholder.
   */
  params?: (string | number)[];
}

/** The full doctor report: creatable fixes plus informational findings. */
export interface BookDoctorReport {
  fixes: BookDoctorFix[];
  findings: BookDoctorFinding[];
}

/** Minimal metadata projection the doctor sanity-checks. */
export interface BookDoctorMetadata {
  title: string;
  author: string;
}

/** Fully-resolved inputs for {@link assembleBookDoctorReport}. */
export interface BookDoctorInput {
  /** Canonical scaffold entries, from `bookScaffoldEntries()`. */
  scaffoldEntries: BookScaffoldEntry[];
  /** True when the workspace-relative `path` exists on disk. */
  exists: (path: string) => boolean;
  /** True when `content/` already holds at least one `.md` file. */
  contentHasMarkdown: boolean;
  /** Whether `manifest.yaml` exists (gates the manifest-coverage checks). */
  manifestExists: boolean;
  /** Parsed manifest rows (empty when the manifest is missing/unparseable). */
  manifestRows: ManifestRow[];
  /**
   * Every discovered manuscript `.md` candidate across the workspace (the browser
   * walk of `**\/*.md` minus the excluded/hidden dirs), each with its first ATX
   * heading when found. Drives manifest reconstruction (missing manifest) and the
   * "add unreferenced files to the manifest" fix (existing manifest).
   */
  manuscriptCandidates?: DiscoveredManuscriptFile[];
  /**
   * Workspace folder name — used to seed a missing `metadata.yaml` title when the
   * doctor restores an old book (better than the `Untitled` scaffold default).
   */
  folderName?: string;
  /** Metadata fields, present only when `metadata.yaml` exists. */
  metadata?: BookDoctorMetadata;
  /** Raw `sources/citations.yaml` text, present only when the file exists. */
  citationsContent?: string;
  /** Raw `sources/excerpts.jsonl` text, present only when the file exists. */
  excerptsContent?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the path's basename looks like a file (has an extension). */
function looksLikeFile(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  return base.includes('.');
}

/**
 * Derive a chapter title for a seeded file: the manifest `title` when non-blank,
 * otherwise the filename stem (basename with the extension stripped).
 */
export function deriveChapterTitle(path: string, title?: string): string {
  if (title && title.trim()) {
    return title.trim();
  }
  const base = path.split('/').pop() ?? path;
  const stem = base.replace(/\.[^.]+$/, '');
  return stem || base;
}

/**
 * Check 1 — Scaffold: every canonical entry missing on disk becomes a create
 * fix. The starter `content/chapter-01.md` (the sole new-book-only entry) is
 * skipped when `content/` already holds Markdown, so an established book is not
 * nagged to add a starter chapter.
 */
export function scaffoldFixes(
  entries: BookScaffoldEntry[],
  exists: (path: string) => boolean,
  contentHasMarkdown: boolean
): BookDoctorFix[] {
  const fixes: BookDoctorFix[] = [];
  for (const entry of missingScaffoldEntries(entries, exists)) {
    if (contentHasMarkdown && isNewBookOnlyEntry(entry)) {
      continue;
    }
    fixes.push({
      path: entry.path,
      kind: entry.kind,
      seed: entry.kind === 'file' ? entry.seed ?? '' : undefined,
      code: entry.kind === 'folder' ? 'create-folder' : 'create-file',
      params: [entry.description],
      description:
        entry.kind === 'folder'
          ? `Create folder — ${entry.description}`
          : `Create file — ${entry.description}`
    });
  }
  return fixes;
}

/**
 * Check 2a — Manifest coverage: every manifest *file* entry (a leaf row with a
 * file-like path) whose target is absent on disk becomes a create fix, seeded
 * with a starter chapter whose H1 is derived from the entry title or filename.
 * Parts/folders (rows with children) are not chapter files and are skipped.
 */
export function manifestChapterFixes(
  rows: ManifestRow[],
  exists: (path: string) => boolean
): BookDoctorFix[] {
  const fixes: BookDoctorFix[] = [];
  for (const row of rows) {
    if (row.hasChildren) {
      continue;
    }
    const path = normalizeManifestPath(row.path);
    if (!path || !looksLikeFile(path) || exists(path)) {
      continue;
    }
    fixes.push({
      path,
      kind: 'file',
      seed: buildChapterMarkdown(deriveChapterTitle(path, row.title)),
      code: 'create-missing-chapter',
      description: 'Create the missing chapter file referenced by the manifest.'
    });
  }
  return fixes;
}

/** First few candidate paths, for the reconstruction fix's label/report. */
const SAMPLE_PATH_LIMIT = 5;

/**
 * Check 2b(1) — Missing manifest reconstruction: when `manifest.yaml` is absent
 * but manuscript content exists on disk, offer a single fixable that recreates
 * the manifest from the discovered files (directories → parts, `.md` → chapters).
 * This REPLACES the empty-seed `manifest.yaml` scaffold fix for the restore case;
 * the empty seed remains only when there is no content at all. Returns undefined
 * when the manifest already exists or there is nothing to reconstruct.
 */
export function manifestRecreateFix(
  manifestExists: boolean,
  candidates: DiscoveredManuscriptFile[]
): BookDoctorFix | undefined {
  if (manifestExists || candidates.length === 0) {
    return undefined;
  }
  const entries = reconstructManifestEntries(candidates);
  if (entries.length === 0) {
    return undefined;
  }
  return {
    path: 'manifest.yaml',
    kind: 'file',
    seed: buildManifestYaml(entries),
    // The QuickPick/report render `fixLabel` (already localized) for manifest
    // fixes, so this English `description` stays a fallback; the code keeps the
    // data model uniform with the other fixes.
    code: 'manifest-recreate',
    params: [candidates.length],
    description: `Recreate the manifest from ${candidates.length} discovered content file(s).`,
    manifest: {
      mode: 'recreate',
      entries,
      fileCount: candidates.length,
      samplePaths: candidates.slice(0, SAMPLE_PATH_LIMIT).map(candidate => candidate.path)
    }
  };
}

/**
 * Check 2b(2) — Unreferenced content: when `manifest.yaml` exists but discovered
 * `.md` candidates are not listed in it, offer a single fixable that APPENDS them
 * (comment-preserving) to the manifest — a new chapter lands at the end of its
 * existing parent part, a new part at the end of `content`. This supersedes the
 * old report-only "orphan content" finding. Returns undefined when every
 * candidate is already referenced.
 */
export function manifestAppendFix(
  manifestExists: boolean,
  candidates: DiscoveredManuscriptFile[],
  rows: ManifestRow[]
): BookDoctorFix | undefined {
  if (!manifestExists) {
    return undefined;
  }
  const referenced = new Set(rows.map(row => normalizeManifestPath(row.path)));
  const unreferenced = candidates.filter(
    candidate => !referenced.has(normalizeManifestPath(candidate.path))
  );
  if (unreferenced.length === 0) {
    return undefined;
  }
  const entries = reconstructManifestEntries(unreferenced);
  if (entries.length === 0) {
    return undefined;
  }
  return {
    path: 'manifest.yaml',
    kind: 'file',
    // As with recreate, the rendered surface uses `fixLabel`; this English
    // `description` is the fallback and the code keeps the model uniform.
    code: 'manifest-append',
    params: [unreferenced.length],
    description: `Add ${unreferenced.length} unreferenced content file(s) to the manifest.`,
    manifest: {
      mode: 'append',
      entries,
      fileCount: unreferenced.length,
      samplePaths: unreferenced.slice(0, SAMPLE_PATH_LIMIT).map(candidate => candidate.path)
    }
  };
}

/**
 * The `metadata.yaml` seed to use when the doctor restores an old book: the same
 * scaffold seed the New Book wizard would emit, but titled with the workspace
 * FOLDER NAME instead of `Untitled`. Reuses `bookScaffoldEntries({ title })` so
 * the wizard's default shape is untouched — only the doctor threads a title in.
 */
export function reconstructionMetadataSeed(folderName: string): string {
  const entry = bookScaffoldEntries({ title: folderName }).find(
    scaffold => scaffold.path === 'metadata.yaml'
  );
  return entry?.seed ?? '';
}

/**
 * Check 3 — Metadata sanity: a blank/missing `title` or `author` in
 * `metadata.yaml` becomes a report-only warning.
 */
export function metadataFindings(metadata: BookDoctorMetadata): BookDoctorFinding[] {
  const findings: BookDoctorFinding[] = [];
  if (!metadata.title.trim()) {
    findings.push({
      kind: 'metadata',
      code: 'metadata-title-blank',
      label: 'metadata.yaml: title is blank',
      detail: 'The book title in metadata.yaml is missing or blank. Set it in the Book Metadata editor.'
    });
  }
  if (!metadata.author.trim()) {
    findings.push({
      kind: 'metadata',
      code: 'metadata-author-blank',
      label: 'metadata.yaml: author is blank',
      detail: 'The book author in metadata.yaml is missing or blank. Set it in the Book Metadata editor.'
    });
  }
  return findings;
}

/**
 * Check 4a — `sources/citations.yaml` parse check: a YAML syntax error becomes a
 * report-only finding carrying the parser's message.
 */
export function citationsParseFinding(content: string): BookDoctorFinding | undefined {
  try {
    parse(content);
    return undefined;
  } catch (error) {
    return {
      kind: 'parse-error',
      code: 'citations-parse-error',
      params: [errorMessage(error)],
      label: 'sources/citations.yaml could not be parsed',
      detail: `YAML parse error in sources/citations.yaml: ${errorMessage(error)}`
    };
  }
}

/**
 * Check 4b — `sources/excerpts.jsonl` parse check: each non-blank line must be
 * valid JSON. The first offending line becomes a report-only finding carrying
 * the 1-based line number and the parser's message.
 */
export function excerptsParseFinding(content: string): BookDoctorFinding | undefined {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    try {
      JSON.parse(line);
    } catch (error) {
      return {
        kind: 'parse-error',
        code: 'excerpts-parse-error',
        params: [index + 1, errorMessage(error)],
        label: 'sources/excerpts.jsonl has an invalid line',
        detail: `Line ${index + 1} of sources/excerpts.jsonl is not valid JSON: ${errorMessage(error)}`
      };
    }
  }
  return undefined;
}

/**
 * Compose the full {@link BookDoctorReport} from resolved inputs. Fixes are
 * de-duplicated by path, preserving the parents-before-children order the
 * scaffold guarantees so a consumer can create them sequentially.
 *
 * Manifest handling adapts to the workspace state:
 *  - manifest MISSING + content on disk → the reconstruction fix is pushed FIRST
 *    so it wins the `manifest.yaml` slot over the empty-seed scaffold fix (the
 *    empty seed survives only when there is no content at all);
 *  - manifest EXISTS → its missing chapter files are offered, and any discovered
 *    files it does not reference become a single append fix (superseding the old
 *    report-only orphan finding);
 *  - a missing `metadata.yaml` is re-seeded with the workspace folder name when
 *    the doctor is restoring an old book (content present + folder name known).
 *
 * Findings are appended in check order: metadata, then the sources parse checks.
 */
export function assembleBookDoctorReport(input: BookDoctorInput): BookDoctorReport {
  const fixes: BookDoctorFix[] = [];
  const seen = new Set<string>();
  const push = (fix: BookDoctorFix): void => {
    if (!seen.has(fix.path)) {
      seen.add(fix.path);
      fixes.push(fix);
    }
  };

  const candidates = input.manuscriptCandidates ?? [];

  // Missing-manifest reconstruction claims the `manifest.yaml` slot first, so the
  // empty-seed scaffold fix below is de-duplicated out when content exists.
  const recreate = manifestRecreateFix(input.manifestExists, candidates);
  if (recreate) {
    push(recreate);
  }

  for (const fix of scaffoldFixes(input.scaffoldEntries, input.exists, input.contentHasMarkdown)) {
    push(fix);
  }

  // Restore an old book with a friendlier metadata title (folder name, not
  // `Untitled`) when metadata.yaml is being freshly seeded and content exists.
  if (candidates.length > 0 && input.folderName) {
    const metadataFix = fixes.find(fix => fix.path === 'metadata.yaml');
    if (metadataFix && metadataFix.kind === 'file') {
      metadataFix.seed = reconstructionMetadataSeed(input.folderName);
    }
  }

  if (input.manifestExists) {
    for (const fix of manifestChapterFixes(input.manifestRows, input.exists)) {
      push(fix);
    }
    const append = manifestAppendFix(input.manifestExists, candidates, input.manifestRows);
    if (append) {
      push(append);
    }
  }

  const findings: BookDoctorFinding[] = [];
  if (input.metadata) {
    findings.push(...metadataFindings(input.metadata));
  }
  if (input.citationsContent !== undefined) {
    const finding = citationsParseFinding(input.citationsContent);
    if (finding) {
      findings.push(finding);
    }
  }
  if (input.excerptsContent !== undefined) {
    const finding = excerptsParseFinding(input.excerptsContent);
    if (finding) {
      findings.push(finding);
    }
  }

  return { fixes, findings };
}
