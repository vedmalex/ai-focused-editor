/**
 * Hard ceiling on how many files one multi-file typography run will touch
 * (TASK-019 W2). A manuscript folder holds tens–hundreds of chapters, not
 * thousands; the cap keeps the dry-run read phase bounded and the confirmation
 * legible. Exceeding it aborts with a warning rather than silently truncating.
 *
 * Lives in `common/typography` (Theia/DOM-free, same convention as
 * `typography-types.ts`) rather than in `browser/typography/typography-commands.ts`
 * so environments that must NOT pull in the browser command file's monaco/DOM
 * import chain — e.g. the i18n placeholder-arity guard's node test lane
 * (QA/F-QA3-4, TASK-020) — can import the constant directly.
 *
 * This module is the ONE canonical import site. `typography-commands.ts` briefly
 * re-exported it "for discoverability" while having no consumer of that
 * re-export; the dead alias was removed (QA/F-QA1-6) rather than left as a
 * second path to the same constant.
 */
export const MULTI_FILE_MAX = 500;
