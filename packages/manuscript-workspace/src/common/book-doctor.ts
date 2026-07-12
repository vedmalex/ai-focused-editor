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
import {
  entityTypeById,
  entityTypeByTagKind,
  tagKindToEntityKind
} from './entity-type-registry';
import {
  buildEntityYaml,
  entityRelativePath,
  type CreatableEntityKind
} from './entity-creation';

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
  kind: 'metadata' | 'parse-error' | 'entity';
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

/**
 * One unique entity reference harvested from the manuscript, folded across every
 * file by the browser (so the pure module stays parser-agnostic). The key is the
 * `(kind, id)` pair: a labeled `[[kind:id|label]]` tag and an unlabeled
 * `[[kind:id]]` tag with the same kind+id fold into ONE occurrence.
 *
 * `kind` is the tag kind AS WRITTEN (e.g. `char`, `term`, `spell`) — it is
 * `undefined` for a bare `[[id]]` tag that names no kind. `firstPath` is the
 * workspace-relative path of the first (lexicographically-smallest) file the
 * reference appears in. `labels` maps each harvested label to its frequency
 * (labeled tags only; absent when no occurrence carried a label).
 */
export interface EntityTagOccurrence {
  /** Tag kind as written (`char`, `term`, …); undefined for a bare `[[id]]`. */
  kind?: string;
  /** Referenced entity id. */
  id: string;
  /** Total mentions across every manuscript file. */
  count: number;
  /** Workspace-relative path of the first file the reference appears in. */
  firstPath: string;
  /** Harvested label → frequency (labeled tags only); absent when none carried a label. */
  labels?: Record<string, number>;
}

/** A card that already exists on disk under `entities/<dir>/<id>.yaml`. */
export interface EntityCardRef {
  /** Entity KIND id (the registry descriptor id, e.g. `character`) — NOT the tag kind. */
  kind: string;
  /** Card id (the YAML filename stem). */
  id: string;
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
  /**
   * Unique entity references harvested from the manuscript (pre-parsed by the
   * browser). Drives the `entity-card-missing` fixes and the orphan/unknown-kind
   * findings. Empty/absent when no manuscript text was scanned.
   */
  entityTagOccurrences?: EntityTagOccurrence[];
  /** Entity cards already present on disk (scanned per registry directory). */
  existingEntityCards?: EntityCardRef[];
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

/* ----------------------------------------------------------------------- */
/* Entity checks (STAGE — restore/diagnose the entity base from the text)    */
/* ----------------------------------------------------------------------- */

/** Composite `(kind, id)` map key. ` ` cannot occur in a kind or id. */
function entityCardKey(kind: string, id: string): string {
  return `${kind} ${id}`;
}

/**
 * Humanize an entity id into a display name: split on `-`/`_`/`.`/`:`/space,
 * drop empties, capitalize each word (e.g. `john-smith` → `John Smith`). Falls
 * back to the raw id when it has no word characters.
 */
export function humanizeEntityId(id: string): string {
  const words = id.split(/[-_.:\s]+/).filter(Boolean);
  if (words.length === 0) {
    return id;
  }
  return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * The most frequent harvested label for an occurrence (ties broken by first
 * insertion), or `undefined` when no label was harvested. The browser records
 * labels only from labeled `[[kind:id|label]]` tags.
 */
export function preferredEntityLabel(labels?: Record<string, number>): string | undefined {
  if (!labels) {
    return undefined;
  }
  let best: string | undefined;
  let bestCount = -1;
  for (const [label, count] of Object.entries(labels)) {
    if (count > bestCount) {
      bestCount = count;
      best = label;
    }
  }
  return best;
}

/** Card display name: the preferred label when present, else the humanized id. */
function entityCardName(occurrence: EntityTagOccurrence): string {
  const label = preferredEntityLabel(occurrence.labels)?.trim();
  return label || humanizeEntityId(occurrence.id);
}

/**
 * Entity check A — `entity-card-missing` (FIXABLE): every occurrence whose tag
 * kind resolves to a REGISTRY entity type but whose `entities/<dir>/<id>.yaml`
 * card is absent becomes one create fix per unique `(kind, id)`. Bare `[[id]]`
 * occurrences (no kind) can never create a card — a card needs a kind — and are
 * skipped here; unknown (non-registry) kinds are skipped too (see check C). The
 * seed name prefers the most frequent label across occurrences, else the
 * humanized id. The description carries the mention count and first file.
 */
export function entityCardMissingFixes(
  occurrences: EntityTagOccurrence[],
  existingCards: EntityCardRef[]
): BookDoctorFix[] {
  const existing = new Set(existingCards.map(card => entityCardKey(card.kind, card.id)));
  const fixes: BookDoctorFix[] = [];
  for (const occurrence of occurrences) {
    if (!occurrence.kind) {
      // A bare `[[id]]` names no kind — a card cannot be materialized from it.
      continue;
    }
    const descriptor = entityTypeByTagKind(occurrence.kind);
    if (!descriptor) {
      // Well-formed but non-registry kind — reported by entityUnknownKindFindings.
      continue;
    }
    const entityKind = descriptor.id;
    if (existing.has(entityCardKey(entityKind, occurrence.id))) {
      continue;
    }
    const name = entityCardName(occurrence);
    fixes.push({
      path: entityRelativePath(entityKind as CreatableEntityKind, occurrence.id),
      kind: 'file',
      seed: buildEntityYaml({ id: occurrence.id, name }),
      code: 'entity-card-missing',
      params: [descriptor.label, name, occurrence.count, occurrence.firstPath],
      description: `Create the ${descriptor.label} card "${name}" — ${occurrence.count} mention(s), first in ${occurrence.firstPath}.`
    });
  }
  return fixes;
}

/**
 * Entity check B — `entity-card-orphan` (INFORMATIONAL): a card on disk that no
 * tag references. A card is referenced when some occurrence shares its id AND
 * either names no kind (a bare `[[id]]` matches any kind) or names a tag kind
 * that resolves to the card's entity kind. Report-only — cards may be
 * intentional groundwork, so the doctor never deletes them.
 */
export function entityCardOrphanFindings(
  occurrences: EntityTagOccurrence[],
  existingCards: EntityCardRef[]
): BookDoctorFinding[] {
  const findings: BookDoctorFinding[] = [];
  for (const card of existingCards) {
    const referenced = occurrences.some(
      occurrence =>
        occurrence.id === card.id &&
        (occurrence.kind === undefined || tagKindToEntityKind(occurrence.kind) === card.kind)
    );
    if (referenced) {
      continue;
    }
    const descriptor = entityTypeById(card.kind);
    const label = descriptor?.label ?? card.kind;
    const path = descriptor
      ? entityRelativePath(card.kind as CreatableEntityKind, card.id)
      : `entities/${card.kind}/${card.id}.yaml`;
    findings.push({
      kind: 'entity',
      code: 'entity-card-orphan',
      params: [label, card.id, path],
      label: `Unreferenced ${label} card: ${card.id}`,
      detail: `The ${label} card ${path} is never referenced by any tag in the manuscript. It may be intentional groundwork — the doctor never deletes it.`
    });
  }
  return findings;
}

/**
 * Entity check C — `entity-tag-unknown-kind` (INFORMATIONAL): tags whose kind is
 * well-formed (`[a-z][\w-]*`) but not in the registry (e.g. `[[spell:fireball]]`).
 * Grouped by kind with the total tag count and the distinct id count. Phrased so
 * it reads as a prompt to define the type (stage-4 author-defined types tie-in).
 */
export function entityUnknownKindFindings(occurrences: EntityTagOccurrence[]): BookDoctorFinding[] {
  const wellFormed = /^[a-z][\w-]*$/;
  const byKind = new Map<string, { count: number; ids: Set<string> }>();
  for (const occurrence of occurrences) {
    if (!occurrence.kind || entityTypeByTagKind(occurrence.kind) || !wellFormed.test(occurrence.kind)) {
      continue;
    }
    const entry = byKind.get(occurrence.kind) ?? { count: 0, ids: new Set<string>() };
    entry.count += occurrence.count;
    entry.ids.add(occurrence.id);
    byKind.set(occurrence.kind, entry);
  }
  const findings: BookDoctorFinding[] = [];
  for (const [kind, entry] of byKind) {
    findings.push({
      kind: 'entity',
      code: 'entity-tag-unknown-kind',
      params: [kind, entry.count, entry.ids.size],
      label: `Unknown entity type: ${kind}`,
      detail: `${entry.count} tag(s) use the unknown entity type "${kind}" across ${entry.ids.size} id(s). Define this type to turn its tags into entity cards.`
    });
  }
  return findings;
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
 * Findings are appended in check order: metadata, the sources parse checks, then
 * the entity findings (orphan cards, unknown tag kinds).
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

  // Entity base: create a card for every registry-kind tag that has none.
  const occurrences = input.entityTagOccurrences ?? [];
  const existingCards = input.existingEntityCards ?? [];
  for (const fix of entityCardMissingFixes(occurrences, existingCards)) {
    push(fix);
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
  findings.push(...entityCardOrphanFindings(occurrences, existingCards));
  findings.push(...entityUnknownKindFindings(occurrences));

  return { fixes, findings };
}
