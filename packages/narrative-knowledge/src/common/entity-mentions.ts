/**
 * Pure parser for entity mentions embedded in narrative card text. No Theia
 * imports so it stays unit-testable and usable from both browser widgets.
 *
 * Two forms are recognised inside free text fields:
 *   - `[[kind:id|label]]` — an explicit semantic reference (kind + id + label).
 *   - `[[id]]` — a bare fallback that matches any entity whose id is `id`.
 *
 * CODE IS NOT A REFERENCE (ISS-362, gh#72). A `[[...]]` token inside inline
 * code or a fenced code block is a syntax EXAMPLE — an author demonstrating the
 * tag grammar in a card's own description, not pointing at an entity. Both
 * functions below therefore skip such tokens, closing the last two scanners
 * left blind when ISS-358 taught the diagnostic-producing parsers
 * (`parseWikiLinks`, `parseSemanticMarkdown`) the same rule.
 *
 * WHY THIS MATTERS EVEN THOUGH NEITHER FUNCTION PRODUCES DIAGNOSTICS. They feed
 * the mention COUNT and the clickable chips: `extractEntityMentions` is what
 * `chapter-bundle.ts` and `entity-card-extraction.ts` count relations from, and
 * `splitEntityMentions` is what `entity-cards-widget.ts` turns into links. A
 * counted example inflates a relation that does not exist, and a linked one
 * invites a click into a card the prose never referenced.
 *
 * POST-FILTER, NEVER MUTATE. The guard SKIPS matches on the original string; it
 * does not blank code spans out first. That keeps every surviving match's
 * offsets byte-identical to the unguarded scan — the property
 * `computeCodeSpanRanges`' own doc calls load-bearing, and the reason
 * {@link splitEntityMentions} can leave a skipped token to fall into the
 * neighbouring text segment untouched.
 *
 * TWO CALLERS PASS YAML-DECODED TEXT, NOT MARKDOWN SOURCE
 * (`chapter-front-matter.ts`, `entity-card-extraction.ts`) — the value has
 * already been unescaped and folded by the YAML parser. That is deliberate and
 * safe: a block scalar (`|`) preserves the fence lines verbatim, so a fenced
 * example inside a card body still reads as code here, and an inline `` ` ``
 * pair survives folding either way. Nothing downstream re-derives offsets
 * against the markdown source, so the fold cannot desynchronise them.
 */

import { computeCodeSpanRanges, isOffsetInCodeSpan } from '@ai-focused-editor/semantic-markdown';

export interface EntityMention {
  /** The full matched text, e.g. `[[char:krishna|Krishna]]` or `[[krishna]]`. */
  raw: string;
  /** Entity kind when written as `kind:id`; omitted for the bare `[[id]]` form. */
  kind?: string;
  /** Referenced entity id. */
  id: string;
  /** Display label when provided via `|label`; omitted otherwise. */
  label?: string;
}

// `[[` (optional `kind:`) id (optional `|label`) `]]`. Ids are slug-like so the
// kind boundary (a single colon) is unambiguous for the common entity ids.
const ENTITY_MENTION_PATTERN = /\[\[(?:([a-z][\w-]*):)?([A-Za-z0-9_.-]+)(?:\|([^\]\n]+?))?\]\]/g;

/**
 * Extract unique entity mentions from `text`, preserving first-seen order.
 * Mentions are de-duplicated by `kind` + `id` so a repeated reference collapses
 * to a single chip/link. Returns an empty array when there are no mentions.
 */
export function extractEntityMentions(text: string): EntityMention[] {
  if (!text) {
    return [];
  }

  const mentions: EntityMention[] = [];
  const seen = new Set<string>();
  const codeRanges = computeCodeSpanRanges(text);
  ENTITY_MENTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENTITY_MENTION_PATTERN.exec(text)) !== null) {
    // ISS-362: an example, not a reference — see this module's header.
    if (isOffsetInCodeSpan(match.index, codeRanges)) {
      continue;
    }
    const [raw, kind, id, label] = match;
    const key = `${kind ?? ''}\u0000${id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mentions.push(toMention(raw, kind, id, label));
  }
  return mentions;
}

export type EntityMentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; mention: EntityMention };

/**
 * Split `text` into an ordered run of plain-text and mention segments, so a
 * renderer can weave clickable spans through the original prose. Mentions are
 * kept in place (not de-duplicated) unlike {@link extractEntityMentions}.
 */
export function splitEntityMentions(text: string): EntityMentionSegment[] {
  if (!text) {
    return [];
  }

  const segments: EntityMentionSegment[] = [];
  const codeRanges = computeCodeSpanRanges(text);
  ENTITY_MENTION_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = ENTITY_MENTION_PATTERN.exec(text)) !== null) {
    // ISS-362: an example, not a reference. THE CURSOR DELIBERATELY DOES NOT
    // MOVE — unlike a filter, a splitter that merely `continue`d past a token
    // would DELETE it from the output. Leaving the cursor where it was makes
    // the skipped token fall into the next text segment verbatim, which is
    // what keeps this function total: concatenating every segment (text values
    // plus each mention's `raw`) still reproduces the input byte for byte.
    if (isOffsetInCodeSpan(match.index, codeRanges)) {
      continue;
    }
    if (match.index > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, match.index) });
    }
    const [raw, kind, id, label] = match;
    segments.push({ type: 'mention', mention: toMention(raw, kind, id, label) });
    cursor = match.index + raw.length;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }
  return segments;
}

function toMention(raw: string, kind: string | undefined, id: string, label: string | undefined): EntityMention {
  return {
    raw,
    ...(kind ? { kind } : {}),
    id,
    ...(label ? { label } : {})
  };
}
