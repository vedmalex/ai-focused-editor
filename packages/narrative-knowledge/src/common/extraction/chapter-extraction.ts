/**
 * Chapters: mention sources 1 and 4 (TASK-022 WP-2).
 *
 * ONE FILE, TWO SOURCES, TWO EVIDENCE KINDS. A chapter's front matter and a
 * chapter's prose are the SAME document — the plan is explicit that source 4
 * gets no new `document.kind`, because it is not a new document, it is a new
 * PLACE inside an old one. What differs is how precisely each can be located:
 *
 *   - PROSE (source 1) is scanned as text, so every mention has an exact
 *     `range`;
 *   - FRONT MATTER (source 4) is read through a YAML parser, which has already
 *     unescaped, folded and dequoted the value by the time the mention is seen.
 *     An offset inside that value does NOT map back to an offset in the file,
 *     so the evidence is `whole-file` and carries no coordinates at all.
 *
 * WHY NOT SCAN THE WHOLE FILE AS PROSE, THE WAY `NodeNarrativeGraphService`
 * DOES. It calls `parseSemanticMarkdown(text)` on the full text
 * (`node-narrative-graph-service.ts:113`), front matter included, so a labeled
 * tag in the front matter is counted as prose. Doing that here would emit the
 * SAME mention twice — once with a range from the text scan and once whole-file
 * from the YAML scan — and the two rows would be indistinguishable to every
 * consumer. The body is therefore scanned on its own and its coordinates are
 * shifted back into whole-file terms, which is exact (see
 * {@link shiftPositionByLines}).
 *
 * BOTH REFERENCE FORMS, AND THE SECOND ONE KEEPS ITS MISSING KIND (ISS-307).
 * Prose carries two spellings and they are parsed by two different functions,
 * exactly as `BookDoctorContribution.foldEntityTags` already feeds itself:
 * `parseSemanticMarkdown` for the LABELED `[[kind:id|label]]` form, and the
 * wiki-link classifier for the UNLABELED one. The unlabeled form has NO kind
 * when it is a bare colon-less `[[id]]` — `kind` stays `undefined`, and
 * discarding such a mention or inventing a kind for it is FORBIDDEN. That
 * regression has been paid for once already (TASK-013 U-B).
 *
 * WHY `parseWikiLinks` AND NOT `collectUnlabeledWikiEntityMatches`. The latter
 * is the exact filter this module needs and returns `{ kind?, id }` — it drops
 * the `range` on the floor (`wiki-links.ts:197-210`). Source 1 requires
 * non-empty coordinates, so the filter is reproduced here over
 * `parseWikiLinks`, whose matches DO carry offsets. Reproduced, not
 * reinterpreted: same classifier, same three exclusions, same widening of a
 * colon-less `note`-class token to a bare entity reference.
 */

import { parseSemanticMarkdown } from '@ai-focused-editor/semantic-markdown';
import { parseChapterFrontMatter, type ChapterFrontMatterValue } from '../chapter-front-matter';
import type { EntityMention } from '../entity-mentions';
import {
  rangeEvidence,
  wholeFileEvidence,
  type EvidencePosition,
  type NarrativeMention
} from '../graph';
import { parseWikiLinks } from '../wiki-links';
import { isReferenceResolved, type EntityCatalog } from './entity-catalog';
import { computeLineStarts, countLineBreaks, offsetToPosition, shiftPositionByLines } from './text-position';

/** A chapter as read off disk. */
export interface ChapterDocument {
  /** Workspace-relative path. The index's document key. */
  path: string;
  /** Raw file text, front matter included. */
  text: string;
}

/** A prose mention before it is resolved: coordinates are relative to the BODY. */
interface ProseHit {
  entityId: string;
  kind?: string;
  raw: string;
  label?: string;
  start: EvidencePosition;
  end: EvidencePosition;
  labelStart?: EvidencePosition;
  labelEnd?: EvidencePosition;
}

/** Collect the LABELED `[[kind:id|label]]` form from body text. */
function labeledProseHits(body: string): ProseHit[] {
  return parseSemanticMarkdown(body).tags.map(tag => ({
    entityId: tag.id,
    kind: tag.kind,
    raw: tag.raw,
    label: tag.label,
    start: tag.range.start,
    end: tag.range.end,
    labelStart: tag.labelRange.start,
    labelEnd: tag.labelRange.end
  }));
}

/**
 * Collect the UNLABELED form from body text.
 *
 * The three exclusions are `collectUnlabeledWikiEntityMatches`'s, verbatim: a
 * token with an `|alias` belongs to the labeled scan, an `invalid`-class token
 * has no usable id, and a colon-less `note`-class token IS a bare entity
 * reference (the widening TASK-015 U-B introduced after the narrower reading
 * silently lost this project's own `[[sharan-108]]`-style corpus).
 */
function unlabeledProseHits(body: string): ProseHit[] {
  const lineStarts = computeLineStarts(body);
  const hits: ProseHit[] = [];
  for (const link of parseWikiLinks(body)) {
    if (link.alias !== undefined || link.class === 'invalid') {
      continue;
    }
    const entityId = link.class === 'entity' ? link.id : link.class === 'note' ? link.notePath : undefined;
    if (entityId === undefined) {
      continue;
    }
    hits.push({
      entityId,
      // `note`-class tokens have no kind, and that ABSENCE is the value.
      ...(link.class === 'entity' && link.kind !== undefined ? { kind: link.kind } : {}),
      raw: link.raw,
      start: offsetToPosition(lineStarts, link.range.start),
      end: offsetToPosition(lineStarts, link.range.end)
    });
  }
  return hits;
}

/** Walk a typed front-matter value, collecting every entity reference in it. */
function collectFrontMatterMentions(value: ChapterFrontMatterValue, into: EntityMention[]): void {
  if (value.kind === 'list') {
    for (const item of value.items) {
      collectFrontMatterMentions(item, into);
    }
    return;
  }
  if (value.kind !== 'text') {
    return;
  }
  for (const segment of value.segments) {
    if (segment.type === 'mention') {
      into.push(segment.mention);
    }
  }
}

/**
 * Every mention in one chapter, in document order: front matter first, then
 * prose.
 *
 * FRONT-MATTER MENTIONS ARE DEDUPLICATED BY kind+id, PROSE MENTIONS ARE NOT.
 * Two prose occurrences are two navigable places and the author wants to see
 * both. Two whole-file occurrences are the SAME row twice — same entity, same
 * kind, same file, no coordinates to tell them apart — so keeping both would
 * double every front-matter count while adding nothing a consumer could act on.
 */
export function extractChapterMentions(
  document: ChapterDocument,
  catalog: EntityCatalog
): NarrativeMention[] {
  const parsed = parseChapterFrontMatter(document.text);
  const mentions: NarrativeMention[] = [];

  // --- source 4: front matter, whole-file evidence -------------------------
  const frontMatterHits: EntityMention[] = [];
  for (const field of parsed.fields) {
    collectFrontMatterMentions(field.value, frontMatterHits);
  }
  const seen = new Set<string>();
  for (const hit of frontMatterHits) {
    const key = JSON.stringify([hit.kind ?? null, hit.id]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    mentions.push({
      entityId: hit.id,
      ...(hit.kind !== undefined ? { kind: hit.kind } : {}),
      raw: hit.raw,
      ...(hit.label !== undefined ? { label: hit.label } : {}),
      resolved: isReferenceResolved(catalog, hit.kind, hit.id),
      // No range, and therefore no label range either — the DDL states that as
      // `CHECK (label_start_line IS NULL OR evidence_kind = 'range')`, and the
      // discriminated union makes the forbidden pairing unconstructible here.
      evidence: wholeFileEvidence(document.path)
    });
  }

  // --- source 1: prose, exact ranges ---------------------------------------
  const body = parsed.body;
  // The body always begins at column 0 of a line (or is empty) — see
  // `shiftPositionByLines` — so the whole-file correction is a pure line shift.
  const lineShift = countLineBreaks(document.text.slice(0, document.text.length - body.length));

  const hits = [...labeledProseHits(body), ...unlabeledProseHits(body)];
  hits.sort((left, right) => left.start.line - right.start.line || left.start.character - right.start.character);

  for (const hit of hits) {
    const labelRange = hit.labelStart !== undefined && hit.labelEnd !== undefined
      ? {
          start: shiftPositionByLines(hit.labelStart, lineShift),
          end: shiftPositionByLines(hit.labelEnd, lineShift)
        }
      : undefined;
    mentions.push({
      entityId: hit.entityId,
      ...(hit.kind !== undefined ? { kind: hit.kind } : {}),
      raw: hit.raw,
      ...(hit.label !== undefined ? { label: hit.label } : {}),
      resolved: isReferenceResolved(catalog, hit.kind, hit.entityId),
      evidence: rangeEvidence(document.path, {
        start: shiftPositionByLines(hit.start, lineShift),
        end: shiftPositionByLines(hit.end, lineShift)
      }),
      ...(labelRange !== undefined ? { labelRange } : {})
    });
  }

  return mentions;
}
