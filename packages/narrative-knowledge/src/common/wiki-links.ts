/**
 * Wiki-link parsing: the single scan that classifies every `[[...]]` token in
 * a Markdown source as an entity reference, a note reference, or invalid.
 *
 * Relocated in TASK-022 WP-0 (plan AD-1). This half of the former
 * `link-navigation` module is the KNOWLEDGE half — it answers "what does this
 * text refer to", which is exactly the question the narrative index is built
 * on. The other half of that module — editor navigation (resolving a note
 * reference to a workspace file, relative-link arithmetic, heading anchors) —
 * stayed behind, because it answers "where does a click go", which is an
 * editor concern with no bearing on the graph.
 *
 * The module has NO imports at all, by construction: the classifier is three
 * regular expressions plus string arithmetic. That is what made it liftable.
 *
 * TASK-013: `parseWikiLinks` classifies every `[[...]]` token as `entity` /
 * `note` / `invalid` per plan §1/§2's discriminator (kind-prefix before the
 * first `:`). This classifier is a BY-HAND-SYNC SEAM with
 * `isValidBareEntityTag`/the entity/note split implemented independently in
 * `@ai-focused-editor/semantic-markdown` (`semantic-markdown.ts`) — the two
 * mirror the SAME plan §1/§2 table by hand. Keep the table-driven test cases
 * in both `*.test.ts` files aligned when the grammar changes.
 *
 * NOT to be confused with `entity-mentions.ts` in this same folder, which
 * recognises a SUPERFICIALLY SIMILAR `[[kind:id|label]]` form with an
 * ASCII-only kind pattern. The two disagree on Cyrillic kinds — see gh#66.
 * The divergence is deliberately preserved here rather than silently repaired:
 * this relocation changes no behaviour.
 */

/** Offset range of a `[[...]]` token in the source text (0-based, end exclusive). */
export interface WikiLinkOffsetRange {
  start: number;
  end: number;
}

/**
 * Classification of a `[[...]]` token, per plan §1/§2's kind-prefix discriminator:
 * - `entity` — `path` (after stripping `|alias` and `#anchor`) contains `:` and the
 *   substring before the first `:` matches the Unicode-lowercase kind grammar
 *   (`^\p{Ll}[\p{L}\p{N}_-]*$`), AND the id after `:` is non-empty ASCII with no
 *   embedded whitespace.
 * - `note` — anything else with a non-empty `path` (spaces, Unicode, `/` all
 *   allowed — Obsidian-style note names/paths).
 * - `invalid` — empty `path`, or an entity-shaped prefix (kind grammar matches)
 *   whose id fails the ASCII/no-whitespace check (e.g. `[[char:krishna Krishna]]`
 *   — plan §1's documented regression-guard case).
 */
export type WikiLinkClass = 'entity' | 'note' | 'invalid';

/**
 * One classified `[[...]]` token from `parseWikiLinks`. Fields are populated per
 * `class`: `entity` sets `kind`+`id`; `note` sets `notePath`; either may carry
 * `anchor` (first `#...` segment) and/or `alias` (first `|...` segment, display-
 * only per UR-004/005). `invalid` carries whatever partial fields were parsed
 * (e.g. `kind` for a kind-shaped prefix with a bad id) for diagnostics.
 */
export interface WikiLinkMatch {
  class: WikiLinkClass;
  /** Entity kind (Unicode-lowercase), only for `class === 'entity'` (or a
   *  kind-shaped `invalid` whose id failed validation). */
  kind?: string;
  /** Entity id (ASCII, no whitespace), only for `class === 'entity'`. */
  id?: string;
  /** Note name/path (spaces, Unicode, `/` allowed), only for `class === 'note'`. */
  notePath?: string;
  /** First `#anchor` segment (heading slug target), when present. */
  anchor?: string;
  /** First `|alias` segment (display label only — never affects resolution). */
  alias?: string;
  /** The whole matched `[[...]]` token, unmodified. */
  raw: string;
  /** Offset range of the whole token in the source text. */
  range: WikiLinkOffsetRange;
}

// Kind-grammar discriminator (plan §1/§9-ISS-136): Unicode-lowercase first
// character (so Cyrillic/other-script kinds like `персонаж:` work), then any mix
// of letters/digits/`_`/`-`. Superset of the pre-TASK-013 `[a-z][\w-]*` ASCII
// grammar, so the existing ASCII corpus keeps matching.
const WIKI_KIND_PATTERN = /^\p{Ll}[\p{L}\p{N}_-]*$/u;

// Entity id grammar: the SAME strict ASCII charset the validator uses
// (semantic-markdown.ts SEMANTIC_ENTITY_ID_PATTERN) — the two by-hand-synced
// classifiers MUST agree, or a token the validator flags red would still get
// link/decoration treatment here (seam divergence). A kind-shaped token whose
// id falls outside this charset (e.g. `[[c:some/path]]`, `[[char:krishna
// Krishna]]`) is `invalid` in BOTH classifiers — the plan §1/ISS-140 documented
// trade-off: such names cannot be note-linked without a path escape-hatch.
const WIKI_ENTITY_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

// `[[...]]` tokens, single-line only (no embedded `[`, `]`, or newline) — mirrors
// how both the labeled-tag scan and the old bare-tag scan treat a token as
// exactly one line; a `[[` with no `]]` before the next newline simply does not
// match (left as plain text), same as before.
const WIKI_LINK_TOKEN_PATTERN = /\[\[([^[\]\n]*)\]\]/g;

/**
 * Single unified scan of every `[[...]]` token in `text`, classified per plan
 * §1/§2 (see `WikiLinkClass`/`WikiLinkMatch`). Supersedes the old
 * `parseBareEntityTags`/`parseSemanticMarkdown`-tag split: this one function
 * covers labeled and unlabeled entity tags AND Obsidian-style note links in a
 * single pass, so callers only need one offset/classification source of truth.
 */
export function parseWikiLinks(text: string): WikiLinkMatch[] {
  const matches: WikiLinkMatch[] = [];
  WIKI_LINK_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKI_LINK_TOKEN_PATTERN.exec(text)) !== null) {
    const raw = match[0];
    const range: WikiLinkOffsetRange = { start: match.index, end: match.index + raw.length };
    matches.push(classifyWikiLinkToken(match[1], raw, range));
  }
  return matches;
}

function classifyWikiLinkToken(inner: string, raw: string, range: WikiLinkOffsetRange): WikiLinkMatch {
  // 1) Split off `|alias` (first `|` wins) — display-only, never affects
  //    resolution (UR-004/005).
  const pipeIndex = inner.indexOf('|');
  const beforeAlias = pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
  const alias = pipeIndex >= 0 ? inner.slice(pipeIndex + 1) : undefined;

  // 2) Split off `#anchor` (first `#` wins) from what's left.
  const hashIndex = beforeAlias.indexOf('#');
  const rawPath = hashIndex >= 0 ? beforeAlias.slice(0, hashIndex) : beforeAlias;
  const anchorSegment = hashIndex >= 0 ? beforeAlias.slice(hashIndex + 1) : undefined;
  const anchor = anchorSegment ? anchorSegment : undefined;

  const path = rawPath.trim();
  if (!path) {
    return { class: 'invalid', alias, anchor, raw, range };
  }

  // 3) Discriminator: `path` contains `:` AND the prefix before the first `:`
  //    matches the kind grammar => entity intent; otherwise => note.
  const colonIndex = path.indexOf(':');
  if (colonIndex > 0) {
    const kindCandidate = path.slice(0, colonIndex);
    if (WIKI_KIND_PATTERN.test(kindCandidate)) {
      const id = path.slice(colonIndex + 1);
      if (id && WIKI_ENTITY_ID_PATTERN.test(id)) {
        return { class: 'entity', kind: kindCandidate, id, alias, anchor, raw, range };
      }
      // Kind-shaped prefix but the id fails ASCII/no-whitespace — regression-
      // guard case from plan §1 (`[[char:krishna Krishna]]`), stays Invalid
      // rather than falling back to a note interpretation.
      return { class: 'invalid', kind: kindCandidate, alias, anchor, raw, range };
    }
  }

  return { class: 'note', notePath: path, alias, anchor, raw, range };
}

// `parseBareEntityTags` (the `{ kind?, id, start, end }`-shaped wrapper that
// filtered `parseWikiLinks` down to unlabeled `class === 'entity'` matches)
// has been REMOVED (TASK-015 U-B). It was never re-exported through the
// package's public barrel, so no external consumer could depend on it; its only
// three internal consumers (`SemanticEntityHoverContribution`,
// `BookDoctorContribution`, `SemanticLinkContribution`) have all migrated to
// `parseWikiLinks` directly. The migration also fixed a live regression the
// wrapper's narrowing silently caused: a colon-less bare `[[id]]` token (this
// project's own `[[sharan-108]]`-style corpus) classifies as `note` under the
// plan §1/§2 entity/note discriminator, so it stopped being surfaced to
// hover/doctor at all — hover lost its entity card for such tokens, and the
// book doctor under-counted references, falsely reporting a referenced entity
// card as an orphan (`entityCardOrphanFindings`). Both consumers now apply an
// entity-first check (mirroring `resolveWikiToken`'s bare-id chain, U4)
// directly over `parseWikiLinks`'s `note`-class tokens instead of relying on
// this wrapper's blanket exclusion. The `{ kind?, id, start, end }` shape
// (`BareEntityTagMatch`) was removed alongside it, having no other use.

/** One folded unlabeled `[[...]]` entity-tag occurrence (no `|alias`). */
export interface UnlabeledWikiEntityMatch {
  /** Tag kind (e.g. `char`), only for a `class === 'entity'` token; `undefined` for a bare `[[id]]`. */
  kind?: string;
  /** The referenced id — `entity`-class's `id`, or `note`-class's `notePath` (colon-less bare). */
  id: string;
}

/**
 * Collect every UNLABELED `[[...]]` token `parseWikiLinks` classifies as
 * `entity` OR `note` (colon-less bare — e.g. this project's own
 * `[[sharan-108]]`-style corpus), as the `{ kind?, id }` shape
 * `BookDoctorContribution.foldEntityTags` needs. `kind` stays `undefined` for
 * a `note`-class match, exactly the pre-TASK-013 bare-entity shape
 * `entityCardOrphanFindings`/`entityCardMissingFixes`/`entityUnknownKindFindings`
 * (`book-doctor.ts`) already expect ("a bare `[[id]]` matches any kind").
 * Labeled (`|alias`) tokens are excluded (`parseSemanticMarkdown`'s job) and so
 * are `invalid`-class tokens (no usable id).
 *
 * TASK-015 U-B: this is the entity-side replacement for the removed
 * `parseBareEntityTags`, WIDENED to also cover `note`-class colon-less bare
 * tokens — the live regression the narrower wrapper silently introduced (see
 * the removal note above `UnlabeledWikiEntityMatch`).
 */
export function collectUnlabeledWikiEntityMatches(text: string): UnlabeledWikiEntityMatch[] {
  const matches: UnlabeledWikiEntityMatch[] = [];
  for (const link of parseWikiLinks(text)) {
    if (link.alias !== undefined || link.class === 'invalid') {
      continue;
    }
    if (link.class === 'entity' && link.id !== undefined) {
      matches.push({ kind: link.kind, id: link.id });
    } else if (link.class === 'note' && link.notePath !== undefined) {
      matches.push({ id: link.notePath });
    }
  }
  return matches;
}

/**
 * Resolve one classified `parseWikiLinks` token to an entity-hover candidate
 * `{ kind?, id }`, or `undefined` when the token should get NO entity hover.
 * An `entity`-class (colon-shaped) token always qualifies. A `note`-class
 * (colon-less bare, e.g. `[[sharan-108]]`) token qualifies ONLY when
 * `hasEntity(notePath)` reports a real entity by bare id — the entity-first
 * chain `resolveWikiToken` (in `semantic-link-contribution.ts`, U4) already
 * applies for click-navigation; this mirrors it for hover. A genuine
 * Obsidian-style note title (e.g. `[[My Chapter Notes]]`, no matching entity)
 * correctly returns `undefined`. Labeled (`|alias`) and `invalid`-class tokens
 * always return `undefined` too.
 *
 * Pure and synchronous: `hasEntity` is an injected predicate so the caller
 * decides when (and whether) to pay for an entity-list lookup — e.g.
 * `SemanticEntityHoverContribution.findTagAt` only calls this once a token's
 * range already contains the hover offset, never on every hover.
 */
export function wikiEntityHoverCandidate(
  link: WikiLinkMatch,
  hasEntity: (id: string) => boolean
): UnlabeledWikiEntityMatch | undefined {
  if (link.alias !== undefined) {
    return undefined;
  }
  if (link.class === 'entity' && link.id !== undefined) {
    return { kind: link.kind, id: link.id };
  }
  if (link.class === 'note' && link.notePath !== undefined && hasEntity(link.notePath)) {
    return { id: link.notePath };
  }
  return undefined;
}
