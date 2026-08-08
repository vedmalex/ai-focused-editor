/**
 * Read events out of a `knowledge/timeline/*.yaml` file (gh#48 WP-1).
 *
 * PURE, AND UNDER THE SAME LAYER RULE AS EVERY OTHER EXTRACTOR: no filesystem,
 * no Theia, no SQLite. The text is handed in by whoever owns the disk, which is
 * what lets the whole event model be asserted under plain `bun test`.
 *
 * ## Nothing is dropped silently
 *
 * A malformed entry, a duplicate id, a reference to a card that does not exist —
 * all of them produce a PROBLEM and, where an event can still be built, the
 * event too. This is not leniency: the author is the one who has to fix these,
 * and an extractor that quietly skipped what it disliked would leave them with a
 * timeline that is wrong in a way nothing on screen explains.
 *
 * ## What this file deliberately does not decide
 *
 * ORDER. `sequence` is carried through verbatim and never compared here; the one
 * ordering rule lives beside the store, so both adapters and every consumer read
 * the same one (the shape `mention-ordering.ts` established for gh#47).
 *
 * RESOLUTION. Whether `char:ivan` names a real card is a workspace-level fact,
 * so the caller passes a predicate. The extractor records the answer, it does
 * not look it up — the same split the mention extractor uses.
 *
 * THE PREDICATE TAKES THE WRITTEN KIND, NOT ONLY THE ID (gh#90). It did take
 * only the id, and that made events the ONE place in this package that
 * disagreed with `isReferenceResolved`: `NarrativeEntity.id` is unique only
 * WITHIN a type, so an event writing `char:ivan` against a manuscript that
 * defines a LOCATION called `ivan` was reported as resolved — a broken
 * reference wearing the flag that exists to make broken references visible. The
 * rule was already written down for prose mentions; events now ask the same
 * question instead of a weaker one.
 */

import { parse as parseYaml } from 'yaml';
import {
  rangeEvidence,
  wholeFileEvidence,
  type EvidenceRef,
  type EventRef,
  type EventStoryTime,
  type EventTimeKind,
  type NarrativeEvent,
  type NarrativeEventProblem,
  EVENT_TIME_KINDS
} from '../graph';
import { asString, isRecord, normalizeWorkspacePath } from './yaml-values';

/**
 * Whether a reference resolves, asked the way `isReferenceResolved` asks it.
 *
 * ARGUMENT ORDER MATCHES `isReferenceResolved(catalog, kind, id)` on purpose, so
 * the ordinary caller is a one-line forward and there is no chance to swap the
 * two strings — they are both `string`, and a swap would compile.
 */
export type IsKnownEventRef = (kind: string | undefined, entityId: string) => boolean;

export interface ExtractedEvents {
  events: NarrativeEvent[];
  problems: NarrativeEventProblem[];
}

/** The reference lists an event may carry, and the role each becomes. */
const REF_FIELDS: readonly { field: string; role: string; list: boolean }[] = [
  { field: 'participants', role: 'participant', list: true },
  { field: 'location', role: 'location', list: false },
  { field: 'plot_threads', role: 'thread', list: true }
];

function problem(
  kind: NarrativeEventProblem['kind'],
  path: string,
  message: string,
  eventId?: string
): NarrativeEventProblem {
  return { kind, path, message, ...(eventId === undefined ? {} : { eventId }) };
}

/**
 * Split `kind:id` into its parts.
 *
 * A reference with no colon is an ID WITH NO KIND, not a malformed one: the
 * bare form is legal everywhere else in this package, and rejecting it here
 * would make events the one place that disagrees.
 */
function splitRef(raw: string): { kind?: string; entityId: string } {
  const colon = raw.indexOf(':');
  if (colon <= 0 || colon === raw.length - 1) {
    return { entityId: raw };
  }
  return { kind: raw.slice(0, colon), entityId: raw.slice(colon + 1) };
}

function readRefs(entry: Record<string, unknown>, isKnownEntity: IsKnownEventRef): EventRef[] {
  const refs: EventRef[] = [];
  for (const { field, role, list } of REF_FIELDS) {
    const value = entry[field];
    const raws = list
      ? Array.isArray(value)
        ? value.map(item => asString(item)).filter(item => item.length > 0)
        : []
      : [asString(value)].filter(item => item.length > 0);
    for (const raw of raws) {
      const { kind, entityId } = splitRef(raw);
      refs.push({
        role,
        raw,
        entityId,
        ...(kind === undefined ? {} : { kind }),
        // Recorded, not looked up — see the module note. The KIND travels with
        // the id: `char:ivan` and a bare `ivan` are different questions.
        resolved: isKnownEntity(kind, entityId)
      });
    }
  }
  return refs;
}

/**
 * Read `story_time`.
 *
 * AN ABSENT `story_time` IS `unknown`, not a problem: most events an author
 * writes down early have no time, and demanding the key would turn a normal
 * state into a diagnostic. A `kind` the author misspells IS a problem — that is
 * a typo, and silently reading it as `unknown` would hide it.
 */
function readStoryTime(
  entry: Record<string, unknown>,
  path: string,
  eventId: string,
  problems: NarrativeEventProblem[]
): EventStoryTime {
  const raw = entry.story_time;
  if (!isRecord(raw)) {
    return { kind: 'unknown' };
  }
  const kindText = asString(raw.kind);
  const kind: EventTimeKind = (EVENT_TIME_KINDS as readonly string[]).includes(kindText)
    ? (kindText as EventTimeKind)
    : 'unknown';
  if (kindText.length > 0 && kind === 'unknown' && kindText !== 'unknown') {
    problems.push(
      problem('unknown-time-kind', path, `story_time.kind "${kindText}" is not one of ${EVENT_TIME_KINDS.join(', ')}`, eventId)
    );
  }
  const value = asString(raw.value);
  const time: EventStoryTime = { kind, ...(value.length === 0 ? {} : { value }) };
  if (kind !== 'exact') {
    return time;
  }
  // ONLY `exact` CLAIMS TO BE A DATE, so only `exact` can fail to be one. A
  // `relative` value like "three winters later" is not a defect and must never
  // be reported as one.
  const parsed = value.length === 0 ? Number.NaN : Date.parse(value);
  if (Number.isNaN(parsed)) {
    problems.push(
      problem('exact-time-unparsable', path, `story_time claims kind "exact" but "${value}" is not a date`, eventId)
    );
    return time;
  }
  return { ...time, parsedMs: parsed };
}

/**
 * Read the passages an event points at.
 *
 * A `source_ref` WITHOUT LINES IS WHOLE-FILE EVIDENCE, not a broken range. The
 * evidence union says exactly this: naming a file and no place in it is a real,
 * weaker kind of pointer, and consumers present it by opening the file WITHOUT
 * positioning the cursor. Manufacturing `line: 0` would make a weaker claim
 * indistinguishable from a precise one.
 */
function readSourceRefs(entry: Record<string, unknown>, fallbackPath: string): EvidenceRef[] {
  const raw = entry.source_refs;
  if (!Array.isArray(raw)) {
    return [];
  }
  const refs: EvidenceRef[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const target = asString(item.uri) || asString(item.path) || fallbackPath;
    const path = normalizeWorkspacePath(target);
    const startLine = typeof item.startLine === 'number' ? item.startLine : undefined;
    const endLine = typeof item.endLine === 'number' ? item.endLine : startLine;
    if (startLine === undefined || endLine === undefined) {
      refs.push(wholeFileEvidence(path));
      continue;
    }
    refs.push(
      rangeEvidence(path, {
        start: { line: startLine, character: 0 },
        end: { line: endLine, character: 0 }
      })
    );
  }
  return refs;
}

/**
 * Read every event in one timeline file.
 *
 * DUPLICATE IDS PRODUCE A PROBLEM AND KEEP BOTH EVENTS. Folding them would lose
 * an author's work to a typo; the duplicate is reported, and which one wins is a
 * question for the store's identity, not for the reader of one file.
 */
export function extractEvents(
  file: { path: string; text: string },
  isKnownEntity: IsKnownEventRef = () => false
): ExtractedEvents {
  const path = normalizeWorkspacePath(file.path);
  const problems: NarrativeEventProblem[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(file.text);
  } catch (error) {
    return { events: [], problems: [problem('malformed', path, `YAML did not parse: ${String(error)}`)] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.events)) {
    return {
      events: [],
      problems: [problem('malformed', path, 'a timeline file must be a mapping with an `events:` list')]
    };
  }

  const events: NarrativeEvent[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.events) {
    if (!isRecord(entry)) {
      problems.push(problem('malformed', path, 'an entry under `events:` is not a mapping'));
      continue;
    }
    const id = asString(entry.id);
    if (id.length === 0) {
      problems.push(problem('missing-id', path, 'an event has no `id`'));
      continue;
    }
    if (seen.has(id)) {
      problems.push(problem('malformed', path, `event id "${id}" appears more than once in this file`, id));
    }
    seen.add(id);
    const title = asString(entry.title);
    if (title.length === 0) {
      problems.push(problem('missing-title', path, `event "${id}" has no \`title\``, id));
    }
    let sequence: number | undefined;
    if (entry.sequence !== undefined) {
      if (typeof entry.sequence === 'number' && Number.isFinite(entry.sequence)) {
        sequence = entry.sequence;
      } else {
        problems.push(problem('invalid-sequence', path, `event "${id}" has a non-numeric \`sequence\``, id));
      }
    }
    const chapter = asString(entry.chapter_id) || asString(entry.chapter);
    events.push({
      id,
      title,
      storyTime: readStoryTime(entry, path, id, problems),
      ...(sequence === undefined ? {} : { sequence }),
      ...(chapter.length === 0 ? {} : { chapterPath: normalizeWorkspacePath(chapter) }),
      refs: readRefs(entry, isKnownEntity),
      origin: asString(entry.origin) === 'ai-candidate'
        ? 'ai-candidate'
        : asString(entry.origin) === 'derived'
          ? 'derived'
          : 'explicit',
      ...(typeof entry.confidence === 'number' ? { confidence: entry.confidence } : {}),
      // The event was read from the timeline file; that is where "open source"
      // for the event ITSELF goes. Its `sourceRefs` point into the manuscript.
      evidence: wholeFileEvidence(path),
      sourceRefs: readSourceRefs(entry, path)
    });
  }
  return { events, problems };
}
