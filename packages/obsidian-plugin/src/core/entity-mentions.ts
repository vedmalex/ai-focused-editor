/**
 * PURE (no Obsidian imports) mention index: where each entity is referenced
 * across the book's `content` markdown prose. Built on the plugin's Unicode-aware
 * {@link scanSemanticTags} scanner (so a Cyrillic `[[персонаж:кришна]]` counts
 * exactly like an ASCII `[[char:krishna]]`), not on the ASCII-only common
 * `entity-mentions` regex. The index/dedupe keys keep the `\u0000` separator
 * convention of that common module so a `kind`+`id` pair can never collide with
 * an id that literally contains the separator character.
 *
 * A reference is matched to an entity by kind + id, and a bare `[[id]]` (no kind)
 * is matched to any entity carrying that id. Ids are compared case-sensitively
 * (they are slugs); kinds case-insensitively (a tag may use the type id or the
 * tagKind).
 */

import { scanSemanticTags } from './tag-at-position';

/** Null separator (matches the common `entity-mentions` key convention). */
const SEP = '\u0000';

/** One place a tag appears: a file + 1-based line + the trimmed source line. */
export interface MentionSpot {
  /** Vault-relative path of the markdown file. */
  path: string;
  /** 1-based line number of the reference. */
  line: number;
  /** Trimmed text of the source line, for a preview. */
  preview: string;
}

/** A markdown file to scan for references. */
export interface ScannedFile {
  path: string;
  text: string;
}

/** Index key for a `kind` + `id` pair (kind lower-cased; `''` for a bare id). */
export function mentionKey(kind: string, id: string): string {
  return `${kind.toLowerCase()}${SEP}${id}`;
}

/** The mention index: composite key → the spots where that key appears. */
export type MentionIndex = Map<string, MentionSpot[]>;

/**
 * Scan every file line-by-line and index each semantic tag under its
 * `kind`+`id` key (a bare `[[id]]` indexes under the empty-kind key so it is
 * found too). Spots keep source order (file order, then line order).
 */
export function buildMentionIndex(files: readonly ScannedFile[]): MentionIndex {
  const index: MentionIndex = new Map();
  const push = (key: string, spot: MentionSpot): void => {
    const bucket = index.get(key);
    if (bucket) {
      bucket.push(spot);
    } else {
      index.set(key, [spot]);
    }
  };
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const tags = scanSemanticTags(line);
      if (tags.length === 0) {
        continue;
      }
      const spot: MentionSpot = { path: file.path, line: i + 1, preview: line.trim() };
      for (const tag of tags) {
        push(mentionKey(tag.kind, tag.id), spot);
      }
    }
  }
  return index;
}

/** Identity of an entity for mention lookup (both its type id and tag kind). */
export interface MentionTarget {
  kind: string;
  tagKind: string;
  id: string;
}

/**
 * All spots that reference `target`: the union of its `kind:id`, `tagKind:id`,
 * and bare `id` keys, de-duplicated by `path`+`line` and returned in stable order
 * (by path, then line) so repeated references on one line collapse to one spot.
 */
export function mentionsForEntity(index: MentionIndex, target: MentionTarget): MentionSpot[] {
  const keys = new Set<string>([
    mentionKey(target.kind, target.id),
    mentionKey(target.tagKind, target.id),
    mentionKey('', target.id)
  ]);
  const seen = new Set<string>();
  const spots: MentionSpot[] = [];
  for (const key of keys) {
    const bucket = index.get(key);
    if (!bucket) {
      continue;
    }
    for (const spot of bucket) {
      const dedupe = `${spot.path}${SEP}${spot.line}`;
      if (seen.has(dedupe)) {
        continue;
      }
      seen.add(dedupe);
      spots.push(spot);
    }
  }
  spots.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return spots;
}

/** The mention count for `target` (its de-duplicated spot count). */
export function countMentions(index: MentionIndex, target: MentionTarget): number {
  return mentionsForEntity(index, target).length;
}
