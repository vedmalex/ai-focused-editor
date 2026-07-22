/**
 * Pure `[[...]]` token → decoration-outcome classifier for
 * `SemanticMarkdownDecorationService` (TASK-013 U5). Deliberately kept in its
 * own file with ZERO non-type-only imports from any `@theia/*` package: the
 * sibling `semantic-markdown-decoration-service.ts` imports `@theia/core/lib/browser`
 * (for `FrontendApplicationContribution`), which — because `bun test`
 * transpiles each file in isolation and cannot elide a same-file value import
 * that is only used in a type position — drags in `@lumino/widgets`'
 * `ApplicationShell`, which touches `document` at MODULE-LOAD time. That blows
 * up under `bun test`'s Node-like (DOM-less) environment the instant anything
 * in the SAME file is imported, pure function included. Splitting the pure
 * logic out here is what makes `classifyWikiLinkDecorations` unit-testable at
 * all (see `semantic-markdown-decoration-service.test.ts`).
 */

import type { NarrativeEntity } from '../common';
import { parseWikiLinks, resolveNoteLink, type WikiLinkMatch } from '../common/link-navigation';
import type { NoteIndex } from '../common/note-index';

/** Hover text for a note link that resolved to an equal-distance-tie candidate (plan §2/UR-005(1)). */
export const AMBIGUOUS_HOVER_MESSAGE = 'Неоднозначная ссылка — уточните путь';

/** One `[[...]]` token's decoration outcome, keyed purely off text/index/entity data — no Monaco types involved. */
export type WikiLinkDecorationVariant = 'entity' | 'note-resolved' | 'note-ambiguous' | 'note-unresolved';

export interface WikiLinkDecorationToken {
  /** Offset range of the token in the source text (0-based, end exclusive) — same shape `parseWikiLinks` reports. */
  readonly range: { start: number; end: number };
  readonly variant: WikiLinkDecorationVariant;
  /** Entity kind driving the per-kind color class; only set for `variant === 'entity'`. */
  readonly kind?: string;
  /** Only set for `variant === 'note-ambiguous'` (plan §2/UR-005(1) diagnostic). */
  readonly hoverMessage?: string;
}

/**
 * Classify every `[[...]]` token in `text` into a decoration outcome.
 *
 * Resolution chain (plan §3): a token that `parseWikiLinks` classifies as
 * `entity` (kind:id form) always decorates as an entity, unconditionally on
 * whether the id actually resolves — this MATCHES the pre-TASK-013 behavior
 * (the old decoration service never checked entity existence either, only
 * syntax). A token classified as `note` is first checked against the known
 * entity ids (kind-agnostic `id` match) BEFORE falling into note resolution:
 * this is what keeps a bare pre-existing corpus reference like `[[sharan-108]]`
 * (no `:` in it, so it structurally classifies as `note` per plan §1/§2's
 * discriminator) rendering exactly as it did before this task — as the
 * matching entity's kind color, not as an unresolved/resolved note. Only once
 * neither an explicit kind:id nor a bare-id-matching-an-entity applies does the
 * token go through `resolveNoteLink` (resolved / ambiguous / unresolved).
 * `invalid`-class tokens are skipped entirely (no decoration), same as before.
 */
export function classifyWikiLinkDecorations(
  text: string,
  documentPath: string,
  entities: readonly NarrativeEntity[],
  noteIndex: NoteIndex
): WikiLinkDecorationToken[] {
  const tokens: WikiLinkDecorationToken[] = [];
  for (const link of parseWikiLinks(text)) {
    const token = classifyOneToken(link, documentPath, entities, noteIndex.byBasename, noteIndex.titleIndex);
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

function classifyOneToken(
  link: WikiLinkMatch,
  documentPath: string,
  entities: readonly NarrativeEntity[],
  byBasename: NoteIndex['byBasename'],
  titleCandidates: Map<string, string[]>
): WikiLinkDecorationToken | undefined {
  if (link.class === 'entity' && link.id !== undefined) {
    return { range: link.range, variant: 'entity', kind: link.kind };
  }
  if (link.class !== 'note' || link.notePath === undefined) {
    return undefined;
  }

  const entityMatch = entities.find(entity => entity.id === link.notePath);
  if (entityMatch) {
    return { range: link.range, variant: 'entity', kind: entityMatch.kind };
  }

  const resolved = resolveNoteLink(link.notePath, documentPath, byBasename, titleCandidates);
  if (!resolved) {
    return { range: link.range, variant: 'note-unresolved' };
  }
  if (resolved.ambiguous) {
    return { range: link.range, variant: 'note-ambiguous', hoverMessage: AMBIGUOUS_HOVER_MESSAGE };
  }
  return { range: link.range, variant: 'note-resolved' };
}
