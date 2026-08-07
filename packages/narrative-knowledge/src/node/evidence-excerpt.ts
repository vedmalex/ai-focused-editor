/**
 * `readEvidenceExcerpt` — the ONE reader of manuscript text behind a piece of
 * evidence (gh#47 WP-2, architecture §5.4).
 *
 * ## Why a shared primitive and not three call sites
 *
 * Three consumers need it — the entity card (#47), the consistency viewer (#50)
 * and Research Mode's candidate evidence view (#52) — and all three planned
 * their own. The rule below is TOCTOU-sensitive in a way that reads as a detail
 * and is not one, so three implementations would be three chances to get it
 * subtly wrong, in three places nobody compares.
 *
 * ## The rule, and the mistake it exists to prevent
 *
 * The index stores NO document text — only `content_hash`, size and mtime. So an
 * excerpt has to be read from the file, and the file may have moved on since the
 * mention was indexed.
 *
 * NOT STORING THE EXCERPT WAS THE FIRST HALF OF THE DECISION: a saved excerpt
 * goes stale after an edit and becomes a lie with evidence attached, which is
 * the worst failure available to a panel whose entire purpose is traceability.
 *
 * READING ON DEMAND REPRODUCES THAT LIE BY ANOTHER ROUTE unless the hash is
 * checked. If the file changed after indexing, the stored line and column point
 * at SHIFTED CONTENT, and the reader returns real text from the wrong place —
 * presented as this entity's evidence. Confidently wrong is worse than absent,
 * so a hash mismatch yields NO excerpt and a stated reason, and the consumer
 * says so in words.
 *
 * ONE READ, NOT TWO. The hash is computed from the SAME string the excerpt is
 * sliced out of. Reading the file to hash it and reading it again to slice it
 * would leave a window where the two disagree — the exact class of bug this
 * check exists to close.
 *
 * NO RE-EXTRACTION HERE. The tempting repair — reparse the file and find where
 * the mention moved to — is an INDEXING operation on a read path. The stale
 * state heals on its own at the next sweep; a read that quietly re-indexes has
 * no bounded cost and no owner.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceRef, ExcerptUnavailableReason } from '../common';
import { hashContent } from './narrative-workspace-scan';


export interface EvidenceExcerpt {
  /** The quoted text, present only when it is provably the indexed text. */
  text?: string;
  /** Present exactly when {@link text} is absent. */
  unavailable?: ExcerptUnavailableReason;
}

/** Lines of context kept around a single-line span. Zero means the line itself. */
export interface EvidenceExcerptOptions {
  /** Hard cap on the returned string, in characters. A quotation is for reading
   *  in a card, and an unbounded one turns a 4 KB paragraph into a panel. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 400;

/**
 * Read the text `evidence` points at, or explain why it cannot be quoted.
 *
 * `expectedHash` is `document.content_hash` as the index recorded it. Passing a
 * hash the caller did not read from the index would defeat the whole check, so
 * callers take it from the same `IndexedDocument` the mention's document lookup
 * produced.
 */
export async function readEvidenceExcerpt(
  rootPath: string,
  evidence: EvidenceRef,
  expectedHash: string,
  options: EvidenceExcerptOptions = {}
): Promise<EvidenceExcerpt> {
  if (evidence.evidenceKind !== 'range') {
    return { unavailable: 'no-position' };
  }
  const verified = await readVerifiedDocument(rootPath, evidence.path, expectedHash);
  if (verified.text === undefined) {
    return { unavailable: verified.unavailable ?? 'unreadable' };
  }
  return sliceExcerpt(verified.text, evidence, options);
}

/** A document's text, or why it cannot be quoted from. */
export interface VerifiedDocument {
  text?: string;
  unavailable?: ExcerptUnavailableReason;
}

/**
 * Read a document ONCE and vouch for it against the hash the index recorded.
 *
 * SPLIT OUT OF {@link readEvidenceExcerpt} FOR A REASON THAT IS NOT TIDINESS.
 * Several appearances routinely share a chapter, and a caller that wants all of
 * them must read that file once, not once per appearance. The tempting shortcut
 * — caching the finished EXCERPT by document — is wrong and quietly so: two
 * appearances in one chapter have different ranges, so the second would be
 * served the first one's quotation. Caching the verified TEXT is the version
 * that cannot make that mistake, because the range is applied afterwards.
 */
export async function readVerifiedDocument(
  rootPath: string,
  relPath: string,
  expectedHash: string
): Promise<VerifiedDocument> {
  let text: string;
  try {
    text = await fs.readFile(join(rootPath, relPath), 'utf8');
  } catch {
    // Deleted, renamed or unreadable. Deliberately not distinguished further:
    // every one of them means the same thing to the author — this quotation
    // cannot be shown right now — and inventing sub-reasons would put strings on
    // screen that differ without informing.
    return { unavailable: 'unreadable' };
  }
  if (hashContent(text) !== expectedHash) {
    return { unavailable: 'document-changed' };
  }
  return { text };
}

/**
 * Cut the quoted passage out of text that has ALREADY been vouched for.
 *
 * PURE, AND THAT IS THE POINT: it cannot read a file, so it cannot be the place
 * where the hash check is forgotten. Callers reach it only through
 * {@link readEvidenceExcerpt} or after {@link readVerifiedDocument}.
 */
export function sliceExcerpt(
  text: string,
  evidence: EvidenceRef,
  options: EvidenceExcerptOptions = {}
): EvidenceExcerpt {
  if (evidence.evidenceKind !== 'range') {
    return { unavailable: 'no-position' };
  }
  const lines = text.split('\n');
  const { start, end } = evidence.range;
  // A range that falls outside the file it was hashed against would be a
  // CONTRADICTION, not a stale read: the bytes match what was indexed, so the
  // coordinates must fit. Treating it as `document-changed` would blame the
  // author's edit for an index defect, so it is reported as unreadable — the
  // reason that says "this cannot be shown" without asserting a cause.
  if (start.line >= lines.length || end.line >= lines.length) {
    return { unavailable: 'unreadable' };
  }
  const quoted =
    start.line === end.line
      ? lines[start.line].slice(start.character, end.character)
      : [
          lines[start.line].slice(start.character),
          ...lines.slice(start.line + 1, end.line),
          lines[end.line].slice(0, end.character)
        ].join('\n');
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  // The ellipsis is part of the text rather than a flag, because every consumer
  // would otherwise have to remember to render one and a forgotten one reads as
  // a complete quotation that is not.
  return { text: quoted.length > max ? `${quoted.slice(0, max)}…` : quoted };
}
