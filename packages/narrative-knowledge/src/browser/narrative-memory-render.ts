import { nls } from '@theia/core/lib/common/nls';
import {
  NARRATIVE_MEMORY_NLS_PREFIX,
  NARRATIVE_MEMORY_PHRASES,
  type CheckForChangesOutcome,
  type NarrativeIndexStatusReport,
  type NarrativeStatusBarPresentation
} from '../common';

/**
 * Turning WP-5's presentation decisions into strings.
 *
 * SEPARATE FROM THE CONTRIBUTION SO IT IS TESTABLE. Importing anything under
 * `@theia/core/lib/browser` dies at `@lumino/domutils` on module load under
 * `bun`; `@theia/core/lib/common/nls` does not, so a module that only
 * localizes runs in the ordinary `test:packages` lane while the module that
 * touches `StatusBar` and `ProblemManager` does not need a test at all — it has
 * nothing left in it but assignment.
 */

/** Renders one phrase key with no arguments.
 *
 *  KEYS COME FROM A CATALOG, WHICH IS WHY EVERY PHRASE IT RESOLVES IS ARITY 0.
 *  The repository's placeholder-arity guard lexes `nls.localize(` for LITERAL
 *  key and default arguments; through this function it sees neither, so a
 *  translation with a `{0}` behind it could out-run its arguments unchecked.
 *  The ru-bundle test forbids a `{N}` in any catalog phrase for that reason,
 *  and templated phrases are written as literal call sites elsewhere. */
function phrase(key: string, fallback: string): string {
  return nls.localize(key, fallback);
}

/**
 * The English default for every key the catalog declares.
 *
 * BUILT FROM THE CATALOG, never hand-copied. `nls.localize` FALLS BACK to its
 * default argument when a key is missing from the bundle, so a wrong or absent
 * default is not an error — it is a string shipped to the user. A local table
 * of five sentences would be a second edition of the catalog and would rot the
 * first time a phrase was reworded, and the rot would be invisible in ru (where
 * the bundle wins) and visible only in the locale nobody tests.
 */
const DEFAULTS = new Map(NARRATIVE_MEMORY_PHRASES.map(entry => [entry.key, entry.default]));

/**
 * Localize one catalog key.
 *
 * EXPORTED SO WP-6 SHARES IT rather than building a second `DEFAULTS` map. Two
 * maps over the same catalog is the rot this function's own note warns about,
 * one layer up: the second copy would go stale the first time a phrase was
 * reworded, invisibly in ru (where the bundle wins) and visibly only in the
 * locale nobody tests.
 */
export function localizeNarrativeMemoryKey(key: string): string {
  // The `??` arm is unreachable while every key rendered here comes from the
  // catalog, and the ru-bundle test asserts exactly that. It is a leaf name
  // rather than a thrown error on purpose: a missing phrase must degrade to an
  // ugly status bar, never to a frontend that fails to start.
  return phrase(key, DEFAULTS.get(key) ?? key.slice(`${NARRATIVE_MEMORY_NLS_PREFIX}/`.length));
}

const localizeKey = localizeNarrativeMemoryKey;

/** The status bar entry's text, icon included. */
export function statusBarText(presentation: NarrativeStatusBarPresentation): string {
  const headline = localizeKey(presentation.phraseKey);
  const generation =
    presentation.generation === undefined ? '' : ` (${presentation.generation})`;
  return `$(${presentation.icon}) ${headline}${generation}`;
}

/** The status bar entry's tooltip: the headline, then each detail on its own line. */
export function statusBarTooltip(presentation: NarrativeStatusBarPresentation): string {
  return [
    localizeKey(presentation.phraseKey),
    ...presentation.detailKeys.map(localizeKey)
  ].join('\n');
}

/**
 * The body of Show Index Status.
 *
 * `incidentId` IS ITS OWN LINE AND NEVER A SUBSTITUTION INSIDE A PHRASE
 * (ОВ-8). A translator may legitimately reorder a sentence; an identifier the
 * user is about to paste into a bug report may not be reordered, reformatted or
 * translated, and putting it inside a localized string gives away the power to
 * do all three.
 *
 * `relPath` IS PRINTED ONLY IF PRESENT, and its absence is meaningful rather
 * than a rendering gap: ОВ-8 rule 1 DELETES the field when the file lies
 * outside the workspace, because a path outside the workspace is exactly the
 * one that leaks a home directory and a user name.
 */
export function indexStatusReportLines(report: NarrativeIndexStatusReport): string[] {
  const lines = [localizeKey(report.headlineKey)];

  if (report.staleReason !== undefined) {
    lines.push(localizeKey(`${NARRATIVE_MEMORY_NLS_PREFIX}/stale-${report.staleReason}`));
  }
  if (report.failure !== undefined) {
    lines.push(
      localizeKey(`${NARRATIVE_MEMORY_NLS_PREFIX}/index-failure-${report.failure.code}`)
    );
  }

  // A LABEL AND A VALUE JOINED HERE, not a `{0}` inside a phrase. The values
  // below are a number, an ISO timestamp, a path and an opaque id — none of
  // them is a word, none of them is translatable, and none of them may be
  // reordered by a translator (ОВ-8's rule for `incidentId`, applied to its
  // neighbours for the same reason). Keeping the substitution out of the
  // bundle also keeps every catalog phrase arity 0, which is what makes the
  // catalog safe against the placeholder-arity guard's blind spot.
  const field = (leaf: string, value: string | number): string =>
    `${localizeKey(`${NARRATIVE_MEMORY_NLS_PREFIX}/${leaf}`)}: ${value}`;

  lines.push(field('report-generation', report.generation));

  if (report.staleSince !== undefined) {
    lines.push(field('report-stale-since', new Date(report.staleSince).toISOString()));
  }
  if (report.failure?.relPath !== undefined) {
    lines.push(field('report-path', report.failure.relPath));
  }
  if (report.failure !== undefined) {
    lines.push(field('report-occurrences', report.failure.occurrences));
    lines.push(field('report-incident', report.failure.incidentId));
  }
  if (report.rebuildBlockedByForeignWriter) {
    lines.push(localizeKey(`${NARRATIVE_MEMORY_NLS_PREFIX}/report-rebuild-blocked`));
  }
  return lines;
}

/**
 * The lines a "Check for Changes Now" result is shown as (UR-037, UR-038).
 *
 * TWO LINES, NOT ONE, EXACTLY WHEN BOTH FACTS ARE TRUE. UR-038 forbids
 * choosing "the more important" fact when a pass both wrote something and met
 * an unreadable file — `checkForChangesOutcome`'s own doc explains why the two
 * are independent; this is where that independence becomes two lines instead
 * of a single merged sentence.
 *
 * THE UNREADABLE LINE IS A LITERAL `nls.localize` CALL SITE, deliberately NOT
 * routed through {@link localizeKey}. `check-unreadable` carries a `{0}` — the
 * repository's placeholder-arity guard can only see the substitution when both
 * the key and the default are literal arguments at the call site, which is
 * exactly the split `NARRATIVE_MEMORY_TEMPLATED_PHRASES`'s own doc comment
 * requires of every arity>0 phrase in this package.
 */
export function checkForChangesOutcomeLines(outcome: CheckForChangesOutcome): string[] {
  const lines = [
    localizeKey(
      `${NARRATIVE_MEMORY_NLS_PREFIX}/${outcome.resultKind === 'updated' ? 'check-updated' : 'check-no-changes'}`
    )
  ];
  if (outcome.unreadableCount > 0) {
    lines.push(
      nls.localize(
        'ai-focused-editor/narrative-memory/check-unreadable',
        'Checked, but {0} file(s) could not be read',
        outcome.unreadableCount
      )
    );
  }
  return lines;
}
