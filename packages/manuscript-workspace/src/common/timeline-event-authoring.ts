/**
 * Writing an event into `knowledge/timeline/*.yaml` from an editor selection
 * (gh#48 WP-5, plan Р-6).
 *
 * PURE AND Theia-FREE, the same split `entity-creation.ts` established: id
 * generation, YAML shaping and uniqueness are unit-testable in isolation, and
 * the browser contribution layers a prompt and a `FileService` write on top.
 *
 * ## The file is APPENDED TO AS TEXT, never re-serialized
 *
 * The obvious implementation parses the YAML, pushes an entry and stringifies
 * the result. It is wrong here, and not marginally: `yaml.stringify` returns a
 * NORMALIZED document — comments gone, quoting style changed, indentation and
 * key order re-decided. This is the author's file. A command that adds one event
 * and silently reformats two hundred lines around it has changed work the author
 * did not ask it to touch, and no diff review would forgive it.
 *
 * So the parse here is used for QUESTIONS ONLY — does this file already hold an
 * `events:` list, which ids does it use — and the write is an append of new
 * text. Everything above the insertion point survives byte for byte, and
 * {@link appendEventToTimeline} states that as a postcondition its tests check.
 *
 * ## What it refuses
 *
 * A file that is not a mapping with an `events:` list is REFUSED rather than
 * overwritten. It might be an author's own YAML that happens to sit in the
 * timeline directory, and clobbering it to make room for an event would destroy
 * exactly the thing this feature exists to collect.
 */

import { parse as parseYaml } from 'yaml';
import { transliterate } from './entity-creation';

/** Where events go when the author has not chosen a file. */
export const DEFAULT_TIMELINE_FILE = 'knowledge/timeline/main.yaml';

/** Zero-based line range, matching `EvidenceRef` — see `evidence.ts`. */
export interface TimelineSourceRange {
  startLine: number;
  endLine: number;
}

export interface NewTimelineEvent {
  /** Title as the author typed it. Written verbatim. */
  title: string;
  /** Workspace-relative path of the chapter the selection came from. */
  chapterPath: string;
  /** The selected lines, zero-based. Absent for a whole-file reference. */
  range?: TimelineSourceRange;
  /** Author's narrative order, when they gave one. */
  sequence?: number;
}

/** What an append produced, or why it could not. */
export type AppendTimelineResult =
  | {
      ok: true;
      /** The full new text of the timeline file. */
      text: string;
      /** The id the event was given — unique within the file. */
      eventId: string;
    }
  | {
      ok: false;
      /**
       * Why, in the author's terms. The caller shows it and writes nothing.
       *
       * `not-a-timeline-file` — the file is not a mapping with an `events:`
       * list, so it is somebody else's YAML and must not be touched.
       *
       * `cannot-append-safely` — it IS a timeline file, and appending text to
       * it would not produce a timeline file. That is a real and ordinary
       * shape: a trailing block scalar swallows the appended lines, list items
       * written at column 0 or at four spaces make the addition a parse error,
       * a key AFTER the list leaves nothing for the item to belong to. See
       * {@link appendEventToTimeline}'s postcondition for why this is DETECTED
       * rather than enumerated.
       */
      reason: 'not-a-timeline-file' | 'cannot-append-safely';
    };

/**
 * An id from the title, in the shape `createSemanticEntityId` gives entities.
 *
 * TRANSLITERATED, because the manuscript is Russian and an id is a key other
 * files type by hand: `event-ivan-priezzhaet` can be typed on any keyboard and
 * quoted in a `[[...]]`-style reference, `событие-иван-приезжает` cannot be
 * typed reliably in every editor this project has to survive.
 *
 * `event-` PREFIXED, and that is not decoration: event ids and entity ids live
 * in the same author-visible namespace of things typed into YAML, and a
 * timeline entry called `ivan` beside a character called `ivan` is a confusion
 * the author has to hold in their head. The prefix makes the kind readable at
 * the point of use.
 */
export function createEventId(title: string): string {
  const slug = transliterate(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug.length > 0 ? `event-${slug}` : 'event';
}

/**
 * Make `desired` unique against `taken`, by numeric suffix.
 *
 * SAME SHAPE AS `uniqueRelativePath`, deliberately: an author who writes two
 * events called "Прибытие" gets `event-pribytie` and `event-pribytie-2`, which
 * is the behaviour they already know from creating two entities with one name.
 */
export function uniqueEventId(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) {
    return desired;
  }
  for (let suffix = 2; ; suffix++) {
    const candidate = `${desired}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** Every event id a timeline file already uses. Empty for absent or unreadable
 *  text — the caller's uniqueness question, not a validity judgement. */
export function eventIdsIn(text: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (text === undefined) {
    return ids;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return ids;
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { events?: unknown }).events)) {
    return ids;
  }
  for (const entry of (parsed as { events: unknown[] }).events) {
    if (entry !== null && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      ids.add((entry as { id: string }).id);
    }
  }
  return ids;
}

/** The YAML block for one event, at list-item indentation. */
function eventBlock(event: NewTimelineEvent, id: string): string {
  const lines = [`  - id: ${id}`, `    title: ${quoteIfNeeded(event.title)}`];
  if (event.sequence !== undefined) {
    lines.push(`    sequence: ${event.sequence}`);
  }
  lines.push(`    chapter: ${event.chapterPath}`);
  lines.push('    source_refs:');
  lines.push(`      - path: ${event.chapterPath}`);
  if (event.range !== undefined) {
    // ZERO-BASED, like every other position in this project (`evidence.ts`).
    // Writing one-based numbers here would make the file disagree with what the
    // index stores and with what every other surface shows.
    lines.push(`        startLine: ${event.range.startLine}`);
    lines.push(`        endLine: ${event.range.endLine}`);
  }
  return lines.join('\n');
}

/**
 * Quote a scalar only when YAML would otherwise read it as something else.
 *
 * NOT ALWAYS-QUOTE: the author reads this file, and `title: Иван приезжает` is
 * what they would have written by hand. Quoting is applied where leaving it off
 * changes the MEANING — a leading indicator character, a colon-space that would
 * start a mapping, leading/trailing space, or a value YAML reads as a bool,
 * null or number.
 */
function quoteIfNeeded(value: string): string {
  const needsQuote =
    value.length === 0 ||
    value !== value.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    value.includes(': ') ||
    value.endsWith(':') ||
    value.includes(' #') ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(value) ||
    // `.inf`, `-.NaN` and friends are NUMBERS to YAML's core schema, and the
    // numeric test below wants a digit after the dot, so they slipped through.
    /^[+-]?\.(inf|nan)$/i.test(value) ||
    /^[+-]?(\d|\.\d)/.test(value);
  return needsQuote ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

/** The header a NEW timeline file gets. */
function newFileHeader(): string {
  return [
    '# Timeline events. `sequence` is the order things HAPPEN; the chapter is',
    '# where they are READ. Line numbers are zero-based.',
    'events:'
  ].join('\n');
}

/**
 * Add one event to a timeline file's text.
 *
 * `existing` ABSENT MEANS THE FILE DOES NOT EXIST and one is created with a
 * short header. An existing file is APPENDED TO — see the module note for why
 * nothing above the insertion point may move.
 *
 * `events: []` IS HANDLED SEPARATELY because it has to be: an empty FLOW list
 * cannot be extended by appending a block item, so the marker itself is
 * rewritten to `events:`. That is the one edit this function makes above its
 * own insertion point, it is confined to a single line, and the tests pin it.
 */
export function appendEventToTimeline(
  existing: string | undefined,
  event: NewTimelineEvent,
  idOverride?: string
): AppendTimelineResult {
  const eventId = idOverride ?? uniqueEventId(createEventId(event.title), eventIdsIn(existing));
  const block = eventBlock(event, eventId);

  if (existing === undefined || existing.trim().length === 0) {
    return { ok: true, text: `${newFileHeader()}\n${block}\n`, eventId };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(existing);
  } catch {
    return { ok: false, reason: 'not-a-timeline-file' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-a-timeline-file' };
  }
  const events = (parsed as { events?: unknown }).events;
  if (events !== null && events !== undefined && !Array.isArray(events)) {
    return { ok: false, reason: 'not-a-timeline-file' };
  }
  if (events === undefined) {
    return { ok: false, reason: 'not-a-timeline-file' };
  }

  // An empty list written in FLOW style (`events: []`) — it has to become a
  // block marker before an item can follow it.
  //
  // ANCHORED TO COLUMN 0, which is not pedantry: `^\s*events:` also matches a
  // NESTED `events: []` under some other key, and rewriting that one moved the
  // author's data and filed the event under `meta.events`. A trailing comment
  // is carried across rather than dropped — it is the author's note about the
  // list, and the list is still there.
  const emptyFlow = /^events:[ \t]*\[[ \t]*\][ \t]*(#.*)?$/m;
  const candidate = emptyFlow.test(existing)
    ? `${withTrailingNewline(existing.replace(emptyFlow, (_match, comment: string | undefined) =>
        comment === undefined ? 'events:' : `events: ${comment}`))}${block}\n`
    : `${withTrailingNewline(existing)}${block}\n`;

  return appendedSafely(candidate, eventId, eventIdsIn(existing))
    ? { ok: true, text: candidate, eventId }
    : { ok: false, reason: 'cannot-append-safely' };
}

/**
 * Did the append actually produce a timeline file with the event in it?
 *
 * THE POSTCONDITION EXISTS BECAUSE THE PRECONDITION CANNOT BE ENUMERATED. "The
 * file is a mapping with an `events:` list" is necessary and NOT sufficient for
 * "text appended at the end joins that list": a trailing block scalar swallows
 * the new lines, items written at column 0 or four spaces make the addition a
 * syntax error, a key after the list orphans it, `...` ends the document, an
 * anchor on the marker changes what the line is. Seven such shapes were found
 * in one sitting, and each was ACCEPTED and reported as success by the edition
 * that only checked the precondition — the file was corrupted or the event
 * silently dropped, and the author was told "Added".
 *
 * Checking the RESULT closes the whole class, including the shapes nobody has
 * thought of yet, and it fails in the only acceptable direction: a refusal the
 * author can read, with their file untouched.
 *
 * NOT A SECOND GUARD HIDING A FIRST. It verifies the same operation's output;
 * when it says no, nothing is written. The failure mode of a hiding guard —
 * a broken rule looking green because something upstream masked it — cannot
 * arise, because this one has no upstream.
 */
function appendedSafely(text: string, eventId: string, previousIds: ReadonlySet<string>): boolean {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    return false;
  }
  const ids = new Set<string>();
  for (const entry of events) {
    if (entry !== null && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      ids.add((entry as { id: string }).id);
    }
  }
  // THE FIRST HALF IS WHAT CATCHES EVERY KNOWN BAD SHAPE, including the
  // swallowed-into-a-block-scalar one: the parse succeeds and the list simply
  // does not contain the new id.
  //
  // THE SECOND HALF IS INSURANCE, AND IT IS NOT CURRENTLY REACHABLE — said
  // plainly rather than dressed up. No input has been found where the new event
  // arrives and one the author already had disappears; the shapes that could do
  // it (an alias list, a duplicated `events:` key) fail the parse or the first
  // half instead. It is kept because "nothing of the author's went missing" is
  // the property this function actually owes, and a postcondition that only
  // checks the ADDITION would let a future edit trade an old entry for a new one
  // without a test noticing. If it ever fires, the case that made it fire
  // belongs in the suite beside the six shapes above.
  return ids.has(eventId) && [...previousIds].every(id => ids.has(id));
}

/** `text` with exactly one trailing newline, so the appended block starts on a
 *  line of its own without inserting a blank one. */
function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}
