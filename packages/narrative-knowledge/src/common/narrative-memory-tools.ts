/**
 * What the read-only AI tools DECIDE, as a pure function of what the index
 * reports (TASK-022 WP-6).
 *
 * SAME SPLIT AS WP-5, FOR THE SAME REASON. `narrative-memory-presentation.ts`
 * decides what the status bar shows and leaves `StatusBar` to a contribution
 * that has nothing left in it but assignment; this module decides what a tool
 * ANSWER says about the index and leaves the `ToolProvider` classes to
 * `src/browser`. The four requirements of the plan's WP-6 readiness block are
 * statements about a decision, not about `@theia/ai-core`, so they belong in the
 * ordinary `test:packages` lane rather than behind a DI container.
 *
 * THE FOUR REQUIREMENTS, AND WHERE EACH ONE LIVES:
 *
 *   1. a relation that does not exist, under `ready`, is an EMPTY result — not
 *      an error and not a refusal. That is {@link NarrativeToolIndexReport.answered}
 *      being `true` while the payload list is `[]`;
 *   2. `rebuilding` / `absent` is an explicit NOT READY — `answered: false`, and
 *      the caller emits NO data key at all. An empty list here would assert
 *      "there is no such thing" about an index that has not finished reading;
 *   3. `failed` is an explicit BROKEN, with the reason. tech_spec ОВ-8's
 *      "кто что видит" table gives this consumer exactly two things: the
 *      localized phrase for the `code`, and the `incidentId` — so the user can
 *      tie the model's answer to a line in the backend log. Never `relPath`,
 *      never `message`, never `stack`;
 *   4. `stale` is the FOURTH answer and the one that is easy to get wrong: the
 *      tool ANSWERS, and EVERY answer carries an explicit mark of staleness
 *      with its reason (ОВ-6, "инструмент ОТВЕЧАЕТ по существу, но КАЖДЫЙ
 *      ответ несёт явную пометку устаревания с причиной").
 *
 * WHY THE NOTICE TRAVELS AS KEYS AND NOT AS SENTENCES. This module is Theia-free
 * so it can run under `bun`, and the phrases live in the ru bundle WP-5 created.
 * A key list is the same device `NarrativeStatusBarPresentation.detailKeys`
 * already uses, and it keeps the decision ("under `stale` a tool MUST say so")
 * separable from the wording.
 */

import type { IndexAbsentCause, IndexStaleReason, IndexState } from './index-state';
import {
  NARRATIVE_MEMORY_NLS_PREFIX,
  indexStaleLocalizationKey
} from './narrative-memory-presentation';
import { indexFailureLocalizationKey, type IndexFailureCode } from './index-failure';

// ---------------------------------------------------------------------------
// The four tools
// ---------------------------------------------------------------------------

/**
 * Ids of the four read-only tools, as the language model sees them.
 *
 * `narrative_` RATHER THAN `manuscript_`, and that is not cosmetic: six older
 * `manuscript_*` tools elsewhere in this repository read the services WP-7 is
 * about to absorb, and for the whole of WP-7 both sets are registered in the
 * same `ToolInvocationRegistry`. A colliding id there is not a compile error —
 * it is one provider silently shadowing another in a `Map`.
 */
export const NARRATIVE_FIND_ENTITIES_TOOL_ID = 'narrative_find_entities';
export const NARRATIVE_FIND_MENTIONS_TOOL_ID = 'narrative_find_mentions';
export const NARRATIVE_ENTITY_RELATIONS_TOOL_ID = 'narrative_entity_relations';
export const NARRATIVE_DOCUMENT_CONTEXT_TOOL_ID = 'narrative_document_context';

/** Every id above, as data — a test walks it for uniqueness and for the
 *  `allowedTools` list of the skill. */
export const NARRATIVE_MEMORY_TOOL_IDS = [
  NARRATIVE_FIND_ENTITIES_TOOL_ID,
  NARRATIVE_FIND_MENTIONS_TOOL_ID,
  NARRATIVE_ENTITY_RELATIONS_TOOL_ID,
  NARRATIVE_DOCUMENT_CONTEXT_TOOL_ID
] as const;

/**
 * Localization keys of each tool's name and description.
 *
 * A TOTAL `Record` OVER THE FOUR IDS, so a fifth tool fails to compile here
 * rather than shipping a raw identifier into the model's tool list — the same
 * device `STALE_DEFAULTS` uses over `IndexStaleReason`. The phrases themselves
 * live in `NARRATIVE_MEMORY_TOOL_PHRASES`; see the note there about why the two
 * halves sit in different files and what asserts they agree.
 */
export const NARRATIVE_TOOL_PHRASE_KEYS: Record<
  (typeof NARRATIVE_MEMORY_TOOL_IDS)[number],
  { readonly name: string; readonly description: string }
> = {
  [NARRATIVE_FIND_ENTITIES_TOOL_ID]: {
    name: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-find-entities-name`,
    description: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-find-entities-description`
  },
  [NARRATIVE_FIND_MENTIONS_TOOL_ID]: {
    name: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-find-mentions-name`,
    description: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-find-mentions-description`
  },
  [NARRATIVE_ENTITY_RELATIONS_TOOL_ID]: {
    name: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-entity-relations-name`,
    description: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-entity-relations-description`
  },
  [NARRATIVE_DOCUMENT_CONTEXT_TOOL_ID]: {
    name: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-document-context-name`,
    description: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-document-context-description`
  }
};

// ---------------------------------------------------------------------------
// Display order (ISS-349, decided here)
// ---------------------------------------------------------------------------

/**
 * The locale entity NAMES are ordered under, stated EXPLICITLY and never
 * inferred from the host.
 *
 * THE INDEX ORDERS BY CODE POINT, AND THAT IS RIGHT DOWN THERE. ISS-349 fixed
 * it deliberately and irreversibly: SQLite's default `BINARY` collation is the
 * only order both adapters can agree on (registering an ICU collation needs an
 * API the pinned `node:sqlite` subset of ОВ-7 does not include), so `findEntities`
 * returns `Ярость` before `арджуна` — every upper-case Cyrillic letter sorts
 * before every lower-case one. WP-4a pushed readable ordering to presentation
 * and WP-5 declined to build it, because it renders no ordered list of names
 * anywhere and a helper nobody calls is dead code with a live-looking name.
 *
 * THIS IS THE FIRST SURFACE THAT RENDERS ONE. The result of
 * `narrative_find_entities` is a list of entity NAMES read by a person through
 * a chat, so it is ordered FOR A READER and collated. Everything else these
 * tools return — mentions, relations, evidence — is ordered by document path
 * and position, which is a reading order and a machine key rather than an
 * alphabet, and stays in the index's code-point order untouched.
 *
 * WHY AN EXPLICIT LOCALE AND NOT `localeCompare()`. A bare `localeCompare` reads
 * the HOST's locale, so the same manuscript sorts differently on two machines
 * and the same tool answers differently to two authors — it fails
 * reproducibility all by itself, which is exactly the property ISS-349 was
 * protecting when it chose code point. An explicit locale keeps the answer
 * reproducible AND readable.
 *
 * WHY `ru`. This is a Russian-first product: the ru bundle is the primary
 * locale, the manuscripts these tools read are Cyrillic, and `Intl.Collator`
 * orders Latin text the way an English reader expects under a `ru` locale too.
 * The choice is a constant rather than a setting because a per-book collation
 * is a decision with a preference key behind it, and #46 has no such key.
 */
export const NARRATIVE_TOOL_COLLATION_LOCALE = 'ru';

/**
 * The collator every reader-facing list in these tools is ordered by.
 *
 * `sensitivity: 'variant'` so that two names differing only in case or accent
 * still have a stable relative order rather than comparing equal and falling
 * through to whatever the sort happened to do; `numeric` so `Глава 2` precedes
 * `Глава 10`.
 */
const displayCollator = new Intl.Collator(NARRATIVE_TOOL_COLLATION_LOCALE, {
  numeric: true,
  sensitivity: 'variant'
});

/** The two fields the display order reads. Deliberately structural: the
 *  comparator must be usable on a projection as well as on a `NarrativeEntity`. */
export interface DisplayOrderedEntity {
  id: string;
  name: string;
}

/**
 * Order two entities the way a reader expects to see them.
 *
 * BY NAME, THEN BY ID IN CODE POINT ORDER. The tie-break is not decoration: two
 * cards may legitimately carry the same `name` (that is what an id is for), and
 * a comparator that returns 0 for them leaves their relative order to the
 * sort's internals — which is a reproducibility hole of exactly the kind this
 * function exists to close. The tie-break is code point, not collated, because
 * an id is a machine key.
 */
export function compareEntitiesForDisplay(
  left: DisplayOrderedEntity,
  right: DisplayOrderedEntity
): number {
  const byName = displayCollator.compare(left.name, right.name);
  if (byName !== 0) {
    return byName;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The index report every answer carries
// ---------------------------------------------------------------------------

/** Localization keys of the sentences a tool answer must carry. */
export const NARRATIVE_TOOL_NOTICE_KEYS = {
  notBuilt: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-notice-not-built`,
  noManuscript: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-notice-no-manuscript`,
  rebuilding: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-notice-rebuilding`,
  stale: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-notice-stale`,
  broken: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-notice-broken`,
  wholeFileEvidence: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-notice-whole-file-evidence`,
  noWorkspace: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-notice-no-workspace`,
  documentNotIndexed: `${NARRATIVE_MEMORY_NLS_PREFIX}/tool-notice-document-not-indexed`
} as const;

/**
 * What every tool answer says about the index it was read from.
 *
 * `answered` IS THE LOAD-BEARING FIELD. It is the difference between "there is
 * no such relation" and "the index could not say", and it is what tells a caller
 * whether to emit a data key at all — the machine form of the `Envelope`'s whole
 * reason for existing.
 */
export interface NarrativeToolIndexReport {
  /** `IndexState.state`, verbatim. */
  readonly state: IndexState['state'];
  /** The store's write counter. Present on every branch. */
  readonly generation: number;
  /** True when the payload carries data the caller may act on. */
  readonly answered: boolean;
  /** Present exactly when `state === 'absent'`. */
  readonly absentCause?: IndexAbsentCause;
  /** Present exactly when `state === 'stale'`. */
  readonly staleReason?: IndexStaleReason;
  /** Present exactly when `state === 'stale'`. Epoch milliseconds. */
  readonly staleSince?: number;
  /** Present exactly when `state === 'failed'`. */
  readonly failureCode?: IndexFailureCode;
  /**
   * Present exactly when `state === 'failed'`.
   *
   * ОВ-8's table names this consumer explicitly: "Локализованная фраза по `code`
   * + `incidentId` в тексте отказа (чтобы пользователь мог связать ответ модели
   * с логом)". `relPath` is NOT here and neither is `message` — those belong to
   * Show Index Status and to the backend log respectively.
   */
  readonly incidentId?: string;
  /**
   * Keys of the sentences the answer must show, in order.
   *
   * EMPTY EXACTLY WHEN `ready`. Every other state has something the caller is
   * not allowed to leave out, and requirement 4's rejecting case is precisely
   * this list being empty under `stale`.
   */
  readonly noticeKeys: readonly string[];
}

/**
 * Classify an {@link IndexState} into what a tool answer must say — total over
 * the union, so a sixth state is a compile error rather than a silent
 * `answered: true` on something nobody classified.
 */
export function narrativeToolIndexReport(state: IndexState): NarrativeToolIndexReport {
  switch (state.state) {
    case 'ready':
      return { state: 'ready', generation: state.generation, answered: true, noticeKeys: [] };
    case 'stale':
      // REQUIREMENT 4. The tool answers — `answered: true` — and the mark is
      // TWO sentences: that the answer may be out of date at all, and WHICH
      // kind of not-fresh it is. Refusing here would make the feature useless
      // during an ordinary watcher failure that can last a whole session;
      // answering silently would make it a liar.
      return {
        state: 'stale',
        generation: state.generation,
        answered: true,
        staleReason: state.staleReason,
        staleSince: state.staleSince,
        noticeKeys: [
          NARRATIVE_TOOL_NOTICE_KEYS.stale,
          indexStaleLocalizationKey(state.staleReason)
        ]
      };
    case 'rebuilding':
      // REQUIREMENT 2. Not an empty answer: an empty answer mid-rebuild is an
      // authoritative absence about an index that has not finished reading.
      return {
        state: 'rebuilding',
        generation: state.generation,
        answered: false,
        noticeKeys: [NARRATIVE_TOOL_NOTICE_KEYS.rebuilding]
      };
    case 'absent':
      // REQUIREMENT 2, second half. The two causes are different statements —
      // "not built yet, ask again after Rebuild Index" and "this workspace is
      // not a manuscript at all" — and collapsing them would send an author
      // hunting for a Rebuild command that is not on screen (WP-5 hides it).
      return {
        state: 'absent',
        generation: state.generation,
        answered: false,
        absentCause: state.cause,
        noticeKeys: [
          state.cause === 'no-manuscript'
            ? NARRATIVE_TOOL_NOTICE_KEYS.noManuscript
            : NARRATIVE_TOOL_NOTICE_KEYS.notBuilt
        ]
      };
    case 'failed':
      // REQUIREMENT 3.
      return {
        state: 'failed',
        generation: state.generation,
        answered: false,
        failureCode: state.reason.code,
        incidentId: state.reason.incidentId,
        noticeKeys: [
          NARRATIVE_TOOL_NOTICE_KEYS.broken,
          indexFailureLocalizationKey(state.reason.code)
        ]
      };
  }
}
