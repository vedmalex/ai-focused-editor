/**
 * Provenance for what the WRITING AI tools put on disk (TASK-022 WP-8, UR-008).
 *
 * THE PROBLEM THIS EXISTS FOR. `manuscript_create_entity`, `manuscript_write_note`
 * and `manuscript_create_diagram` create PERMANENT files in the author's
 * manuscript. Until this module, a card the model invented and a card the author
 * wrote were byte-indistinguishable the moment they landed. The governing
 * principle of the epic is that an AI creates CANDIDATES, NOT FACTS; a write
 * that leaves no trace of who proposed it makes that principle unenforceable
 * downstream, because there is nothing left to read.
 *
 * THE RULE, from UR-008 verbatim: a write EITHER carries evidence, OR is marked
 * `origin: 'ai-candidate'` with the author's explicit confirmation. Both halves
 * are load-bearing. Evidence alone would let the model cite nothing and write
 * anyway; the mark alone would let it write silently.
 *
 * WHY THE DECISION IS A PURE FUNCTION AND NOT THREE `if`s IN THREE HANDLERS.
 * The three tools write three different formats and share no code path. Three
 * copies of "no evidence means candidate" is three places to forget one, and the
 * one that gets forgotten is invisible — it produces a file that looks fine.
 * Here the decision is made ONCE, from the raw tool argument, and every tool is
 * handed the same {@link AiWriteProvenance} value.
 *
 * WHY THE SAME VALUE REACHES THE DIALOG AND THE DISK. The plan's readiness block
 * demands a test that "the dialog receives exactly what goes to disk". That is a
 * property of the DESIGN here, not only of the test: {@link provenanceYamlBlock}
 * renders the stamp once, the confirmation message embeds that string, and the
 * writers SPLICE THAT SAME STRING into the file. The block is a literal
 * substring of the bytes written, so the two cannot drift without the splice
 * itself changing.
 *
 * THE ORIGIN UNION IS NOT WIDENED HERE. {@link AiWriteOrigin} is an `Extract`
 * over the closed {@link NarrativeOrigin}, never a re-declaration: a write tool
 * can produce `explicit` or `ai-candidate`, and `derived` belongs to facts
 * computed from other facts, which no tool here does. If a member disappears
 * from the domain union this stops compiling, which is the point.
 */

import { parse, stringify } from 'yaml';
import type {
  EvidenceRef,
  NarrativeOrigin
} from '@ai-focused-editor/narrative-knowledge/lib/common/graph';
import { buildEntityYaml } from './entity-creation';

/**
 * The two origins a WRITE TOOL can produce.
 *
 * Derived from the domain union rather than restated, so this narrowing tracks
 * the closed union it narrows. `derived` is excluded because nothing in this
 * file computes a fact from other indexed facts.
 */
export type AiWriteOrigin = Extract<NarrativeOrigin, 'explicit' | 'ai-candidate'>;

/**
 * The provenance stamp one AI write carries.
 *
 * `evidence` is present exactly when `origin` is `'explicit'`; the pairing is
 * produced only by {@link decideAiWriteProvenance}, which is the single place
 * that may pair them. A stamp is a whole value on purpose — passing `origin`
 * and `evidence` as two arguments would let a caller mismatch them.
 */
export interface AiWriteProvenance {
  origin: AiWriteOrigin;
  /** Where the claim was read from. Absent exactly for `ai-candidate`. */
  evidence?: EvidenceRef;
}

/** The provenance mapping exactly as it is serialized into an artifact. */
export interface AiWriteProvenanceRecord {
  origin: AiWriteOrigin;
  evidence?: EvidenceRef;
}

/** Either a usable stamp, or the reason the caller may not write at all. */
export type AiWriteProvenanceDecision =
  | { ok: true; provenance: AiWriteProvenance }
  | { ok: false; error: string };

/** Either the rewritten artifact text, or the reason it may not be written. */
export type AiWriteContentResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/**
 * A leading `---`…`---` front-matter fence, capturing the YAML body and the
 * closing fence separately so the stamp can be SPLICED in immediately before
 * the closer without re-serializing anything the author or the model wrote.
 *
 * Deliberately a mirror of `FRONT_MATTER_PATTERN` in the narrative-knowledge
 * package's `chapter-front-matter.ts`, not an import: that module exports the
 * parsed RESULT, not the pattern, and it belongs to another work package's
 * files. The mirroring is recorded here so a future divergence is a visible
 * one. The BOM is matched via its `\uFEFF` escape, never as a
 * literal character in source.
 */
const FRONT_MATTER_FENCE = /^\uFEFF?---[ \t]*\r?\n((?:(?!---[ \t]*(?:\r?\n|$)).*(?:\r?\n|$))*)(---[ \t]*(?:\r?\n|$))/;

/** Keys a caller-supplied front-matter block may NOT already carry. */
const RESERVED_PROVENANCE_KEYS = ['origin', 'evidence'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Reject an evidence path that could not name a file inside the workspace.
 *
 * Returns the reason, or `undefined` when the path is shaped acceptably. This
 * is a SHAPE check only — whether the file is really there is a filesystem
 * question the browser layer answers, and it answers it, because a citation of
 * a file that does not exist is exactly the fabricated fact this work package
 * exists to prevent.
 */
export function evidencePathProblem(path: string): string | undefined {
  if (!path.trim()) {
    return 'Evidence "path" must be a non-empty workspace-relative path.';
  }
  if (path.includes('..')) {
    return 'Evidence "path" must not contain "..".';
  }
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) {
    return 'Evidence "path" must be workspace-relative, not absolute.';
  }
  return undefined;
}

/**
 * Turn the raw `evidence` tool argument into a provenance stamp.
 *
 * THE THREE OUTCOMES, and why the middle one is not merged into either
 * neighbour:
 *
 *  - ABSENT (`undefined`/`null`/omitted) — the model cited nothing. That is
 *    allowed, and it is precisely what `ai-candidate` means. It is NOT an
 *    error, because refusing here would only teach the model to invent a
 *    citation.
 *  - MALFORMED — the model TRIED to cite something and got the shape wrong.
 *    This is refused rather than degraded to `ai-candidate`: silently
 *    downgrading a failed citation hides a bug in the caller behind a state
 *    that looks deliberate, and the author would see a candidate mark with no
 *    hint that a real citation was attempted and lost.
 *  - WELL-FORMED — `explicit`, carrying the pointer.
 *
 * A bare non-empty STRING is accepted as a whole-file path. That is the shape a
 * model reaches for first, it is unambiguous, and rejecting it would push the
 * caller toward the ABSENT branch — producing MORE unevidenced candidates,
 * which is the opposite of the point.
 */
export function decideAiWriteProvenance(rawEvidence: unknown): AiWriteProvenanceDecision {
  if (rawEvidence === undefined || rawEvidence === null) {
    return { ok: true, provenance: { origin: 'ai-candidate' } };
  }

  if (typeof rawEvidence === 'string') {
    const problem = evidencePathProblem(rawEvidence);
    return problem
      ? { ok: false, error: problem }
      : { ok: true, provenance: { origin: 'explicit', evidence: { path: rawEvidence.trim(), evidenceKind: 'whole-file' } } };
  }

  if (!isRecord(rawEvidence)) {
    return { ok: false, error: 'Evidence must be a workspace-relative path string, or an object { path, range? }.' };
  }

  const rawPath = rawEvidence.path;
  if (typeof rawPath !== 'string') {
    return { ok: false, error: 'Evidence object requires a "path" string (workspace-relative).' };
  }
  const problem = evidencePathProblem(rawPath);
  if (problem) {
    return { ok: false, error: problem };
  }
  const path = rawPath.trim();

  const rawRange = rawEvidence.range;
  if (rawRange === undefined || rawRange === null) {
    return { ok: true, provenance: { origin: 'explicit', evidence: { path, evidenceKind: 'whole-file' } } };
  }

  const range = parseEvidenceRange(rawRange);
  if (!range.ok) {
    return { ok: false, error: range.error };
  }
  return {
    ok: true,
    provenance: { origin: 'explicit', evidence: { path, evidenceKind: 'range', range: range.range } }
  };
}

type RangeParse =
  | { ok: true; range: { start: { line: number; character: number }; end: { line: number; character: number } } }
  | { ok: false; error: string };

/**
 * Parse the optional `range` of an evidence argument.
 *
 * A range that is present but unreadable is an ERROR, never a quiet fallback to
 * whole-file evidence. `evidenceKind` exists so that "we know the exact span"
 * and "we only know the file" stay distinguishable all the way to the UI
 * (WP-1's `evidence.ts`); silently answering a broken range with `'whole-file'`
 * would put a truthful-looking label on a lost fact.
 */
function parseEvidenceRange(rawRange: unknown): RangeParse {
  if (!isRecord(rawRange)) {
    return { ok: false, error: 'Evidence "range" must be an object { start: { line, character }, end: { line, character } }.' };
  }
  const start = parseEvidencePosition(rawRange.start, 'start');
  if (!start.ok) {
    return { ok: false, error: start.error };
  }
  const end = parseEvidencePosition(rawRange.end, 'end');
  if (!end.ok) {
    return { ok: false, error: end.error };
  }
  return { ok: true, range: { start: start.position, end: end.position } };
}

type PositionParse =
  | { ok: true; position: { line: number; character: number } }
  | { ok: false; error: string };

function parseEvidencePosition(rawPosition: unknown, which: 'start' | 'end'): PositionParse {
  if (!isRecord(rawPosition)) {
    return { ok: false, error: `Evidence "range.${which}" must be an object { line, character }.` };
  }
  const { line, character } = rawPosition;
  if (!nonNegativeInteger(line) || !nonNegativeInteger(character)) {
    return { ok: false, error: `Evidence "range.${which}" needs zero-based integer "line" and "character".` };
  }
  return { ok: true, position: { line, character } };
}

/**
 * The stamp as a plain serializable mapping — the value the confirmation
 * request carries and the value recoverable from the written file.
 */
export function provenanceRecord(provenance: AiWriteProvenance): AiWriteProvenanceRecord {
  return provenance.evidence
    ? { origin: provenance.origin, evidence: provenance.evidence }
    : { origin: provenance.origin };
}

/**
 * The stamp as YAML, at top-level indentation.
 *
 * This exact string is what the confirmation message shows AND what the entity
 * card and the note front matter are spliced with. Rendering it once is what
 * makes "the dialog got what the disk got" true by construction rather than by
 * two implementations agreeing.
 */
export function provenanceYamlBlock(provenance: AiWriteProvenance): string {
  return stringify(provenanceRecord(provenance));
}

/**
 * An entity card carrying its provenance.
 *
 * Built by CONCATENATION rather than by extending `buildEntityYaml`'s record:
 * two top-level YAML mappings concatenate into one, so the rendered stamp
 * survives into the file BYTE-FOR-BYTE, and the author-facing card shape stays
 * exactly what `buildEntityYaml` already produces for the four non-AI callers
 * (which are author actions and correctly write no `origin` at all — a card
 * with no `origin` key reads as `explicit`, WP-1's `DEFAULT_NARRATIVE_ORIGIN`).
 *
 * `provenance` is a REQUIRED parameter with no default. There is deliberately
 * no overload that omits it: an unstamped AI write must fail to compile, not
 * fall back to something reasonable.
 */
export function buildAiEntityCardYaml(
  input: { id: string; name: string; summary?: string },
  provenance: AiWriteProvenance
): string {
  return `${buildEntityYaml(input)}${provenanceYamlBlock(provenance)}`;
}

/**
 * A knowledge note carrying its provenance in front matter.
 *
 * The stamp is SPLICED, never re-serialized: when the model's markdown already
 * opens with a front-matter fence, the block is inserted immediately before the
 * closing `---`, leaving every existing key, comment and blank line untouched.
 * Re-emitting a parsed document instead would silently reformat text the model
 * (or, later, the author) wrote.
 *
 * A supplied front matter that ALREADY declares `origin` or `evidence` is
 * REFUSED. Provenance is the system's statement about the write, not an input
 * the writer may pre-fill; splicing on top of it would leave a duplicate YAML
 * key whose winner depends on the parser, and accepting it as given would let a
 * model stamp its own guess `explicit`.
 */
export function withProvenanceFrontMatter(markdown: string, provenance: AiWriteProvenance): AiWriteContentResult {
  const block = provenanceYamlBlock(provenance);
  const match = FRONT_MATTER_FENCE.exec(markdown);

  if (!match) {
    return { ok: true, content: `---\n${block}---\n\n${markdown}` };
  }

  const [fence, body, closing] = match;
  let parsed: unknown;
  try {
    parsed = parse(body);
  } catch (error) {
    return { ok: false, error: `The note's front matter is not valid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (parsed !== undefined && parsed !== null && !isRecord(parsed)) {
    return { ok: false, error: "The note's front matter must be a mapping of keys." };
  }
  const declared = RESERVED_PROVENANCE_KEYS.filter(key => isRecord(parsed) && key in parsed);
  if (declared.length > 0) {
    return {
      ok: false,
      error: `The note's front matter may not declare ${declared.join('/')} — provenance is recorded by the editor, not by the caller.`
    };
  }

  const spliced = `${fence.slice(0, fence.length - closing.length)}${block}${closing}`;
  return { ok: true, content: `${spliced}${markdown.slice(fence.length)}` };
}
