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
  BASE_ENTITY_TYPES,
  type EntityTypeDescriptor,
  type EntityTypeProblem
} from './entity-type-registry';
import { buildEntityYaml } from './entity-creation';
import { OBSIDIAN_PLUGIN_ID } from './obsidian-plugin-protocol';
import { scanLegacyAiSettings } from './ai-settings-migration';

/** Workspace-relative path of the Theia settings file the AI-settings check reads. */
export const WORKSPACE_SETTINGS_PATH = '.theia/settings.json';

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

/**
 * Marker attached to the Obsidian-plugin install/update fix. Carries the versions
 * (for the label/message) and whether the book already has an `.obsidian/` dir.
 */
export interface ObsidianPluginFix {
  /** `install` — the plugin is absent; `update` — an older version is installed. */
  mode: 'install' | 'update';
  /** `hint` for a missing plugin (a gentle convenience), `warning` for an outdated one. */
  severity: 'hint' | 'warning';
  /** Installed version (`null` for a fresh install). */
  installedVersion: string | null;
  /** Bundled version that will be written. */
  bundledVersion: string;
  /** Whether the book folder already has an `.obsidian/` directory. */
  hasObsidianDir: boolean;
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
   * Present on the Obsidian-plugin install/update fix. Its presence tells the
   * browser to route the fix through the backend `ObsidianPluginBackendService`
   * (writing into `<book>/.obsidian/`) instead of the normal FileService create.
   */
  obsidianPlugin?: ObsidianPluginFix;
  /**
   * Present on the legacy-AI-settings migration fix. Its presence tells the
   * browser to route the fix through the backend `migrateAiSettings` call (a
   * surgical, comment-preserving rewrite of `.theia/settings.json`) instead of
   * the normal FileService create.
   */
  aiSettings?: AiSettingsMigrationFix;
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

/**
 * Marker attached to the legacy-AI-settings migration fix. Carries the legacy
 * `aiFocusedEditor.ai.*` keys found in the workspace settings file (for the
 * label/message); the node-side fix rewrites them to their `aiConnect.*` twins.
 */
export interface AiSettingsMigrationFix {
  /** Legacy keys present in `.theia/settings.json` (mapping order). */
  legacyKeys: string[];
}

/** A report-only observation the doctor surfaces but never auto-changes. */
export interface BookDoctorFinding {
  /** Category, for grouping/telemetry. */
  kind: 'metadata' | 'parse-error' | 'entity' | 'settings';
  /**
   * Optional severity hint for rendering (defaults to informational). Only the
   * settings findings set this today (`warning`); the rest stay informational.
   */
  severity?: 'info' | 'warning';
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
  /** Entity cards already present on disk (scanned per effective-type directory). */
  existingEntityCards?: EntityCardRef[];
  /**
   * The EFFECTIVE entity types (built-in + author-declared from `entities/types.yaml`)
   * the entity checks resolve tag/card kinds against. When absent, the built-in set
   * is used, so a caller that passes no author types behaves exactly as before.
   */
  effectiveEntityTypes?: readonly EntityTypeDescriptor[];
  /**
   * Validation problems from parsing `entities/types.yaml` (from the registry
   * parse), surfaced as `entity-type-problem` findings. Empty/absent when the file
   * is absent, empty, or fully valid.
   */
  entityTypeProblems?: readonly EntityTypeProblem[];
  /**
   * Obsidian-companion-plugin status (bundled/installed versions + `.obsidian/`
   * presence), gathered from the backend. When present, drives the install/update
   * fix. Absent (or a `null` bundled version) yields no plugin fix.
   */
  obsidianPlugin?: ObsidianPluginCheckInput;
  /**
   * Raw text of the workspace `.theia/settings.json` (may be JSONC or malformed).
   * `undefined` when the file is absent — then the legacy-AI-settings check is
   * skipped entirely. Drives the `migrate-ai-settings` fix / `legacy-ai-settings`
   * finding.
   */
  workspaceSettings?: string;
}

/** Resolved inputs for {@link obsidianPluginFindings}. */
export interface ObsidianPluginCheckInput {
  /** Version of the currently-installed plugin, or `null`/absent when not installed. */
  installedVersion?: string | null;
  /** Version bundled with the app, or `null` when the assets are unavailable. */
  bundledVersion: string | null;
  /** Whether the book folder already has an `.obsidian/` directory. */
  hasObsidianDir: boolean;
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

/* ----------------------------------------------------------------------- */
/* Effective-type lookups (STAGE — author-declared types go dynamic)         */
/*                                                                           */
/* The entity checks below resolve tag/card kinds against the EFFECTIVE type */
/* list (built-in + author-declared) passed in, defaulting to the built-in   */
/* set so every prior caller/behaviour stays byte-identical. An author type  */
/* declared in entities/types.yaml is thus treated as known.                 */
/* ----------------------------------------------------------------------- */

/** The descriptor in `types` whose tag kind matches, or undefined. */
function typeByTagKind(types: readonly EntityTypeDescriptor[], tagKind: string): EntityTypeDescriptor | undefined {
  return types.find(type => type.tagKind === tagKind);
}

/** The descriptor in `types` whose kind id matches, or undefined. */
function typeById(types: readonly EntityTypeDescriptor[], id: string): EntityTypeDescriptor | undefined {
  return types.find(type => type.id === id);
}

/** Map a tag kind to its kind id via `types`; an unknown tag kind passes through verbatim. */
function effectiveTagKindToKind(types: readonly EntityTypeDescriptor[], tagKind: string): string {
  return typeByTagKind(types, tagKind)?.id ?? tagKind;
}

/** Workspace-relative card path from a descriptor: `entities/<dir>/<id>.yaml`. */
function entityCardPath(descriptor: EntityTypeDescriptor, id: string): string {
  return `entities/${descriptor.directory}/${id}.yaml`;
}

/** Composite `(kind, id)` map key: a single space separates the two tokens. */
function entityCardKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
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
 * kind resolves to an EFFECTIVE entity type (built-in OR author-declared) but
 * whose `entities/<dir>/<id>.yaml` card is absent becomes one create fix per
 * unique `(kind, id)`, the directory taken from the resolved descriptor. Bare
 * `[[id]]` occurrences (no kind) can never create a card — a card needs a kind —
 * and are skipped here; unknown (non-effective) kinds are skipped too (check C). The
 * seed name prefers the most frequent label across occurrences, else the
 * humanized id. The description carries the mention count and first file.
 */
export function entityCardMissingFixes(
  occurrences: EntityTagOccurrence[],
  existingCards: EntityCardRef[],
  effectiveTypes: readonly EntityTypeDescriptor[] = BASE_ENTITY_TYPES
): BookDoctorFix[] {
  const existing = new Set(existingCards.map(card => entityCardKey(card.kind, card.id)));
  const fixes: BookDoctorFix[] = [];
  for (const occurrence of occurrences) {
    if (!occurrence.kind) {
      // A bare `[[id]]` names no kind — a card cannot be materialized from it.
      continue;
    }
    const descriptor = typeByTagKind(effectiveTypes, occurrence.kind);
    if (!descriptor) {
      // Well-formed but non-effective kind — reported by entityUnknownKindFindings.
      continue;
    }
    const entityKind = descriptor.id;
    if (existing.has(entityCardKey(entityKind, occurrence.id))) {
      continue;
    }
    const name = entityCardName(occurrence);
    fixes.push({
      path: entityCardPath(descriptor, occurrence.id),
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
  existingCards: EntityCardRef[],
  effectiveTypes: readonly EntityTypeDescriptor[] = BASE_ENTITY_TYPES
): BookDoctorFinding[] {
  const findings: BookDoctorFinding[] = [];
  for (const card of existingCards) {
    const referenced = occurrences.some(
      occurrence =>
        occurrence.id === card.id &&
        (occurrence.kind === undefined || effectiveTagKindToKind(effectiveTypes, occurrence.kind) === card.kind)
    );
    if (referenced) {
      continue;
    }
    const descriptor = typeById(effectiveTypes, card.kind);
    const label = descriptor?.label ?? card.kind;
    const path = descriptor
      ? entityCardPath(descriptor, card.id)
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
 * well-formed (`[a-z][\w-]*`) but not in the EFFECTIVE type list — neither a
 * built-in nor an author-declared type (e.g. `[[spell:fireball]]` when no `spell`
 * type is declared). A kind an author DID declare in `entities/types.yaml` is
 * treated as known and never reported here. Grouped by kind with the total tag
 * count and the distinct id count. Phrased so it reads as a prompt to define the
 * type (the author-defined-types tie-in).
 */
export function entityUnknownKindFindings(
  occurrences: EntityTagOccurrence[],
  effectiveTypes: readonly EntityTypeDescriptor[] = BASE_ENTITY_TYPES
): BookDoctorFinding[] {
  const wellFormed = /^[a-z][\w-]*$/;
  const byKind = new Map<string, { count: number; ids: Set<string> }>();
  for (const occurrence of occurrences) {
    if (!occurrence.kind || typeByTagKind(effectiveTypes, occurrence.kind) || !wellFormed.test(occurrence.kind)) {
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
 * Entity check D — `entity-type-problem` (INFORMATIONAL): surfaces each validation
 * problem the registry found while parsing the book's `entities/types.yaml` (a bad
 * shape, a missing/invalid id, a collision with a built-in or another author type,
 * …). Each problem becomes one report-only row so the author can see WHY a declared
 * type was rejected (a rejected type never reaches the effective list, so its tags
 * would otherwise silently show up under `entity-tag-unknown-kind`). The parser's
 * English message is carried verbatim; `params` expose the offending id (or the
 * problem code when none was captured) and that message for localized rendering.
 */
export function entityTypeProblemFindings(problems: readonly EntityTypeProblem[]): BookDoctorFinding[] {
  return problems.map(problem => {
    const subject = problem.id && problem.id.trim() ? problem.id : problem.code;
    return {
      kind: 'entity',
      code: 'entity-type-problem',
      params: [subject, problem.message],
      label: `entities/types.yaml: problem with "${subject}"`,
      detail: problem.message
    };
  });
}

/* ----------------------------------------------------------------------- */
/* Obsidian companion plugin (install the field notebook into the book)      */
/* ----------------------------------------------------------------------- */

/**
 * Compare two semver-ish version strings by their leading numeric triple
 * (`major.minor.patch`; a missing component is 0, non-numeric junk is 0, extra
 * components beyond the third are ignored). Returns a negative number when `a` is
 * older than `b`, a positive number when newer, and 0 when equal. Pure and total
 * — never throws on malformed input (both sides degrade to their numeric prefix).
 */
export function compareVersionTriples(a: string, b: string): number {
  const parse = (value: string): [number, number, number] => {
    const parts = value.trim().split('.');
    const at = (index: number): number => {
      const digits = /^\d+/.exec(parts[index]?.trim() ?? '');
      return digits ? Number.parseInt(digits[0], 10) : 0;
    };
    return [at(0), at(1), at(2)];
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

/**
 * Obsidian-plugin check — offer to install the AFE Companion plugin when it is
 * absent (a `hint`, since installing it turns the book folder into a ready
 * Obsidian vault) or to update it when an OLDER version is installed (a
 * `warning`). Returns a single fix routed through the backend installer (marked
 * with {@link ObsidianPluginFix}), or an empty list when nothing is needed.
 *
 * A `null` `bundledVersion` (the app shipped without the plugin assets) yields NO
 * fix — there is nothing to install from. An installed version equal to or newer
 * than the bundled one also yields nothing.
 */
export function obsidianPluginFindings(input: ObsidianPluginCheckInput): BookDoctorFix[] {
  const { bundledVersion, hasObsidianDir } = input;
  if (bundledVersion == null) {
    return [];
  }
  const installedVersion = input.installedVersion ?? null;
  const path = `.obsidian/plugins/${OBSIDIAN_PLUGIN_ID}`;

  if (installedVersion == null) {
    return [{
      path,
      kind: 'file',
      code: 'install-obsidian-plugin',
      params: [bundledVersion],
      description:
        `Install the Obsidian companion plugin (AFE Companion ${bundledVersion}) into this book — ` +
        'the folder becomes a ready Obsidian vault.',
      obsidianPlugin: {
        mode: 'install',
        severity: 'hint',
        installedVersion: null,
        bundledVersion,
        hasObsidianDir
      }
    }];
  }

  if (compareVersionTriples(installedVersion, bundledVersion) < 0) {
    return [{
      path,
      kind: 'file',
      code: 'update-obsidian-plugin',
      params: [installedVersion, bundledVersion],
      description:
        `Update the Obsidian companion plugin (installed ${installedVersion}, bundled ${bundledVersion}).`,
      obsidianPlugin: {
        mode: 'update',
        severity: 'warning',
        installedVersion,
        bundledVersion,
        hasObsidianDir
      }
    }];
  }

  return [];
}

/* ----------------------------------------------------------------------- */
/* Legacy AI settings migration (aiFocusedEditor.ai.* -> aiConnect.*)         */
/* ----------------------------------------------------------------------- */

/**
 * Legacy-AI-settings check — inspect the workspace `.theia/settings.json` text
 * for retired `aiFocusedEditor.ai.*` keys:
 *  - keys present → a `migrate-ai-settings` FIX (rewrites them to the neutral
 *    `aiConnect.*` twins, comment-preserving) plus a `legacy-ai-settings`
 *    report finding (severity warning);
 *  - malformed JSON → a report-only `legacy-ai-settings-malformed` finding, and
 *    NO fix (the doctor never rewrites an unparseable settings file);
 *  - absent file / no legacy keys → nothing.
 */
export function aiSettingsMigrationChecks(rawSettings: string | undefined): {
  fix?: BookDoctorFix;
  finding?: BookDoctorFinding;
} {
  if (rawSettings === undefined) {
    return {};
  }
  const scan = scanLegacyAiSettings(rawSettings);
  if (scan.malformed) {
    return {
      finding: {
        kind: 'settings',
        severity: 'warning',
        code: 'legacy-ai-settings-malformed',
        label: `${WORKSPACE_SETTINGS_PATH} could not be parsed`,
        detail: `${WORKSPACE_SETTINGS_PATH} is not valid JSON, so the doctor could not check it for legacy AI settings. Fix the JSON syntax, then re-run the doctor to migrate any aiFocusedEditor.ai.* keys.`
      }
    };
  }
  if (scan.legacyKeys.length === 0) {
    return {};
  }
  const keyList = scan.legacyKeys.join(', ');
  return {
    fix: {
      path: WORKSPACE_SETTINGS_PATH,
      kind: 'file',
      code: 'migrate-ai-settings',
      params: [scan.legacyKeys.length, keyList],
      description: `Migrate ${scan.legacyKeys.length} legacy AI setting(s) to aiConnect.* (${keyList}).`,
      aiSettings: { legacyKeys: [...scan.legacyKeys] }
    },
    finding: {
      kind: 'settings',
      severity: 'warning',
      code: 'legacy-ai-settings',
      params: [scan.legacyKeys.length, keyList],
      label: `Legacy AI settings in ${WORKSPACE_SETTINGS_PATH}`,
      detail: `${scan.legacyKeys.length} legacy aiFocusedEditor.ai.* key(s) in ${WORKSPACE_SETTINGS_PATH} (${keyList}). These have been renamed to aiConnect.*; apply the fix to migrate them.`
    }
  };
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
 * the entity findings (orphan cards, unknown tag kinds, then `entities/types.yaml`
 * validation problems).
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

  // Entity base: create a card for every effective-kind (built-in OR author) tag
  // that has none. Author-declared types come in via `effectiveEntityTypes`.
  const occurrences = input.entityTagOccurrences ?? [];
  const existingCards = input.existingEntityCards ?? [];
  const effectiveTypes = input.effectiveEntityTypes ?? BASE_ENTITY_TYPES;
  for (const fix of entityCardMissingFixes(occurrences, existingCards, effectiveTypes)) {
    push(fix);
  }

  // Obsidian companion plugin: offer to install/update the field notebook into
  // the book's `.obsidian/` so the folder doubles as a ready Obsidian vault.
  if (input.obsidianPlugin) {
    for (const fix of obsidianPluginFindings(input.obsidianPlugin)) {
      push(fix);
    }
  }

  // Legacy AI settings: migrate retired aiFocusedEditor.ai.* keys in the
  // workspace settings file to their neutral aiConnect.* twins.
  const aiSettings = aiSettingsMigrationChecks(input.workspaceSettings);
  if (aiSettings.fix) {
    push(aiSettings.fix);
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
  findings.push(...entityCardOrphanFindings(occurrences, existingCards, effectiveTypes));
  findings.push(...entityUnknownKindFindings(occurrences, effectiveTypes));
  findings.push(...entityTypeProblemFindings(input.entityTypeProblems ?? []));
  if (aiSettings.finding) {
    findings.push(aiSettings.finding);
  }

  return { fixes, findings };
}
