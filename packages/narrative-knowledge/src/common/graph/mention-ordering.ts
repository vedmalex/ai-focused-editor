/**
 * Manuscript order for mentions — ONE rule, shared by every adapter (gh#47).
 *
 * ## Why this is a module and not two implementations
 *
 * `MentionQuery.orderBy` has to work in the in-memory adapter (arrays) and in
 * the SQLite adapter (an `ORDER BY` clause). Those are different languages, so
 * the rule is stated ONCE here as data — {@link MENTION_ORDER_SQL} is generated
 * from the same reasoning and sits next to the predicate it mirrors — and the
 * store contract suite runs the SAME assertions against both. An adapter that
 * drifts fails the shared suite rather than being discovered by a reader.
 *
 * ## The rule
 *
 * Ordered mentions come first, by `chapterOrder`, then by position within the
 * chapter. Everything {@link mentionOrderExclusion} rejects trails them — in
 * BOTH directions, for the reason spelled out on {@link MentionOrderExclusion}.
 *
 * Ties keep insertion order: `Array.prototype.sort` is stable, and the SQL
 * clause ends in `m.mention_id ASC` to match. Without that a "first appearance"
 * could differ between two runs over an identical tree, which is exactly the
 * green-by-coincidence shape the round-trip determinism tooth exists to reject.
 */

import type { MentionOrderExclusion } from './narrative-index-store';
import type { NarrativeMention } from './narrative-mention';

/** The document facts ordering needs. A structural subset of `IndexedDocument`
 *  so this module stays usable by anything holding those two fields. */
export interface MentionOrderDocument {
  chapterOrder?: number;
  manifestIncluded: boolean;
}

/**
 * Why this mention cannot be placed in manuscript order, or `undefined` when it
 * can be.
 *
 * ORDER OF THE CHECKS IS THE ANSWER, not an implementation detail: a mention can
 * be unplaceable for more than one reason at once (a whole-file mention in an
 * unlisted chapter is both `no-chapter-order` and `no-position`). The document's
 * own state is reported first because it is the one the author can act on — the
 * chapter is missing from `manifest.yaml`, which is a fixable authoring fact,
 * whereas `no-position` is a property of how the mention was written.
 */
export function mentionOrderExclusion(
  mention: NarrativeMention,
  document: MentionOrderDocument | undefined
): MentionOrderExclusion | undefined {
  if (document === undefined || document.chapterOrder === undefined) {
    return 'no-chapter-order';
  }
  if (!document.manifestIncluded) {
    return 'not-in-manifest';
  }
  if (mention.evidence.evidenceKind !== 'range') {
    return 'no-position';
  }
  return undefined;
}

/**
 * Order `mentions` as the manuscript reads, newest-first when `direction` is
 * `'desc'`.
 *
 * `resolveDocument` is a lookup rather than a map so callers may back it with
 * whatever they already hold; it is called once per mention per comparison and
 * is expected to be cheap.
 */
export function orderMentionsByChapter(
  mentions: readonly NarrativeMention[],
  direction: 'asc' | 'desc',
  resolveDocument: (relPath: string) => MentionOrderDocument | undefined
): NarrativeMention[] {
  const sign = direction === 'desc' ? -1 : 1;
  // Keys are computed ONCE per mention rather than inside the comparator: a
  // comparator that resolves documents runs O(n log n) lookups, and this is a
  // read path a widget calls on every cursor move.
  const keyed = mentions.map((mention, insertionIndex) => {
    const document = resolveDocument(mention.evidence.path);
    const excluded = mentionOrderExclusion(mention, document) !== undefined;
    const range = mention.evidence.evidenceKind === 'range' ? mention.evidence.range : undefined;
    return {
      mention,
      insertionIndex,
      excluded,
      chapterOrder: document?.chapterOrder ?? 0,
      line: range?.start.line ?? 0,
      character: range?.start.character ?? 0
    };
  });
  keyed.sort((a, b) => {
    // ALWAYS ascending on this key, in both directions — see
    // `MentionOrderExclusion`. Reversing it here is the mirroring mistake that
    // type's doc rejects.
    if (a.excluded !== b.excluded) {
      return a.excluded ? 1 : -1;
    }
    if (a.excluded) {
      return a.insertionIndex - b.insertionIndex;
    }
    if (a.chapterOrder !== b.chapterOrder) {
      return sign * (a.chapterOrder - b.chapterOrder);
    }
    if (a.line !== b.line) {
      return sign * (a.line - b.line);
    }
    if (a.character !== b.character) {
      return sign * (a.character - b.character);
    }
    return a.insertionIndex - b.insertionIndex;
  });
  return keyed.map(entry => entry.mention);
}

/**
 * The SQLite spelling of {@link orderMentionsByChapter}, for a query that has
 * already joined `mention m` to `document d`.
 *
 * `${direction}` interpolation is safe by CONSTRUCTION rather than by trust: the
 * only caller narrows to the `'asc' | 'desc'` union first, and this function
 * maps it through a switch, so no caller-supplied string reaches the SQL. The
 * exclusion flag stays `ASC` on purpose.
 */
export function mentionOrderSql(direction: 'asc' | 'desc'): string {
  const dir = direction === 'desc' ? 'DESC' : 'ASC';
  const excluded = `d.chapter_order IS NULL OR d.manifest_included = 0 OR m.evidence_kind <> 'range'`;
  // EVERY position key is neutralised for the excluded rows, not just guarded
  // by the flag above. Leaving them to sort naturally is the obvious spelling
  // and it is wrong twice over: SQLite orders NULL FIRST under `ASC`, so the
  // unlisted chapter led its own trailing group, and the group's internal order
  // then flipped with `direction` — while this package promises insertion order
  // inside it, in both directions. The shared contract suite caught exactly
  // this divergence between the two adapters.
  const key = (column: string) => `(CASE WHEN ${excluded} THEN 0 ELSE ${column} END) ${dir}`;
  return `ORDER BY
      (CASE WHEN ${excluded} THEN 1 ELSE 0 END) ASC,
      ${key('d.chapter_order')},
      ${key('m.start_line')},
      ${key('m.start_char')},
      m.mention_id ASC`;
}
