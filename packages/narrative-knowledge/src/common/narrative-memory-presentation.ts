/**
 * What every user-facing surface of the narrative index SHOWS, decided as a
 * pure function of what the index REPORTS (TASK-022 WP-5).
 *
 * WHY THIS IS A SEPARATE, THEIA-FREE MODULE. The plan's readiness block for
 * WP-5 asks for a case per row of the six-state table, a seventh on the
 * `ready → stale` transition, one on `no-manuscript`, one on the diagnostics
 * toggle, and two on the ownership-based Rebuild refusal. Every one of those is
 * a statement about a DECISION, not about Theia. Importing
 * `book-doctor-contribution.ts` or any other `@theia/core/lib/browser`
 * consumer under `bun` dies at `@lumino/domutils` on module load, so a
 * decision that lives inside a `StatusBarContribution` can only be tested in
 * the quarantined `test:widget` lane behind a DOM bootstrap — and then the
 * assertion is about a rendered widget rather than about the rule. Extracting
 * the rule leaves the contributions as wiring thin enough to read, and puts
 * all thirteen cases in the ordinary `test:packages` lane where they run
 * against the same code the product runs.
 *
 * The precedent is `ai-profile-status.test.ts`, which tests
 * `buildUnconfiguredAiProfileStatus` rather than `AiProfileStatusBarContribution`
 * for exactly this reason.
 *
 * THE TWO QUESTIONS ARE KEPT APART ON PURPOSE. `IndexState` answers "what is
 * the index doing"; {@link NarrativeMemoryPresentationInput.rebuildBlockedByForeignWriter}
 * answers "does another live process own the database". tech_spec ОВ-4 states
 * the Rebuild refusal BY OWNERSHIP and not by state, in those words, precisely
 * because an earlier state-keyed formulation contradicted itself. Folding the
 * lock into `IndexState` would put the contradiction back: a `failed` index
 * whose lock is live and a `failed` index whose lock expired are the same
 * state and must get different answers.
 */

import type { IndexFailureCode, IndexFailureReason } from './index-failure';
import { INDEX_FAILURE_CODES, indexFailureLocalizationKey } from './index-failure';
import type { IndexStaleReason, IndexState } from './index-state';
import { INDEX_STALE_REASONS } from './index-state';

// ---------------------------------------------------------------------------
// Localization keys
// ---------------------------------------------------------------------------

/** Namespace every phrase this package owns lives under. */
export const NARRATIVE_MEMORY_NLS_PREFIX = 'ai-focused-editor/narrative-memory';

/** The key a frontend renders for one `staleReason`. One key per member. */
export function indexStaleLocalizationKey(reason: IndexStaleReason): string {
  return `${NARRATIVE_MEMORY_NLS_PREFIX}/stale-${reason}`;
}

/**
 * A phrase this package owns: the key, and the English text the `nls.localize`
 * call site passes as its default.
 *
 * A CATALOG RATHER THAN SCATTERED LITERALS, for one checkable reason: the ru
 * bundle test walks it and asserts the bundle's key set EQUALS it, in both
 * directions. A phrase added to a surface and forgotten in the bundle, or a
 * bundle entry left behind after its surface was deleted, is red rather than a
 * raw identifier in the UI of a Russian-first product.
 *
 * EVERY PHRASE HERE IS ARITY 0. That is not a coincidence and not a
 * restriction inherited by accident — it is what makes a data-driven key safe.
 * The repository's placeholder-arity guard can only check a translation whose
 * key it can find at an `nls.localize(key, 'default', ...args)` call site with
 * LITERAL arguments; a key resolved through this catalog is invisible to that
 * scan. For an arity-0 phrase there is nothing to get wrong. A phrase that
 * NEEDS a substitution is therefore written as a literal call site in
 * `src/browser` instead (the broken-reference diagnostic messages are the only
 * ones today), where the guard sees both halves. The bundle test enforces the
 * split rather than trusting it.
 */
export interface NarrativeMemoryPhrase {
  readonly key: string;
  readonly default: string;
}

function phrase(leaf: string, english: string): NarrativeMemoryPhrase {
  return { key: `${NARRATIVE_MEMORY_NLS_PREFIX}/${leaf}`, default: english };
}

/**
 * One phrase per `IndexFailureCode`, total over the union for the same reason
 * {@link STALE_DEFAULTS} is: an eighth code added to ОВ-8 fails to compile here
 * rather than showing the user a raw identifier.
 *
 * The KEYS are WP-1's (`indexFailureLocalizationKey`); what is added here are
 * the English defaults, so a surface can render a code in a non-ru locale
 * without every call site carrying its own copy of the sentence.
 */
const FAILURE_DEFAULTS: Record<IndexFailureCode, string> = {
  'storage-unavailable': 'The narrative index file could not be opened.',
  'storage-corrupted': 'The narrative index file is damaged and did not recover. A full rebuild is needed.',
  'disk-full': 'There is no disk space left for the narrative index.',
  'permission-denied': 'The narrative index file cannot be read or written.',
  'manifest-unreadable': 'manifest.yaml could not be read, so chapter order is unknown.',
  'extraction-failed': 'A manuscript file could not be parsed while building the index.',
  'internal': 'Internal index error. Details are in the backend log.'
};

export const NARRATIVE_MEMORY_FAILURE_PHRASES: readonly NarrativeMemoryPhrase[] =
  INDEX_FAILURE_CODES.map(code => ({
    key: indexFailureLocalizationKey(code),
    default: FAILURE_DEFAULTS[code]
  }));

/** Status-bar and Show-Index-Status headlines, one per row of the WP-5 table. */
export const NARRATIVE_MEMORY_STATUS_PHRASES: readonly NarrativeMemoryPhrase[] = [
  phrase('status-ready', 'Narrative index: ready'),
  phrase('status-rebuilding', 'Narrative index: building'),
  phrase('status-stale', 'Narrative index: may be out of date'),
  phrase('status-not-built', 'Narrative index: not built'),
  phrase('status-failed', 'Narrative index: broken')
];

/**
 * One phrase per `staleReason`.
 *
 * Declared as a TOTAL `Record` over the union and then walked with
 * {@link INDEX_STALE_REASONS}, rather than written out as a list: a fourth
 * reason added to the closed union of ОВ-6 then fails to COMPILE here, instead
 * of shipping a raw `stale-<whatever>` identifier into the status bar.
 */
const STALE_DEFAULTS: Record<IndexStaleReason, string> = {
  'foreign-writer': 'another process owns the index, so this window is read-only',
  'watcher-lost': 'file change notifications stopped, so edits may have gone unseen',
  'partial-update-failed': 'one document could not be re-indexed; the rest of the index is intact'
};

export const NARRATIVE_MEMORY_STALE_PHRASES: readonly NarrativeMemoryPhrase[] = INDEX_STALE_REASONS.map(
  reason => ({ key: indexStaleLocalizationKey(reason), default: STALE_DEFAULTS[reason] })
);

/** Why a command is disabled, and the labels of the two commands themselves. */
export const NARRATIVE_MEMORY_COMMAND_PHRASES: readonly NarrativeMemoryPhrase[] = [
  phrase('rebuild-blocked-foreign-writer', 'The narrative index is owned by another process. Rebuilding would delete its work.'),
  phrase('rebuild-blocked-rebuilding', 'The narrative index is already being built.'),
  phrase('rebuild-started', 'Rebuilding the narrative index...'),
  phrase('rebuild-failed', 'The narrative index could not be rebuilt. Details are in the backend log.'),
  phrase('report-generation', 'Write generation'),
  phrase('report-stale-since', 'Out of date since'),
  phrase('report-occurrences', 'Times seen this session'),
  phrase('report-path', 'File'),
  phrase('report-incident', 'Incident id'),
  phrase('report-copy-incident', 'Copy incident id'),
  phrase('report-rebuild-blocked', 'Rebuild is unavailable: another process owns the index.')
];

/** Command labels and the settings-page descriptions of the five AD-5 keys. */
export const NARRATIVE_MEMORY_SETTINGS_PHRASES: readonly NarrativeMemoryPhrase[] = [
  phrase('command-category', 'Narrative Memory'),
  phrase('command-rebuild', 'Rebuild Index'),
  phrase('command-show-status', 'Show Index Status'),
  phrase('pref-diagnostics-enabled', 'Publish unresolved narrative references as problems. Takes effect immediately.'),
  // The `databasePath` description is REQUIRED to say this (AD-5): the file is
  // already open and re-aiming it at runtime would drop the writer lock.
  phrase('pref-database-path', 'Where the narrative index database lives, relative to the workspace root. Changing it takes effect at the NEXT backend start — the current database stays open until then.'),
  phrase('pref-debounce-ms', 'How long to wait after the last edit before re-indexing, in milliseconds. Takes effect at the next watcher window. A value outside 0-60000 is refused, not clamped.'),
  phrase('pref-fallback-ttl-ms', 'How often to sweep the workspace when file notifications are unreliable, in milliseconds. Takes effect at the next watcher window. A value outside 1000-3600000 is refused, not clamped.'),
  phrase('pref-max-open-workspaces', 'How many workspace indexes may stay open at once; the least recently used is closed beyond this. A value outside 1-32 is refused, not clamped.')
];

/**
 * The read-only AI tools: their names, their descriptions, and the sentences an
 * answer is not allowed to leave out (TASK-022 WP-6).
 *
 * DECLARED HERE RATHER THAN IN `narrative-memory-tools.ts`, and the reason is
 * the import direction. That module needs {@link NARRATIVE_MEMORY_NLS_PREFIX}
 * and {@link indexStaleLocalizationKey} from this one; if this one also imported
 * its phrase list back, the two would form a cycle. So the catalog stays whole
 * — the ru-bundle test asserts the bundle EQUALS it in both directions, and a
 * split catalog would quietly weaken that to a subset check — and the leaf names
 * are asserted against the tool module's own key constants by
 * `narrative-memory-tools.test.ts`, which is what stops the two editions
 * drifting.
 *
 * ARITY 0, LIKE EVERY OTHER CATALOG PHRASE. A tool answer that needs a value
 * (a stale timestamp, an incident id, a path) carries it as its OWN JSON field
 * next to the sentence, never as a `{0}` inside it — the same rule ОВ-8 states
 * for `incidentId` in Show Index Status, and for the same reason: a translator
 * may reorder words and must not be able to reorder an identifier.
 */
export const NARRATIVE_MEMORY_TOOL_PHRASES: readonly NarrativeMemoryPhrase[] = [
  phrase('tool-find-entities-name', 'Find Narrative Entities'),
  phrase(
    'tool-find-entities-description',
    'Search the narrative index for entity cards — characters, terms, artifacts, locations, or any type this book declares. ' +
      'The query matches a case-insensitive PREFIX of the name or of any alias; an empty query returns every entity. ' +
      'Every result names the card it was read from, and says whether the author wrote it, the index computed it, or an agent proposed it.'
  ),
  phrase('tool-find-mentions-name', 'Find Narrative Mentions'),
  phrase(
    'tool-find-mentions-description',
    'List every place an entity is referenced, or every reference inside one document. ' +
      'A reference written in prose carries its exact span; one read from YAML front matter carries the file and no position, and says so. ' +
      'References naming an entity no card defines are returned too, marked unresolved — they are what the author most needs to see.'
  ),
  phrase('tool-entity-relations-name', 'Get Narrative Relations'),
  phrase(
    'tool-entity-relations-description',
    'List the DIRECT relations of one entity: the links written in its card and the links computed from shared chapters. One hop only. ' +
      'A relation the author restated in both cards arrives as two relations, not one. ' +
      'Every relation names both ends, its type, its origin, whether either end resolves to a real card, and every file it was read from.'
  ),
  phrase('tool-document-context-name', 'Read Narrative Context'),
  phrase(
    'tool-document-context-description',
    'Everything the narrative index knows about one document, or one passage of it: the entities referenced there, every reference with its position, ' +
      'the relations those entities take part in, where they appeared in earlier chapters, and the defects found. ' +
      'It returns pointers, never manuscript prose. Chapters positioned after this one are withheld unless you ask for them, so an answer cannot spoil a book for its own author.'
  ),

  phrase(
    'tool-notice-not-built',
    'The narrative index has not been built yet, so there is nothing to answer from. Build it with the Rebuild Index command.'
  ),
  phrase(
    'tool-notice-no-manuscript',
    'This workspace is not a manuscript, so there is no narrative index to read.'
  ),
  phrase(
    'tool-notice-rebuilding',
    'The narrative index is being built right now. No answer would be complete yet, so none was given.'
  ),
  phrase(
    'tool-notice-stale',
    'This answer comes from an index that is no longer guaranteed to match the files. Treat every fact in it as possibly out of date.'
  ),
  phrase(
    'tool-notice-broken',
    'The narrative index is broken and answered nothing. The incident id in this answer appears beside the details in the backend log.'
  ),
  phrase(
    'tool-notice-whole-file-evidence',
    'Some evidence in this answer names a file and no position inside it, because the fact was read from a structural YAML field or from front matter. Open the file; do not claim a line.'
  ),
  phrase(
    'tool-notice-no-workspace',
    'No manuscript is open, so there is no narrative index to read.'
  ),
  phrase(
    'tool-notice-document-not-indexed',
    'The narrative index does not hold this document, so it can say nothing about it. That is not the same as the document holding nothing.'
  )
];

/** Every arity-0 phrase this package owns, failure codes included. */
export const NARRATIVE_MEMORY_PHRASES: readonly NarrativeMemoryPhrase[] = [
  ...NARRATIVE_MEMORY_FAILURE_PHRASES,
  ...NARRATIVE_MEMORY_STATUS_PHRASES,
  ...NARRATIVE_MEMORY_STALE_PHRASES,
  ...NARRATIVE_MEMORY_COMMAND_PHRASES,
  ...NARRATIVE_MEMORY_SETTINGS_PHRASES,
  ...NARRATIVE_MEMORY_TOOL_PHRASES
];

/**
 * The phrases that DO carry a substitution, listed here and localized
 * ELSEWHERE — at a literal `nls.localize('key', 'English {0}', arg)` call site
 * in `src/browser`.
 *
 * THE SPLIT IS FORCED BY THE GUARD, not by taste. The repository's
 * placeholder-arity guard lexes source for `nls.localize(` and can only read a
 * call whose key and default are STRING LITERALS; a key handed in from a
 * catalog is invisible to it. It then has a second guard —
 * `unscannedPlaceholderOffenders` — that turns exactly that invisibility red
 * for any translation containing a `{N}`. So a templated phrase cannot be
 * catalog-driven, and this list exists so the ru-bundle test can still assert
 * two-way completeness over the WHOLE bundle rather than over the arity-0 part
 * of it. The repository-wide orphan check closes the other direction: a key
 * listed here whose literal never appears in source goes red there.
 *
 * ОВ-8's own phrases stay arity 0 on the other side of this line, and that is
 * deliberate: its "кто что видит" table puts `relPath` and `occurrences`
 * BESIDE the phrase in Show Index Status and out of the status bar entirely, so
 * an embedded `{0}` would render as an empty pair of brackets exactly when the
 * path was dropped — which is exactly when the file lay outside the workspace.
 */
export const NARRATIVE_MEMORY_TEMPLATED_PHRASES: readonly NarrativeMemoryPhrase[] = [
  phrase('diagnostic-broken-mention', 'No entity named "{0}" is defined in this manuscript.'),
  phrase('diagnostic-broken-mention-whole-file', 'No entity named "{0}" is defined in this manuscript. The reference has no position, so this marker points at the start of the file.'),
  phrase('configure-rejected', 'Setting "{0}" was refused: {1}'),
  phrase('configure-deferred', 'Setting "{0}" will take effect at the next backend start.')
];

// ---------------------------------------------------------------------------
// The presentation
// ---------------------------------------------------------------------------

/** How loud the status bar entry is. `failed` is the only `error`. */
export type NarrativeStatusTone = 'normal' | 'warning' | 'error';

/** What the status bar shows, or `undefined` when the entry is HIDDEN. */
export interface NarrativeStatusBarPresentation {
  readonly tone: NarrativeStatusTone;
  /** Codicon name, without the `$()` wrapper. */
  readonly icon: string;
  /** Key of the headline phrase. */
  readonly phraseKey: string;
  /**
   * The store's write counter, shown only where it is meaningful.
   *
   * `ready` is the one row the plan's table asks for it on. Elsewhere it is
   * still reported — through Show Index Status, which shows it in EVERY state
   * (ОВ-6) — but a number next to "broken" or "not built" reads as progress.
   */
  readonly generation?: number;
  /** Keys of the extra lines the tooltip carries, in order. */
  readonly detailKeys: readonly string[];
}

/** Whether a command is offered, and if it is offered but refused, why. */
export interface NarrativeCommandPresentation {
  readonly visible: boolean;
  readonly enabled: boolean;
  /** Key of the phrase explaining the refusal. Present exactly when disabled
   *  AND visible — an invisible command needs no explanation. */
  readonly disabledReasonKey?: string;
}

/**
 * What to do with the marker set this publisher owns.
 *
 * TWO INDEPENDENT BOOLEANS, because the plan's table has two independent
 * columns and one of the rows separates them. `stale` says "уже опубликованные
 * маркеры СОХРАНЯЮТСЯ, новые НЕ публикуются" — retain without publishing. A
 * single tri-state enum could express that too, but it hides that `ready` is
 * the only row that publishes and makes the seventh readiness case (a
 * `ready → stale` transition removes nothing and adds nothing) read as one
 * assertion instead of the two the plan spells out.
 */
export interface NarrativeDiagnosticsPresentation {
  /** Compute and publish markers for the current index contents. */
  readonly publishNew: boolean;
  /** Leave markers published in an earlier state in place. `false` withdraws
   *  this owner's markers. */
  readonly retainExisting: boolean;
}

export interface NarrativeMemoryPresentationInput {
  readonly state: IndexState;
  /**
   * Whether a LIVE foreign writer lock exists RIGHT NOW (tech_spec ОВ-4).
   *
   * Answered by the backend at call time from the database file itself, never
   * derived from `state`: an expired lock leaves the state it caused behind.
   */
  readonly rebuildBlockedByForeignWriter: boolean;
  /** `narrativeMemory.diagnostics.enabled`. */
  readonly diagnosticsEnabled: boolean;
}

export interface NarrativeMemoryPresentation {
  /** `undefined` means the status bar entry is removed entirely. */
  readonly statusBar: NarrativeStatusBarPresentation | undefined;
  readonly rebuildCommand: NarrativeCommandPresentation;
  readonly showStatusCommand: NarrativeCommandPresentation;
  readonly diagnostics: NarrativeDiagnosticsPresentation;
}

const HIDDEN: NarrativeCommandPresentation = { visible: false, enabled: false };
const AVAILABLE: NarrativeCommandPresentation = { visible: true, enabled: true };

/** Nothing to show and nothing to say: this workspace is not a manuscript. */
function noManuscript(): NarrativeMemoryPresentation {
  return {
    statusBar: undefined,
    rebuildCommand: HIDDEN,
    showStatusCommand: HIDDEN,
    diagnostics: { publishNew: false, retainExisting: false }
  };
}

function rebuildCommandFor(
  state: IndexState,
  rebuildBlockedByForeignWriter: boolean
): NarrativeCommandPresentation {
  // OWNERSHIP FIRST, AND THAT ORDER IS THE RULE (ОВ-4): "Rebuild Index
  // ОТКЛОНЯЕТСЯ всегда, пока в `meta` виден ЖИВОЙ чужой замок писателя,
  // НЕЗАВИСИМО от того, какое состояние это породило". The command STAYS
  // VISIBLE — hiding it leaves the user unable to see why the one action the
  // status bar offers does nothing.
  if (rebuildBlockedByForeignWriter) {
    return {
      visible: true,
      enabled: false,
      disabledReasonKey: `${NARRATIVE_MEMORY_NLS_PREFIX}/rebuild-blocked-foreign-writer`
    };
  }
  if (state.state === 'rebuilding') {
    return {
      visible: true,
      enabled: false,
      disabledReasonKey: `${NARRATIVE_MEMORY_NLS_PREFIX}/rebuild-blocked-rebuilding`
    };
  }
  return AVAILABLE;
}

function statusBarFor(state: IndexState): NarrativeStatusBarPresentation {
  switch (state.state) {
    case 'ready':
      return {
        tone: 'normal',
        icon: 'book',
        phraseKey: `${NARRATIVE_MEMORY_NLS_PREFIX}/status-ready`,
        generation: state.generation,
        detailKeys: []
      };
    case 'rebuilding':
      return {
        tone: 'normal',
        icon: 'sync~spin',
        phraseKey: `${NARRATIVE_MEMORY_NLS_PREFIX}/status-rebuilding`,
        detailKeys: []
      };
    case 'stale':
      return {
        // WARNING, NOT ERROR, and the difference is the point of the row:
        // `stale` data was right and is still usable, `failed` data is not
        // there at all. An error tone on a working index trains the user to
        // ignore the error tone.
        tone: 'warning',
        icon: 'warning',
        phraseKey: `${NARRATIVE_MEMORY_NLS_PREFIX}/status-stale`,
        detailKeys: [indexStaleLocalizationKey(state.staleReason)]
      };
    case 'failed':
      return {
        tone: 'error',
        icon: 'error',
        phraseKey: `${NARRATIVE_MEMORY_NLS_PREFIX}/status-failed`,
        // The CODE's phrase, never the message: ОВ-8 keeps `Error.message` and
        // `Error.stack` on the backend, and the status bar shows neither the
        // path nor the incident id.
        detailKeys: [indexFailureLocalizationKey(state.reason.code)]
      };
    case 'absent':
      return {
        tone: 'normal',
        icon: 'circle-outline',
        phraseKey: `${NARRATIVE_MEMORY_NLS_PREFIX}/status-not-built`,
        detailKeys: []
      };
  }
}

/**
 * The whole of WP-5's presentation, in one total function.
 *
 * One input, one output, and every row of the plan's table is one call — which
 * is what lets the readiness cases assert the rows rather than assert a
 * rendering of them.
 */
export function narrativeMemoryPresentation(
  input: NarrativeMemoryPresentationInput
): NarrativeMemoryPresentation {
  const { state, rebuildBlockedByForeignWriter, diagnosticsEnabled } = input;

  // `no-manuscript` is an ANSWER, not a failure, and the answer is that this
  // package has nothing to say here. Checked FIRST so the ownership rule cannot
  // resurrect a command in a workspace that has no manuscript at all.
  if (state.state === 'absent' && state.cause === 'no-manuscript') {
    return noManuscript();
  }

  const rebuildCommand = rebuildCommandFor(state, rebuildBlockedByForeignWriter);

  // `ready` is the only state whose contents are authoritative enough to
  // publish from. `stale` retains — withdrawing would hide real broken links,
  // adding would invent new ones from possibly stale data (ОВ-6).
  //
  // `rebuilding` retains too, and that is the one reading here that goes past
  // the letter of the table's "НЕ публикуются". The table forbids PUBLISHING,
  // which this honours; withdrawal is a separate act, and withdrawing would be
  // actively wrong: WP-4b's maintainer opens a rebuilding pass around EVERY
  // incremental batch, so a `rebuilding` observation is the normal condition
  // of a workspace being typed in, and clearing the Problems view on each
  // debounce window would strobe it. `absent` and `failed` withdraw: `absent`
  // has no data for a marker to have come from, and `failed` is recovery
  // REFUSED rather than freshness merely unpromised.
  const retainExisting =
    diagnosticsEnabled && (state.state === 'ready' || state.state === 'stale' || state.state === 'rebuilding');

  return {
    statusBar: statusBarFor(state),
    rebuildCommand,
    showStatusCommand: AVAILABLE,
    diagnostics: {
      publishNew: diagnosticsEnabled && state.state === 'ready',
      retainExisting
    }
  };
}

// ---------------------------------------------------------------------------
// Show Index Status
// ---------------------------------------------------------------------------

/**
 * Everything Show Index Status reports, as data.
 *
 * ОВ-8's "who sees what" table gives this surface strictly more than the
 * status bar: the phrase AND `relPath` AND `occurrences` AND `incidentId` in a
 * monospaced line with a copy button. ОВ-6 adds `staleReason`, `staleSince`
 * and `generation`. The `incidentId` is a FIELD here and never a substitution
 * inside a phrase, because a translator may reorder a sentence and must not be
 * able to reorder an identifier.
 */
export interface NarrativeIndexStatusReport {
  /** Key of the headline — the same phrase the status bar shows. */
  readonly headlineKey: string;
  /** The store's write counter. Present on EVERY branch of `IndexState`, which
   *  is the whole reason the envelope exists: an empty answer during a rebuild
   *  has to be distinguishable from an empty answer meaning "no such thing". */
  readonly generation: number;
  readonly staleReason?: IndexStaleReason;
  readonly staleSince?: number;
  readonly failure?: IndexFailureReason;
  /** True when a live foreign lock is refusing Rebuild right now. */
  readonly rebuildBlockedByForeignWriter: boolean;
  /** True when there is no manuscript here — the report says so and stops. */
  readonly noManuscript: boolean;
}

export function narrativeIndexStatusReport(
  input: NarrativeMemoryPresentationInput
): NarrativeIndexStatusReport {
  const { state, rebuildBlockedByForeignWriter } = input;
  const noManuscriptHere = state.state === 'absent' && state.cause === 'no-manuscript';
  const headlineKey = noManuscriptHere
    ? `${NARRATIVE_MEMORY_NLS_PREFIX}/status-not-built`
    : statusBarFor(state).phraseKey;
  return {
    headlineKey,
    generation: state.generation,
    ...(state.state === 'stale' ? { staleReason: state.staleReason, staleSince: state.staleSince } : {}),
    ...(state.state === 'failed' ? { failure: state.reason } : {}),
    rebuildBlockedByForeignWriter,
    noManuscript: noManuscriptHere
  };
}

// ---------------------------------------------------------------------------
// Failure codes, as data for the surfaces above
// ---------------------------------------------------------------------------

/** Re-exported for surfaces that render a failure without importing two files. */
export type { IndexFailureCode };
