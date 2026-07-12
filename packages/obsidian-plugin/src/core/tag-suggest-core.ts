/**
 * PURE (no Obsidian imports) autocomplete logic for semantic tags. The Obsidian
 * `EditorSuggest` wrapper (`src/tag-suggest.ts`) feeds the current line + cursor
 * here and renders/accepts whatever this returns, so all the trigger + ranking
 * rules are unit-testable under `bun test`.
 */

import type { EntityIndexEntry } from './book-model';

/**
 * Which part of a `[[…` token the cursor is in.
 * - `kind`  — still typing the kind, before any `:` (e.g. `[[per`).
 * - `entity`— a complete `kind:` is present, typing the id/label (e.g. `[[char:kr`).
 */
export type TagContextPhase = 'kind' | 'entity';

export interface TagContext {
  phase: TagContextPhase;
  /** Character offset of the opening `[[`. The whole token is replaced on accept. */
  tokenStart: number;
  /** For `entity` phase: the tag kind typed before `:`. */
  kind?: string;
  /** The partial being completed — a kind prefix (`kind` phase) or id/label prefix (`entity` phase). */
  query: string;
}

/**
 * Detect the active `[[…` autocomplete context at cursor offset `ch`, or `null`.
 *
 * Trigger rule (deliberately conservative so it does not fight Obsidian's own
 * `[[` wikilink suggester):
 *  - There must be an unclosed `[[` before the cursor with no `]]`, `[`, `]` or
 *    `|` between it and the cursor.
 *  - `entity` phase fires once a `:` is present: `[[<kind>:<prefix>` with a
 *    non-empty kind. This is the primary, unambiguous surface — a `kind:` prefix
 *    never appears in a normal Obsidian wikilink, so we own it cleanly.
 *  - `kind` phase fires ONLY when the text after `[[` is a non-empty run of
 *    letters/digits/`-`/`_` and no `:` yet (`[[per`). The caller further gates
 *    this to prefixes that actually match a known tag kind, so a user typing a
 *    normal `[[Note title` wikilink is not hijacked (a title with a space, or a
 *    prefix that matches no kind, yields no kind suggestions).
 */
export function activeTagContext(line: string, ch: number): TagContext | null {
  const region = line.slice(0, ch);
  const open = region.lastIndexOf('[[');
  if (open === -1) {
    return null;
  }
  const inner = region.slice(open + 2);
  // Any bracket / pipe / newline between `[[` and the cursor closes the context.
  if (/[\[\]\n|]/.test(inner)) {
    return null;
  }
  const colon = inner.indexOf(':');
  if (colon !== -1) {
    const kind = inner.slice(0, colon).trim();
    if (!kind) {
      return null;
    }
    return { phase: 'entity', tokenStart: open, kind, query: inner.slice(colon + 1) };
  }
  // Kind phase: only a clean identifier run (no spaces) is a candidate.
  if (inner.length === 0 || !/^[\p{L}\p{N}_-]+$/u.test(inner)) {
    return null;
  }
  return { phase: 'kind', tokenStart: open, query: inner };
}

/**
 * Rank the tag kinds whose `tagKind` starts with `query` (case-insensitive),
 * shortest first then alphabetical. Empty query returns every kind. Used only for
 * the conservative `kind`-phase suggestion.
 */
export function rankTagKinds(tagKinds: readonly string[], query: string): string[] {
  const needle = query.toLowerCase();
  return tagKinds
    .filter(kind => kind.toLowerCase().startsWith(needle))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

export interface RankedEntity {
  entry: EntityIndexEntry;
  /** Higher is a better match. */
  score: number;
}

/**
 * Rank entities of a given tag kind by how well `query` matches their id, label,
 * or any alias. The `kind` argument is the tag kind typed by the author; it
 * matches an entry whose `tagKind` OR `kind` (id) equals it, case-insensitively,
 * so both `[[char:` and (an author type's) `[[персонаж:` resolve to their cards.
 *
 * Match tiers (best → worst), with non-matches dropped when `query` is non-empty:
 *  1. exact id / label / alias
 *  2. id / label / alias PREFIX
 *  3. fuzzy subsequence over id / label / alias
 * An empty query returns all entities of the kind, alphabetical by label.
 */
export function rankEntities(
  entities: readonly EntityIndexEntry[],
  kind: string,
  query: string
): RankedEntity[] {
  const wantKind = kind.toLowerCase();
  const pool = entities.filter(
    entry => entry.tagKind.toLowerCase() === wantKind || entry.kind.toLowerCase() === wantKind
  );
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return pool
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(entry => ({ entry, score: 0 }));
  }

  const ranked: RankedEntity[] = [];
  for (const entry of pool) {
    const score = entityScore(entry, needle);
    if (score !== null) {
      ranked.push({ entry, score });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
  return ranked;
}

/** Best match score of `needle` against an entry's id/label/aliases, or null. */
function entityScore(entry: EntityIndexEntry, needle: string): number | null {
  const targets = [entry.id, entry.label, ...entry.aliases];
  let best: number | null = null;
  for (const target of targets) {
    const score = matchScore(target.toLowerCase(), needle);
    if (score !== null && (best === null || score > best)) {
      best = score;
    }
  }
  return best;
}

/**
 * Score a single target against a lowercase needle:
 *  - exact           → 1000
 *  - prefix          → 800 − (target.length − needle.length)  (shorter = better)
 *  - fuzzy subseq    → 0..500 by span tightness / earliness
 *  - no match        → null
 */
function matchScore(target: string, needle: string): number | null {
  if (target === needle) {
    return 1000;
  }
  if (target.startsWith(needle)) {
    return 800 - Math.min(target.length - needle.length, 200);
  }
  return fuzzyScore(target, needle);
}

/**
 * Subsequence fuzzy score: every char of `needle` must appear in `target` in
 * order. Rewards an earlier first hit and a tighter overall span. Returns null
 * when `needle` is not a subsequence.
 */
function fuzzyScore(target: string, needle: string): number | null {
  let ti = 0;
  let first = -1;
  let last = -1;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni];
    let found = -1;
    while (ti < target.length) {
      if (target[ti] === ch) {
        found = ti;
        ti++;
        break;
      }
      ti++;
    }
    if (found === -1) {
      return null;
    }
    if (first === -1) {
      first = found;
    }
    last = found;
  }
  const span = last - first + 1;
  const spanPenalty = Math.min(span - needle.length, 200); // 0 when contiguous
  const startPenalty = Math.min(first, 200);
  return 500 - spanPenalty - Math.floor(startPenalty / 2);
}

/**
 * Build the replacement text for accepting an entity in the `entity` phase:
 * `[[kind:id|label]]`. The full token from `tokenStart` to the cursor is replaced
 * by this string.
 */
export function buildTagInsertion(kind: string, entry: EntityIndexEntry): string {
  return `[[${kind}:${entry.id}|${entry.label}]]`;
}
