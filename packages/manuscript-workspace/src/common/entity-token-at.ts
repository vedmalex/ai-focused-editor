/**
 * Which entity reference is at a given offset (gh#47, architecture §3.9).
 *
 * ## Why this is extracted rather than reused where it was
 *
 * The chain lived inside `SemanticEntityHoverContribution.findTagAt` as a
 * `protected` method, so a second consumer — the card following the caret —
 * could only copy it. Copying is the dangerous option here for one specific
 * reason, stated below.
 *
 * ## The branch that must survive the extraction
 *
 * A `note`-class wiki token is resolved AS AN ENTITY FIRST. Narrowing this to
 * colon-shaped `[[kind:id]]` tokens was a live regression once (ISS-151): a bare
 * `[[krishna]]` stopped resolving, while a separate chain elsewhere still
 * resolved it, so the product disagreed with itself about the same token. The
 * tooth for this branch is the reason the extraction is a named piece of work
 * and not a move.
 *
 * ## Two sources, one rule
 *
 * `isKnownEntity` is INJECTED rather than looked up here, because the caller
 * decides which source answers it — the hover has a cached snapshot, the card
 * has the index. The architecture's rule holds either way: **the id comes from
 * this resolver, the truth comes from the index.** A caller must not treat a
 * token this function declines to resolve as proof that no such entity exists.
 */

import { parseSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import { parseWikiLinks, wikiEntityHoverCandidate } from '@ai-focused-editor/narrative-knowledge';

export interface EntityTokenAtOffset {
  /** The `[[kind:id]]` prefix, absent for the bare `[[id]]` form. */
  kind?: string;
  id: string;
  /** Half-open span of the whole token, in offsets into the text given. */
  startOffset: number;
  endOffset: number;
}

/** Offsets at which each line starts, so a line/character range can be turned
 *  into offsets without a Monaco model — this function must run under `bun`. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/**
 * The reference under `offset`, or `undefined`.
 *
 * ORDER MATTERS AND IS THE ANSWER: explicit `[[kind:id]]` tags are consulted
 * first, because they say what they are; wiki links are consulted second, and
 * only there does the `note`-first rule apply.
 */
export function findEntityTokenAt(
  text: string,
  offset: number,
  isKnownEntity: (id: string) => boolean
): EntityTokenAtOffset | undefined {
  const starts = lineStarts(text);
  const toOffset = (line: number, character: number): number => (starts[line] ?? text.length) + character;
  for (const tag of parseSemanticMarkdown(text).tags) {
    const start = toOffset(tag.range.start.line, tag.range.start.character);
    const end = toOffset(tag.range.end.line, tag.range.end.character);
    if (offset >= start && offset <= end) {
      return { kind: tag.kind, id: tag.id, startOffset: start, endOffset: end };
    }
  }
  for (const link of parseWikiLinks(text)) {
    const { start, end } = link.range;
    if (offset < start || offset > end) {
      continue;
    }
    if (link.class === 'note') {
      // ISS-151. The entity lookup is paid for ONLY once a note-class token's
      // range already contains the offset — never on every caret move over
      // ordinary prose.
      const candidate = wikiEntityHoverCandidate(link, isKnownEntity);
      if (candidate) {
        return { ...(candidate.kind === undefined ? {} : { kind: candidate.kind }), id: candidate.id, startOffset: start, endOffset: end };
      }
      // A genuine note link with no matching entity. Declining is correct and is
      // NOT a statement that the id names nothing anywhere.
      continue;
    }
    const candidate = wikiEntityHoverCandidate(link, () => false);
    if (candidate) {
      return { ...(candidate.kind === undefined ? {} : { kind: candidate.kind }), id: candidate.id, startOffset: start, endOffset: end };
    }
  }
  return undefined;
}

/**
 * Should a saved file be handed to `updateDocument`? (gh#47, closing F-47-8.)
 *
 * EXTRACTED FOR THE SAME REASON `shouldFollowCursor` is: the decision is one
 * boolean, and asserting it inside a Theia contribution would need a DOM and a
 * container to observe a question that has neither.
 *
 * IT ANSWERS ONLY THE PART THIS SIDE CAN ANSWER. Whether the path is a file the
 * INDEX reads depends on the entity kinds the author declared, and that answer
 * belongs to the backend (see `NarrativeSaveReindexContribution`). What is
 * decidable here — and the only thing worth filtering here — is whether the file
 * is under a workspace root at all.
 */
export function shouldReindexOnSave(uri: string, rootUris: readonly string[]): boolean {
  // A trailing slash on the prefix, deliberately: without it a root
  // `file:///w/book` would also claim `file:///w/book-notes/x.md`, a sibling
  // directory that shares a name prefix and belongs to a different manuscript.
  return rootUris.some(root => uri.startsWith(`${root}/`));
}
