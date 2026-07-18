/**
 * Pure (Theia-free) contract describing the CANONICAL book workspace
 * structure: the folders and seed files a well-formed manuscript workspace is
 * expected to contain.
 *
 * Two consumers code against this module:
 *  - a "Book Doctor" that inspects an existing workspace, reports what is
 *    missing (via {@link missingScaffoldEntries}), and creates it; and
 *  - a "New Book" wizard that materializes the whole scaffold for a fresh book
 *    (via {@link bookScaffoldEntries} with {@link NewBookOptions}).
 *
 * The shapes here are derived from the real artifacts already in the repo — the
 * hand-authored `examples/sample-book/` layout, the entity/knowledge tables in
 * `./entity-creation`, and the blank-file starters used by the book-config
 * editor (see the sync-comment on the starter constants below). Kept Theia-free
 * so ordering, seed shaping, and path logic are unit-testable in isolation; the
 * browser/node layers add FileService writes on top.
 */

import { stringify } from 'yaml';
import {
  CREATABLE_ENTITY_KINDS,
  ENTITY_KIND_DIRECTORY,
  ENTITY_KIND_LABEL,
  KNOWLEDGE_CATEGORIES,
  createSemanticEntityId
} from './entity-creation';

/** Whether a scaffold entry is a directory or a seeded file. */
export type ScaffoldEntryKind = 'folder' | 'file';

/**
 * How strongly an entry belongs to a canonical book:
 *  - `required`   — a well-formed book must have it; the doctor always offers to create it.
 *  - `recommended` — expected for a full-featured book, but its absence is not a defect
 *    (e.g. a book whose `content/` already holds other chapters does not need the
 *    starter `content/chapter-01.md`).
 */
export type ScaffoldLevel = 'required' | 'recommended';

/** One folder or seed file in the canonical book scaffold. */
export interface BookScaffoldEntry {
  /** Workspace-relative path, forward slashes, no leading `./`. Folders carry no trailing slash. */
  path: string;
  /** Whether this entry is a directory or a file. */
  kind: ScaffoldEntryKind;
  /** How strongly the entry belongs to a canonical book. */
  level: ScaffoldLevel;
  /** Starter file content, present for `file` entries only (folders have no seed). */
  seed?: string;
  /** Short human-readable purpose (English), for doctor/wizard UI. */
  description: string;
}

/** Inputs for materializing a brand-new book scaffold. */
export interface NewBookOptions {
  /** Book title; written into `metadata.yaml`. */
  title: string;
  /** Optional author; written into `metadata.yaml` (empty when omitted). */
  author?: string;
  /** BCP-47-ish language code; defaults to {@link DEFAULT_BOOK_LANGUAGE}. */
  language?: string;
  /** Title of the seeded first chapter; defaults to {@link DEFAULT_FIRST_CHAPTER_TITLE}. */
  firstChapterTitle?: string;
}

/** Default `language` for a new book when {@link NewBookOptions.language} is omitted. */
export const DEFAULT_BOOK_LANGUAGE = 'ru';

/** Default first-chapter title when {@link NewBookOptions.firstChapterTitle} is omitted. */
export const DEFAULT_FIRST_CHAPTER_TITLE = 'Chapter 1';

/** Placeholder title used when {@link bookScaffoldEntries} is called without options. */
const DEFAULT_BOOK_TITLE = 'Untitled';

/** The starter first chapter — a new-book-only entry (see {@link isNewBookOnlyEntry}). */
const CHAPTER_01_PATH = 'content/chapter-01.md';

/** The book-native proofreading area — a new-book-only entry (see {@link isNewBookOnlyEntry}). */
const PROOFREADING_AREA_PATH = 'proofreading';

/**
 * Scaffold paths that only make sense for a brand-new book: the doctor skips
 * offering them on an established book (one whose `content/` already holds
 * Markdown), while the New Book wizard materializes them unconditionally. The
 * empty `proofreading/` area is created for new books but never nagged onto an
 * existing book that legitimately has no proofreading sets.
 */
const NEW_BOOK_ONLY_PATHS: ReadonlySet<string> = new Set([CHAPTER_01_PATH, PROOFREADING_AREA_PATH]);

/*
 * Canonical starter YAML shapes for the config files that carry no per-book
 * options. Kept in sync with the book-config editor's blank-file starters
 * (`STARTER_METADATA_YAML` / `STARTER_MANIFEST_YAML` in
 * `src/browser/book-config-editor-frontend-module.ts`) and the on-disk
 * `examples/sample-book/` files. Copied here (not imported) so this module
 * stays Theia-free — SYNC-COMMENT: if those browser starters or the example
 * files change shape, update these constants to match.
 */

/** `manifest.yaml` seed for a book with no starting chapter — mirrors `STARTER_MANIFEST_YAML`. */
const STARTER_MANIFEST_YAML = 'version: 1\ncontent: []\n';

/** `sources/citations.yaml` seed — an empty citation registry (`{ version: 1, citations: [] }`). */
const STARTER_CITATIONS_YAML = 'version: 1\ncitations: []\n';

/** `ai/prompts/custom-modes.yaml` seed — an empty custom-mode registry (`{ version: 1, modes: [] }`). */
const STARTER_CUSTOM_MODES_YAML = 'version: 1\nmodes: []\n';

/**
 * `.prompts/skills/style-guide/SKILL.md` seed — a worked example skill. The
 * YAML frontmatter (`name` + `description`) is what Theia's DefaultSkillService
 * reads; the Markdown body explains the discovery mechanism so authors can copy
 * the folder to make their own book skills.
 */
const STARTER_STYLE_GUIDE_SKILL_MD = `---
name: style-guide
description: Стилевые правила этой книги
---

# Style guide

This is an example **workspace skill**. The editor discovers every
\`.prompts/skills/<slug>/SKILL.md\` in this book and offers it in the AI chat's
Skills list; you can also reference it from a prompt with \`{{skill:style-guide}}\`
(or pull in all skills with \`{{skills}}\`).

Replace this body with the actual voice, tense, terminology, and formatting
rules the AI should follow when it drafts or revises text for this book. To add
another skill, copy this folder under \`.prompts/skills/\` and change the
\`name\`/\`description\` in the frontmatter.
`;

/** Short descriptions for the `knowledge/` subcategories in {@link KNOWLEDGE_CATEGORIES}. */
const KNOWLEDGE_CATEGORY_DESCRIPTION: Record<string, string> = {
  plans: 'Planning notes: outlines and roadmaps.',
  questions: 'Open developmental questions about the manuscript.',
  summaries: 'Chapter and scene summaries.'
};

/** Fully-resolved book options with defaults applied (author stays optional). */
interface ResolvedBookOptions {
  title: string;
  author?: string;
  language: string;
  firstChapterTitle: string;
}

/**
 * Apply defaults to (possibly absent) {@link NewBookOptions}. Blank/whitespace
 * title, language, and chapter title fall back to their defaults; a non-blank
 * value is preserved verbatim (leading/trailing spaces are quoted, not
 * trimmed, so authorial intent survives).
 */
function resolveOptions(options?: NewBookOptions): ResolvedBookOptions {
  return {
    title: options?.title && options.title.trim() ? options.title : DEFAULT_BOOK_TITLE,
    author: options?.author,
    language: options?.language && options.language.trim() ? options.language : DEFAULT_BOOK_LANGUAGE,
    firstChapterTitle:
      options?.firstChapterTitle && options.firstChapterTitle.trim()
        ? options.firstChapterTitle
        : DEFAULT_FIRST_CHAPTER_TITLE
  };
}

/**
 * Render a single scalar value as safe inline YAML using the `yaml` package's
 * minimal quoting (plain when possible; quoted only when required — a leading
 * `:` conflict, leading/trailing spaces, the empty string, etc.), with the
 * trailing newline stripped so it embeds directly after `key: `. Values are
 * expected to be single-line (titles/authors/language codes/chapter titles);
 * this mirrors how `buildEntityYaml` delegates escaping to `yaml`, so arbitrary
 * titles with apostrophes, quotes, colons, or Cyrillic round-trip safely.
 */
function yamlScalar(value: string): string {
  return stringify(value).replace(/\n+$/, '');
}

/**
 * Build the `metadata.yaml` seed. Always emits `title`, `author`, and
 * `language` keys (author is empty when omitted) in that order, matching the
 * keys the metadata form editor reads (`extractMetadataFields` in
 * `./book-config-forms`).
 */
function buildMetadataYaml(resolved: ResolvedBookOptions): string {
  const author = resolved.author ?? '';
  return `title: ${yamlScalar(resolved.title)}\nauthor: ${yamlScalar(author)}\nlanguage: ${yamlScalar(resolved.language)}\n`;
}

/**
 * Build the `manifest.yaml` seed. With no options this is the empty starter
 * manifest; with options it lists the seeded first chapter so the manifest and
 * `content/chapter-01.md` agree. The shape parses to `{ version, content }`,
 * exactly what `flattenManifestRows` in `./book-config-forms` reads.
 */
function buildManifestYaml(resolved: ResolvedBookOptions, hasOptions: boolean): string {
  if (!hasOptions) {
    return STARTER_MANIFEST_YAML;
  }
  return `version: 1\ncontent:\n  - path: ${CHAPTER_01_PATH}\n    title: ${yamlScalar(resolved.firstChapterTitle)}\n`;
}

/**
 * The canonical book scaffold: every folder and seed file a well-formed book
 * workspace is expected to contain, ordered PARENTS-BEFORE-CHILDREN so a
 * consumer can create entries sequentially without pre-creating directories.
 *
 * Pass {@link NewBookOptions} to seed `metadata.yaml`, `manifest.yaml`, and the
 * starter chapter from the wizard's inputs; call with no argument (the doctor's
 * mode) to get the same structure with neutral placeholder seeds. `folder`
 * entries carry no `seed`; `file` entries always do.
 */
export function bookScaffoldEntries(options?: NewBookOptions): BookScaffoldEntry[] {
  const resolved = resolveOptions(options);
  const hasOptions = options !== undefined;
  const entries: BookScaffoldEntry[] = [];

  // Root config files.
  entries.push({
    path: 'manifest.yaml',
    kind: 'file',
    level: 'required',
    seed: buildManifestYaml(resolved, hasOptions),
    description: 'Build manifest listing the chapters and parts included in the book, in reading order.'
  });
  entries.push({
    path: 'metadata.yaml',
    kind: 'file',
    level: 'required',
    seed: buildMetadataYaml(resolved),
    description: 'Book metadata (title, author, language) used by the editor and exporters.'
  });

  // Manuscript content.
  entries.push({
    path: 'content',
    kind: 'folder',
    level: 'required',
    description: 'Manuscript folder holding chapter and part Markdown files.'
  });
  entries.push({
    path: CHAPTER_01_PATH,
    kind: 'file',
    level: 'recommended',
    seed: buildChapterMarkdown(resolved.firstChapterTitle),
    description:
      'Starter first chapter for a new book; recommended-only, since an existing book may already ' +
      'have other files under content/, in which case a missing chapter-01.md is not a defect.'
  });

  // Narrative entities.
  entries.push({
    path: 'entities',
    kind: 'folder',
    level: 'required',
    description: 'Root folder for narrative entities referenced by [[kind:id|label]] semantic tags.'
  });
  for (const kind of CREATABLE_ENTITY_KINDS) {
    entries.push({
      path: `entities/${ENTITY_KIND_DIRECTORY[kind]}`,
      kind: 'folder',
      level: 'required',
      description: `${ENTITY_KIND_LABEL[kind]} entity YAML files.`
    });
  }

  // Research sources.
  entries.push({
    path: 'sources',
    kind: 'folder',
    level: 'required',
    description: 'Research sources, citations, and extracted excerpts.'
  });
  entries.push({
    path: 'sources/citations.yaml',
    kind: 'file',
    level: 'recommended',
    seed: STARTER_CITATIONS_YAML,
    description: 'Citation registry anchoring quotes to source documents.'
  });
  entries.push({
    path: 'sources/excerpts.jsonl',
    kind: 'file',
    level: 'recommended',
    seed: '',
    description: 'Extracted source excerpts, one JSON object per line.'
  });

  // Author knowledge base.
  entries.push({
    path: 'knowledge',
    kind: 'folder',
    level: 'recommended',
    description: 'Author knowledge base: plans, open questions, and summaries.'
  });
  for (const category of KNOWLEDGE_CATEGORIES) {
    entries.push({
      path: `knowledge/${category}`,
      kind: 'folder',
      level: 'recommended',
      description: KNOWLEDGE_CATEGORY_DESCRIPTION[category] ?? `Knowledge notes: ${category}.`
    });
  }

  // AI assistant configuration.
  entries.push({
    path: 'ai',
    kind: 'folder',
    level: 'recommended',
    description: 'AI assistant configuration for this book.'
  });
  entries.push({
    path: 'ai/prompts',
    kind: 'folder',
    level: 'recommended',
    description: 'Custom AI prompt and mode definitions.'
  });
  entries.push({
    path: 'ai/prompts/custom-modes.yaml',
    kind: 'file',
    level: 'recommended',
    seed: STARTER_CUSTOM_MODES_YAML,
    description: 'Custom AI modes (prompts, agents) available in the editor.'
  });

  // Workspace skills. Theia's DefaultSkillService discovers per-book skills from
  // `.prompts/skills/<slug>/SKILL.md`; they surface in the chat's Skills group
  // and via the {{skill:...}}/{{skills}} prompt variables. Seeded with a
  // style-guide example so authors have a working template to copy.
  entries.push({
    path: '.prompts',
    kind: 'folder',
    level: 'recommended',
    description: 'Workspace prompt assets discovered by the AI chat (skills, prompt fragments).'
  });
  entries.push({
    path: '.prompts/skills',
    kind: 'folder',
    level: 'recommended',
    description: 'Per-book skills, one folder per skill, each with a SKILL.md; surfaced in the chat Skills group.'
  });
  entries.push({
    path: '.prompts/skills/style-guide',
    kind: 'folder',
    level: 'recommended',
    description: 'Example skill folder holding the book\'s style-guide SKILL.md.'
  });
  entries.push({
    path: '.prompts/skills/style-guide/SKILL.md',
    kind: 'file',
    level: 'recommended',
    seed: STARTER_STYLE_GUIDE_SKILL_MD,
    description: 'Seed style-guide skill: frontmatter (name/description) plus a body explaining how skills work.'
  });

  // Proofreading working copies. Each proofreading "set" is a
  // `proofreading/<slug>/` folder (created by the "New Proofreading Set…"
  // command); the area itself is seeded empty for a new book. New-book-only, so
  // the doctor never nags an established book that has no proofreading.
  entries.push({
    path: PROOFREADING_AREA_PATH,
    kind: 'folder',
    level: 'recommended',
    description: 'Proofreading working copies: one folder per set (scan↔text pairing, verified state).'
  });

  return entries;
}

/**
 * Filter `entries` down to those whose `path` does not yet exist, per the
 * caller's `exists` predicate. This is the doctor's core query: what is missing
 * and should be offered for creation. Order is preserved (still
 * parents-before-children), so the result can be created sequentially.
 */
export function missingScaffoldEntries(
  entries: BookScaffoldEntry[],
  exists: (path: string) => boolean
): BookScaffoldEntry[] {
  return entries.filter(entry => !exists(entry.path));
}

/**
 * True for an entry that only makes sense when creating a brand-new book — the
 * starter `content/chapter-01.md` and the empty `proofreading/` area. The doctor
 * uses this to skip offering these on an already-populated `content/` folder,
 * while the New Book wizard creates them unconditionally.
 */
export function isNewBookOnlyEntry(entry: BookScaffoldEntry): boolean {
  return NEW_BOOK_ONLY_PATHS.has(entry.path);
}

/**
 * Derive a filesystem-safe folder name for a new book from its title.
 * Delegates to `createSemanticEntityId('book', title)` from `./entity-creation`
 * so book folder names share the same slug rules as entity ids (NFKD slug,
 * capped at 48 chars, `book-<hash>` fallback for titles with no sluggable
 * characters, e.g. Cyrillic-only titles).
 */
export function slugifyBookFolderName(title: string): string {
  return createSemanticEntityId('book', title);
}

/** Minimal Markdown body for a starter chapter file: an H1 title and a blank line. */
export function buildChapterMarkdown(title: string): string {
  return `# ${title}\n\n`;
}
