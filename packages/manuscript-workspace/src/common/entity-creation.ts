/**
 * Pure helpers for creating narrative entities (characters/terms/artifacts/
 * locations) and knowledge notes from editor selections. Kept Theia-free so id
 * generation, YAML shaping, and path uniqueness are unit-testable in isolation;
 * the browser contribution layers QuickInputService prompts and FileService
 * writes on top (mirroring the "Save Selection as Citation..." UX in
 * `source-library-view-contribution.ts`).
 */

import { stringify } from 'yaml';

/** Entity kinds creatable from an editor selection. */
export type CreatableEntityKind = 'character' | 'term' | 'artifact' | 'location';

/** All creatable entity kinds, in a stable display/iteration order. */
export const CREATABLE_ENTITY_KINDS: readonly CreatableEntityKind[] = ['character', 'term', 'artifact', 'location'];

/** Directory under `entities/` each kind's YAML files live in. */
export const ENTITY_KIND_DIRECTORY: Record<CreatableEntityKind, string> = {
  character: 'characters',
  term: 'terms',
  artifact: 'artifacts',
  location: 'locations'
};

/**
 * Semantic tag kind used inside `[[kind:id|label]]` markdown tags for each
 * entity kind. Characters use the `char` shorthand (spec §3.4, mirrored from
 * `tagKindToEntityKind` in `link-navigation.ts`); every other kind is verbatim.
 */
export const ENTITY_KIND_TAG: Record<CreatableEntityKind, string> = {
  character: 'char',
  term: 'term',
  artifact: 'artifact',
  location: 'location'
};

/** Human-readable label for each entity kind, for UI prompts/menus. */
export const ENTITY_KIND_LABEL: Record<CreatableEntityKind, string> = {
  character: 'Character',
  term: 'Term',
  artifact: 'Artifact',
  location: 'Location'
};

/**
 * Deterministic base-36 hash of `text`, used as a fallback suffix when a slug
 * would otherwise be empty or a path collision must be broken. Mirrors the
 * `hashLabel` bit-shift hash from `semantic-markdown-actions-contribution.ts`
 * (see the sync-comment on `createSemanticEntityId` below) so hash fallbacks
 * stay deterministic and collision-resistant across this module.
 */
function hash36(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Practical Russian-to-Latin transliteration map, keyed by lowercase Cyrillic
 * letter (Unicode escapes used for source-file portability across editors/
 * encodings; each key is the single Cyrillic letter U+0430 `а` .. U+044F `я`
 * plus `ё` `ё`). `transliterate` below handles both letter cases by
 * looking up the lowercased character and re-casing the mapped result, since
 * the slug pipeline lowercases its output anyway. `ъ` (hard sign) and
 * `ь` (soft sign) map to the empty string (dropped) rather than a
 * Latin letter.
 */
const CYRILLIC_TRANSLITERATION_MAP: Record<string, string> = {
  'а': 'a', // а
  'б': 'b', // б
  'в': 'v', // в
  'г': 'g', // г
  'д': 'd', // д
  'е': 'e', // е
  'ё': 'e', // ё
  'ж': 'zh', // ж
  'з': 'z', // з
  'и': 'i', // и
  'й': 'i', // й
  'к': 'k', // к
  'л': 'l', // л
  'м': 'm', // м
  'н': 'n', // н
  'о': 'o', // о
  'п': 'p', // п
  'р': 'r', // р
  'с': 's', // с
  'т': 't', // т
  'у': 'u', // у
  'ф': 'f', // ф
  'х': 'h', // х
  'ц': 'ts', // ц
  'ч': 'ch', // ч
  'ш': 'sh', // ш
  'щ': 'sch', // щ
  'ъ': '', // ъ (hard sign, dropped)
  'ы': 'y', // ы
  'ь': '', // ь (soft sign, dropped)
  'э': 'e', // э
  'ю': 'yu', // ю
  'я': 'ya' // я
};

/**
 * Transliterate Cyrillic characters in `text` to their practical Latin
 * equivalents (e.g. "проверка" -> "proverka", "Кришна" -> "Krishna"),
 * preserving case shape per-letter (the overall slug pipeline lowercases the
 * result afterwards, but this keeps the helper meaningful standalone).
 * Characters outside the Cyrillic map (Latin letters, digits, punctuation,
 * other scripts such as CJK) pass through untouched.
 */
export function transliterate(text: string): string {
  let result = '';
  for (const character of text) {
    const lower = character.toLowerCase();
    const mapped = CYRILLIC_TRANSLITERATION_MAP[lower];
    if (mapped === undefined) {
      result += character;
      continue;
    }
    result += character === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }
  return result;
}

/**
 * Build a semantic-tag-safe id from a free-form label. First transliterates
 * Cyrillic characters to Latin via `transliterate` (so e.g. "проверка"
 * becomes `proverka` instead of falling back to a hash id), then mirrors
 * `createSemanticId`/`hashLabel` in
 * `semantic-markdown-actions-contribution.ts` (~line 336): NFKD-normalize,
 * strip combining marks, lowercase, collapse any run of characters outside
 * `[a-z0-9_.:-]` into a single `-`, trim leading/trailing `-`, cap at 48
 * characters, and fall back to `${kind}-${hash36(label)}` when the slug is
 * empty (e.g. a CJK-only label has no Latin/digit/Cyrillic characters and
 * still produces an empty slug after the allowed-character filter). Copied
 * rather than imported so this Theia-free module has no dependency on the
 * browser contribution, and kept byte-for-byte identical (modulo the
 * transliteration pre-step) so a tag id and the entity file id it points at
 * always agree.
 */
export function createSemanticEntityId(kind: string, label: string): string {
  const slug = transliterate(label)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return slug || `${kind}-${hash36(label)}`;
}

/**
 * Render a new entity YAML file body. Always includes `id`, `name`, and an
 * empty `aliases: []` (matching the shape of hand-authored entity files under
 * `examples/sample-book/entities/`); `summary` is included only when it is
 * non-blank after trimming. Key order is fixed (`id`, `name`, `aliases`,
 * `summary`) to match the example entity files.
 */
export function buildEntityYaml(input: { id: string; name: string; summary?: string }): string {
  const trimmedSummary = input.summary?.trim();
  const record: { id: string; name: string; aliases: string[]; summary?: string } = {
    id: input.id,
    name: input.name,
    aliases: []
  };
  if (trimmedSummary) {
    record.summary = trimmedSummary;
  }
  return stringify(record);
}

/** Workspace-relative path for a new entity YAML file: `entities/<dir>/<id>.yaml`. */
export function entityRelativePath(kind: CreatableEntityKind, id: string): string {
  return `entities/${ENTITY_KIND_DIRECTORY[kind]}/${id}.yaml`;
}

/**
 * Resolve a collision-free workspace-relative path. When `desired` is free
 * (per `exists`) it is returned unchanged; otherwise numeric suffixes
 * `-2`, `-3`, ... are inserted before the extension until a free candidate is
 * found. After 99 numbered attempts this gives up on incrementing and appends
 * a deterministic hash suffix instead, so the function always terminates in
 * bounded time regardless of how many candidates `exists` rejects.
 */
export function uniqueRelativePath(desired: string, exists: (candidate: string) => boolean): string {
  if (!exists(desired)) {
    return desired;
  }

  const lastSlash = desired.lastIndexOf('/');
  const lastDot = desired.lastIndexOf('.');
  const hasExtension = lastDot > lastSlash;
  const base = hasExtension ? desired.slice(0, lastDot) : desired;
  const extension = hasExtension ? desired.slice(lastDot) : '';

  for (let suffix = 2; suffix <= 99; suffix++) {
    const candidate = `${base}-${suffix}${extension}`;
    if (!exists(candidate)) {
      return candidate;
    }
  }

  return `${base}-${hash36(desired)}${extension}`;
}

/**
 * Suggest an entity name from an editor selection: the first non-blank line,
 * whitespace collapsed to single spaces, `[`, `]`, and `|` characters
 * stripped (they collide with markdown link/tag syntax), capped at 60
 * characters. Truncation prefers a word boundary — it cuts at the last space
 * within the limit as long as that keeps at least half the budget, otherwise
 * it hard-cuts (e.g. a single very long word).
 */
export function suggestEntityName(selection: string): string {
  const firstNonBlankLine = selection.split('\n').find(line => line.trim().length > 0) ?? '';
  const collapsed = firstNonBlankLine.replace(/\s+/g, ' ').trim();
  const stripped = collapsed.replace(/[[\]|]/g, '').trim();
  return truncateAtWordBoundary(stripped, 60);
}

function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const slice = text.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= maxLength / 2) {
    return slice.slice(0, lastSpace).trim();
  }
  return slice.trim();
}

/**
 * Derive an entity `summary` from an editor selection, normalized to single
 * spaces and capped at 500 characters. Returns `undefined` when the selection
 * adds nothing over the entity `name`: when it is too short (under 12
 * characters) to carry information beyond the name, or when it normalizes to
 * exactly the same text as `name`.
 */
export function selectionToSummary(selection: string, name: string): string | undefined {
  const normalized = selection.trim().replace(/\s+/g, ' ');
  if (normalized.length < 12) {
    return undefined;
  }
  const normalizedName = name.trim().replace(/\s+/g, ' ');
  if (normalized === normalizedName) {
    return undefined;
  }
  return normalized.length > 500 ? normalized.slice(0, 500).trim() : normalized;
}

/**
 * True when a selection is a good candidate for wrapping as a `[[kind:id]]`
 * tag: single-line once trimmed, between 1 and 120 characters, and not
 * already a wrapped tag (`[[...]]`) — re-wrapping an existing tag would nest
 * brackets.
 */
export function shouldWrapSelectionAsTag(selection: string): boolean {
  const trimmed = selection.trim();
  if (trimmed.length === 0 || trimmed.includes('\n')) {
    return false;
  }
  if (trimmed.length > 120) {
    return false;
  }
  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
    return false;
  }
  return true;
}

/** Subdirectories under `knowledge/` a note can be filed into. */
export const KNOWLEDGE_CATEGORIES: readonly string[] = ['plans', 'questions', 'summaries'];

/**
 * Workspace-relative path for a new knowledge note:
 * `knowledge/<category>/<slug>.md` when a category is given, otherwise
 * `knowledge/<slug>.md`. The slug is derived from `title` via
 * `createSemanticEntityId('note', title)`.
 */
export function knowledgeNoteRelativePath(category: string | undefined, title: string): string {
  const slug = createSemanticEntityId('note', title);
  return category ? `knowledge/${category}/${slug}.md` : `knowledge/${slug}.md`;
}

/** Minimal markdown body for a new knowledge note: an H1 title and a blank line. */
export function buildKnowledgeNoteMarkdown(title: string): string {
  return `# ${title}\n\n`;
}

/** Workspace-relative folder for a new book skill: `.prompts/skills/<slug>`. */
export function skillFolderRelativePath(slug: string): string {
  return `.prompts/skills/${slug}`;
}

/**
 * Render a new `SKILL.md`: a YAML frontmatter block (`name`, `description`) —
 * the exact contract Theia's SkillService reads — followed by a short starter
 * body explaining that the skill becomes `{{skill:<slug>}}` in chat. The
 * frontmatter is emitted through the YAML serializer so names/descriptions with
 * colons, quotes, or other special characters stay valid.
 */
export function buildSkillMarkdown(slug: string, name: string, description: string): string {
  const frontmatter = stringify({ name, description }).trimEnd();
  return [
    '---',
    frontmatter,
    '---',
    '',
    `# ${name}`,
    '',
    'Describe the voice, terminology, and formatting rules the AI should follow',
    'for this book. The editor discovers this skill automatically and offers it in',
    'the AI chat Skills list.',
    '',
    `Reference it from a prompt with \`{{skill:${slug}}}\` (or pull in every skill`,
    'with `{{skills}}`).',
    ''
  ].join('\n');
}
