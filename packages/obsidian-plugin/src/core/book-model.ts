/**
 * PURE (no Obsidian imports) book-structure model for the AFE Companion plugin.
 *
 * An AFE book is a plain folder: `manifest.yaml` (ordered parts/chapters),
 * `entities/**\/*.yaml` cards, and an optional `entities/types.yaml` declaring
 * author entity types. This module turns already-read file text into the ordered
 * chapter tree and the flat entity index the panel / autocomplete / navigation
 * consume. Reading the filesystem is the impure caller's job (Obsidian's Vault
 * API); everything here is text-in / model-out so it runs under `bun test`.
 *
 * Entity types are resolved through the SHARED registry
 * (`@ai-focused-editor/manuscript-workspace` `entity-type-registry`): the four
 * built-ins plus any valid `entities/types.yaml` author types. Author types are
 * therefore first-class — their `tagKind` autocompletes and navigates exactly
 * like a built-in's, per the studio contract.
 */

import { parse } from 'yaml';
import {
  BASE_ENTITY_TYPES,
  mergeEntityTypes,
  parseEntityTypesYaml,
  type EffectiveEntityType,
  type EntityTypeProblem
} from '@ai-focused-editor/manuscript-workspace/src/common/entity-type-registry';

/** One entry in the flat entity index (one narrative entity card). */
export interface EntityIndexEntry {
  /** Effective type id (e.g. `character`, `sloka`). */
  kind: string;
  /** Tag kind used inside `[[tagKind:id]]` (e.g. `char`, `sloka`, `персонаж`). */
  tagKind: string;
  /** Stable entity id (the card's `id`, else the filename stem). */
  id: string;
  /** Display label (the type's label field, else the id). */
  label: string;
  /** Vault-relative path of the card's `.yaml` file. */
  path: string;
  /** Aliases + epithets, for autocomplete / search matching. */
  aliases: string[];
}

/** A node in the manuscript tree: a chapter file or a part folder with children. */
export interface ChapterNode {
  /** Display title (manifest `title`, else a humanised filename). */
  title: string;
  /** Vault-relative path from the manifest (`content/…`), joined onto the book root by the caller. */
  path: string;
  /** Child nodes for a part folder; absent/empty for a leaf chapter. */
  children?: ChapterNode[];
}

/** The resolved entity-type set for a book (built-ins + author types) and any problems. */
export interface ResolvedTypes {
  types: EffectiveEntityType[];
  problems: EntityTypeProblem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detect book-root folders from the vault-relative paths of every `manifest.yaml`
 * in the vault. A book root is the vault root (`''`) when `manifest.yaml` sits at
 * the top, or a FIRST-LEVEL subfolder (`<name>`) when `<name>/manifest.yaml`
 * exists — supporting a vault that holds several books side by side. Deeper
 * manifests are ignored. Results are de-duplicated, roots sorted, with the vault
 * root (if present) first.
 */
export function detectBookRoots(manifestPaths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const raw of manifestPaths) {
    const path = raw.replace(/^\/+/, '');
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 1 && parts[0] === 'manifest.yaml') {
      roots.add('');
    } else if (parts.length === 2 && parts[1] === 'manifest.yaml') {
      roots.add(parts[0]);
    }
  }
  return [...roots].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
}

/**
 * Parse a `manifest.yaml`'s text into the ordered chapter tree. The manifest
 * shape is `{ version, content: [{ path, title?, children? }] }` (the studio's
 * build-manifest contract). Entries missing a `title` fall back to a humanised
 * filename; entries missing a `path` are skipped. A malformed / empty file yields
 * an empty list.
 */
export function parseManifest(text: string): ChapterNode[] {
  let document: unknown;
  try {
    document = parse(text);
  } catch {
    return [];
  }
  if (!isRecord(document) || !Array.isArray(document.content)) {
    return [];
  }
  return parseEntries(document.content);
}

function parseEntries(entries: readonly unknown[]): ChapterNode[] {
  const nodes: ChapterNode[] = [];
  for (const raw of entries) {
    if (!isRecord(raw)) {
      continue;
    }
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!path) {
      continue;
    }
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : humanizeFilename(path);
    const node: ChapterNode = { title, path };
    if (Array.isArray(raw.children)) {
      const children = parseEntries(raw.children);
      if (children.length > 0) {
        node.children = children;
      }
    }
    nodes.push(node);
  }
  return nodes;
}

/** Humanise a file/dir path into a title: basename without extension, `-`/`_` → spaces, capitalised. */
export function humanizeFilename(path: string): string {
  const base = path.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? path;
  const stem = base.replace(/\.[^.]+$/, '');
  const words = stem.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : base;
}

/**
 * Resolve the effective entity types for a book from its `entities/types.yaml`
 * text (pass `undefined`/empty when the file is absent). Built-ins always come
 * first; valid author types append. Delegates entirely to the shared registry so
 * author types behave identically to the studio.
 */
export function resolveEntityTypes(typesYaml: string | undefined): ResolvedTypes {
  const { types, problems } = parseEntityTypesYaml(typesYaml ?? '');
  return { types: mergeEntityTypes(BASE_ENTITY_TYPES, types), problems };
}

/** A raw entity card file to be indexed. */
export interface RawEntityFile {
  /** Vault-relative path of the `.yaml` file (e.g. `<root>/entities/characters/krishna.yaml`). */
  path: string;
  /** The `entities/` subdirectory the file lives in (e.g. `characters`, `sloka`). */
  directory: string;
  /** The file text. */
  text: string;
}

/**
 * Build the flat entity index from raw card files, resolving each file's type by
 * its `entities/` subdirectory against the effective type list. Files under an
 * unknown directory are skipped. The `id` falls back to the filename stem and the
 * `label` to the id, so a partial card still indexes. `aliases` folds in the
 * card's `epithets` for richer autocomplete matching.
 */
export function buildEntityIndex(files: readonly RawEntityFile[], types: readonly EffectiveEntityType[]): EntityIndexEntry[] {
  const byDirectory = new Map<string, EffectiveEntityType>();
  for (const type of types) {
    byDirectory.set(type.directory, type);
  }
  const index: EntityIndexEntry[] = [];
  for (const file of files) {
    const type = byDirectory.get(file.directory);
    if (!type) {
      continue;
    }
    const labelField = type.fields.find(field => field.role === 'label')?.name ?? 'name';
    let record: unknown;
    try {
      record = parse(file.text);
    } catch {
      record = undefined;
    }
    const data = isRecord(record) ? record : {};
    const id = cleanString(data.id) ?? filenameStem(file.path);
    if (!id) {
      continue;
    }
    const label = cleanString(data[labelField]) ?? id;
    index.push({
      kind: type.id,
      tagKind: type.tagKind,
      id,
      label,
      path: file.path,
      aliases: [...toStringList(data.aliases), ...toStringList(data.epithets)]
    });
  }
  return index;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);
}

function filenameStem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[^.]+$/, '');
}

/**
 * Minimal YAML card skeleton for a NEW entity of `type`, used when the reader
 * offers to create a card for an unknown id. Emits every field of the type's
 * schema: the `id` and label field are seeded, list fields become empty lists,
 * the rest empty scalars — so the card opens ready to fill in and already
 * validates as the right shape.
 */
export function buildEntitySkeleton(type: EffectiveEntityType, id: string, label?: string): string {
  const labelField = type.fields.find(field => field.role === 'label')?.name ?? 'name';
  const lines: string[] = [];
  for (const field of type.fields) {
    if (field.name === 'id') {
      lines.push(`id: ${yamlScalar(id)}`);
    } else if (field.name === labelField) {
      lines.push(`${field.name}: ${yamlScalar(label ?? id)}`);
    } else if (field.kind === 'list') {
      lines.push(`${field.name}: []`);
    } else {
      lines.push(`${field.name}: ''`);
    }
  }
  return lines.join('\n') + '\n';
}

function yamlScalar(value: string): string {
  // Quote when the scalar could be misread by a YAML parser; otherwise emit bare.
  if (value === '' || /[:#\-?\[\]{}&*!|>'"%@`,]/.test(value) || /^\s|\s$/.test(value)) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}
