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
  buildChapterMarkdown,
  isNewBookOnlyEntry,
  missingScaffoldEntries
} from './book-scaffold';
import { ManifestRow, normalizeManifestPath } from './book-config-forms';

/** An auto-fixable gap the doctor offers to create (folder or seeded file). */
export interface BookDoctorFix {
  /** Workspace-relative path to create (forward slashes, no leading `./`). */
  path: string;
  /** Whether to create a directory or a seeded file. */
  kind: 'folder' | 'file';
  /** Seed content for `file` fixes (absent for folders). */
  seed?: string;
  /** Human-readable summary of what will be created (QuickPick description). */
  description: string;
}

/** A report-only observation the doctor surfaces but never auto-changes. */
export interface BookDoctorFinding {
  /** Category, for grouping/telemetry. */
  kind: 'unreferenced-content' | 'metadata' | 'parse-error';
  /** Short label (path or one-line summary). */
  label: string;
  /** Longer explanation, shown in the QuickPick detail row. */
  detail: string;
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
  /** Workspace-relative `content/**` Markdown paths found on disk. */
  contentMarkdownPaths: string[];
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
      description: 'Create the missing chapter file referenced by the manifest.'
    });
  }
  return fixes;
}

/**
 * Check 2b — Orphan content: every `content/**` Markdown file on disk that the
 * manifest does not reference becomes a report-only finding (the doctor never
 * edits the manifest; it suggests adding the file via the manifest editor).
 */
export function unreferencedContentFindings(
  contentMarkdownPaths: string[],
  rows: ManifestRow[]
): BookDoctorFinding[] {
  const referenced = new Set(rows.map(row => normalizeManifestPath(row.path)));
  const findings: BookDoctorFinding[] = [];
  for (const raw of contentMarkdownPaths) {
    const path = normalizeManifestPath(raw);
    if (!path || referenced.has(path)) {
      continue;
    }
    findings.push({
      kind: 'unreferenced-content',
      label: path,
      detail:
        `${path} exists under content/ but is not listed in the manifest. ` +
        'Add it in the Manifest editor to include it in the book build.'
    });
  }
  return findings;
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
      label: 'metadata.yaml: title is blank',
      detail: 'The book title in metadata.yaml is missing or blank. Set it in the Book Metadata editor.'
    });
  }
  if (!metadata.author.trim()) {
    findings.push({
      kind: 'metadata',
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
        label: 'sources/excerpts.jsonl has an invalid line',
        detail: `Line ${index + 1} of sources/excerpts.jsonl is not valid JSON: ${errorMessage(error)}`
      };
    }
  }
  return undefined;
}

/**
 * Compose the full {@link BookDoctorReport} from resolved inputs. Fixes are
 * de-duplicated by path (scaffold entries first, then manifest chapter files),
 * preserving the parents-before-children order the scaffold guarantees so a
 * consumer can create them sequentially. Findings are appended in check order:
 * orphan content, metadata, then the sources parse checks.
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

  for (const fix of scaffoldFixes(input.scaffoldEntries, input.exists, input.contentHasMarkdown)) {
    push(fix);
  }
  if (input.manifestExists) {
    for (const fix of manifestChapterFixes(input.manifestRows, input.exists)) {
      push(fix);
    }
  }

  const findings: BookDoctorFinding[] = [];
  if (input.manifestExists) {
    findings.push(...unreferencedContentFindings(input.contentMarkdownPaths, input.manifestRows));
  }
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
