/**
 * The `narrative-memory-query` skill (TASK-022 WP-6).
 *
 * WHAT A "SKILL" IS HERE. It is Theia's own first-class mechanism, not an
 * invention of this package: `@theia/ai-core`'s `DefaultSkillService` walks
 * `.prompts/skills/<slug>/SKILL.md` and `.agents/skills/<slug>/SKILL.md` in
 * every workspace root (plus a configured-directories preference and two
 * default directories), parses the YAML frontmatter into a `SkillDescription`,
 * and surfaces the result in the chat's Skills group and through the
 * `{{skill:<name>}}` / `{{skills}}` prompt variables. There is NO DI
 * contribution point — no `SkillContribution`, no registry a package can bind
 * into — so a skill is a FILE or it does not exist. This module holds its one
 * authored edition; the file on disk is materialized from it, and a test
 * asserts the two have not drifted.
 *
 * WHY THE BODY REPEATS THE FOUR-STATE RULE. The tools already carry it in their
 * answers: every answer says which state the index was in and, when it was not
 * `ready`, why. But a model that has never been told what those fields MEAN will
 * paraphrase `"answered": false` into a confident "there is nothing there",
 * which is the single failure this whole epic exists to remove. The skill is
 * where that reading is stated once, in prose, ahead of any answer.
 *
 * `allowedTools` IS DERIVED FROM {@link NARRATIVE_MEMORY_TOOL_IDS}, never
 * hand-listed. A tool renamed in one place and not the other would leave the
 * skill quietly authorising a tool that no longer exists — and `allowedTools`
 * is an ALLOW list, so the failure is silent in the direction that matters.
 */

import { NARRATIVE_MEMORY_TOOL_IDS } from './narrative-memory-tools';

/** Skill name. Must equal the directory name, and must be kebab-case — both are
 *  enforced by `validateSkillDescription` in `@theia/ai-core`. */
export const NARRATIVE_MEMORY_QUERY_SKILL_NAME = 'narrative-memory-query';

/**
 * Where the skill file lives inside a book.
 *
 * `.prompts/skills` RATHER THAN `.agents/skills`: both are workspace-tier
 * directories, and this repository already scaffolds the first one (the
 * `style-guide` example seed in `book-scaffold.ts`), so a book that has one has
 * the folder already.
 */
export const NARRATIVE_MEMORY_QUERY_SKILL_PATH =
  `.prompts/skills/${NARRATIVE_MEMORY_QUERY_SKILL_NAME}/SKILL.md`;

/**
 * The description the chat's Skills list shows.
 *
 * IN RUSSIAN, and the frontmatter is the one place in this package where a
 * phrase is NOT in the nls catalog — a `SKILL.md` is read off disk by Theia
 * before any localization exists, so there is nowhere to hang a key. Russian
 * because that is this product's primary locale and this string is read by the
 * author in the Skills list; the BODY below is English, matching the
 * `style-guide` seed beside it and the `language: en` sample book it ships in.
 */
export const NARRATIVE_MEMORY_QUERY_SKILL_DESCRIPTION =
  'Как спрашивать индекс рукописи и как читать его ответы — четыре состояния, обоснования и границы';

const SKILL_BODY = `# Querying the narrative index

This book keeps an inspectable index of its own narrative: entity cards,
every reference to them, the relations between them, and the defects found
along the way. Four read-only tools query it. They never write.

## Read the \`index\` block before you read anything else

Every answer opens with an \`index\` block, and \`index.answered\` decides
whether there is anything below it.

- \`"state": "ready"\` — the answer is authoritative. An empty list means the
  manuscript really holds no such thing.
- \`"state": "rebuilding"\` or \`"absent"\` — \`answered\` is \`false\` and the
  answer carries NO data at all. This is not "nothing found". Say the index is
  not ready, and say what would fix it; do not answer from memory.
- \`"state": "failed"\` — the index is broken. \`failureCode\` says how and
  \`incidentId\` ties the answer to a line in the backend log. Report both
  verbatim.
- \`"state": "stale"\` — the index answers, and every answer is marked. Give the
  facts AND say they may be out of date, with \`staleReason\`. Never quietly
  drop the mark: an unmarked stale answer is a confident lie.

The \`notice\` array carries these as sentences. Pass them on.

## Never state a fact you cannot point at

Every entity, mention, relation and finding carries \`evidence\` with a
workspace-relative \`path\`, a \`uri\`, and a \`locator\`:

- \`"locator": "range"\` — the fact is at that exact span. Cite the line.
- \`"locator": "whole-file"\` — the fact was read from a structural YAML field
  or from front matter, and has NO position. Name the file. Do not invent a
  line number; there is none, and the file's first line is not it.

## What these tools do not do

- \`narrative_entity_relations\` returns DIRECT relations only — one hop.
  Storylines, subgraphs and neighbourhoods of depth N are a separate feature and
  are not available here.
- A relation the author wrote into both participants' cards arrives as TWO
  relations, one per card, each with its own evidence. That is not duplication
  to clean up; it is two records of one belief, and either card may be edited
  independently.
- \`narrative_document_context\` returns pointers, never manuscript prose. Read
  the files it names if you need the text.
- By default it withholds chapters positioned after the one you asked about, so
  an answer cannot spoil the book for its own author. Ask for them explicitly if
  the author has asked you to look ahead.
- \`origin\` says who is responsible for a fact: \`explicit\` the author wrote,
  \`derived\` the index computed, \`ai-candidate\` an agent proposed and nobody
  has accepted yet. Never present an \`ai-candidate\` as something the book says.
`;

/**
 * The full `SKILL.md`, frontmatter included.
 *
 * A FUNCTION RATHER THAN A CONSTANT so the `allowedTools` list is built from
 * the tool ids at call time and cannot be captured stale by a bundler that
 * evaluated this module before the ids it depends on.
 */
export function narrativeMemoryQuerySkillFile(): string {
  const allowed = NARRATIVE_MEMORY_TOOL_IDS.map(id => `  - ${id}`).join('\n');
  return [
    '---',
    `name: ${NARRATIVE_MEMORY_QUERY_SKILL_NAME}`,
    // DOUBLE-QUOTED, and `JSON.stringify` is what produces the quoting: JSON is
    // a subset of YAML 1.2, so this is a legal double-quoted scalar with the
    // escapes already right. An unquoted description was the first edition and
    // it was WRONG — the sentence contained a colon, which YAML reads as a
    // nested mapping and `js-yaml` rejects outright. Quoting is the fix for the
    // CLASS; rewording around the colon would have fixed one sentence and left
    // the next author to rediscover it.
    `description: ${JSON.stringify(NARRATIVE_MEMORY_QUERY_SKILL_DESCRIPTION)}`,
    'allowedTools:',
    allowed,
    '---',
    '',
    SKILL_BODY
  ].join('\n');
}
