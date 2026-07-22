#!/usr/bin/env bun
/**
 * Documentation generator (tech_spec §1, §3, §4, §B, §C.5, §C.7, WP-2).
 *
 * Reads `src/browser/docs/content/<lang>/**\/*.md`, emits
 * `src/browser/docs/docs-content.generated.ts` (an IMPLEMENTATION of the
 * `DocsContentProvider` contract, §B.2) plus the committed coverage report
 * `docs/coverage-report.md`, and — the reason this script exists at all —
 * FAILS THE BUILD when the documentation and the product have drifted apart:
 *
 *   - a button pointing at a command that does not exist (fence `command=`),
 *   - a settings link pointing at no preference key (fence `query=`),
 *   - a link to a page that is not in the default set (fence 4, §3),
 *   - a product capability described by no page at all (completeness, §C.7).
 *
 * TWO MODES (§1.3). `--coverage=strict` fails on an uncovered id and on a
 * non-empty exception QUEUE; `--coverage=warn` reports both and exits 0 so
 * content can be written page by page. Everything else fails in BOTH modes: a
 * dangling reference is not incompleteness, it is a defect that is visible in
 * the dev build the content authors look at.
 *
 * A MISSING `--coverage` MEANS STRICT. The scenario being defended against is a
 * future edit of `build` that drops the flag: with a `warn` default that edit
 * silently removes the guarantee the whole task rests on, and no test sees it.
 *
 * RUN WITH `bun` (§1.2): it imports `directive-core.ts` and `source-scan.ts`
 * from TypeScript SOURCE, because `tsc` runs LATER in the chain
 * (`docs:inventory` → `docs:gen` → `tsc`) and `lib/` does not exist yet.
 *
 * NO SECOND PARSER, NO SECOND TRAVERSAL. Directives come from
 * `scanDirectives` (WP-A) and the freshness hash from `computeSourceFingerprint`
 * (WP-A); this file owns the POLICY over them, never a copy of them.
 */

import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import { scanDirectives } from '../src/common/docs/directive-core.ts';
import { DOCS_LANGS, sortDocsManifestEntries } from '../src/common/docs/docs-lang.ts';
import { DEFAULT_DOCS_LANG } from '../src/common/docs/docs-contract.ts';
import { computeSourceFingerprint } from '../src/node/docs/source-scan.ts';

// --------------------------------------------------------------------------
// Paths and constants (§1.0 — `packages/`, `apps/`, `docs/` are repo-relative)
// --------------------------------------------------------------------------

const PACKAGE_RELATIVE_PATH = 'packages/manuscript-workspace';
const INVENTORY_RELATIVE_PATH = `${PACKAGE_RELATIVE_PATH}/docs-inventory.generated.json`;
const CONTENT_RELATIVE_PATH = `${PACKAGE_RELATIVE_PATH}/src/browser/docs/content`;
const MODULE_RELATIVE_PATH = `${PACKAGE_RELATIVE_PATH}/src/browser/docs/docs-content.generated.ts`;
const ALLOWLIST_RELATIVE_PATH = 'docs/coverage-exceptions.jsonc';
const QUEUE_RELATIVE_PATH = 'docs/coverage-exceptions.requests.jsonc';
const REPORT_RELATIVE_PATH = 'docs/coverage-report.md';

/**
 * Glob absorption ceiling N (§2a п.3, default 8, configurable per F-D4-12).
 * Raising it via `--glob-ceiling` is meant to be visible in the build command
 * and argued for in review — that is the whole point of the number.
 */
const DEFAULT_GLOB_CEILING = 8;

/**
 * The closed set of exception kinds (§B.5).
 *
 * `deferred` (added for the six pages carried over into TASK-010) is NOT a
 * synonym of `exempt` and the difference is the whole reason it exists:
 *
 * - `exempt` asserts the id is NOT A USER-FACING SURFACE — nobody will ever
 *   describe it, because there is nothing for a reader to do with it. Its
 *   `reason` has to make that case (§2a/F-D2-2), and "not documented yet" is
 *   precisely the sentence the discipline was built to refuse.
 * - `deferred` asserts the opposite: the id IS a real user-facing surface, it
 *   WILL be described, and the page that will describe it is simply not written
 *   yet. It therefore carries `deferredTo` — the task that owes the page — and
 *   an empty value is a build failure, because without a task reference the
 *   entry is an open-ended excuse rather than a scheduled debt.
 *
 * Both share a subject (the inventory) for the stale detector and both keep an
 * uncovered id out of the strict failure list. What differs is what the report
 * says about them: a `deferred` unit is counted on its OWN summary row and
 * listed with its task in its OWN section, so nobody can mistake it for
 * documentation that exists.
 */
const EXCEPTION_KINDS = new Set(['external', 'dynamic', 'exempt', 'deferred']);
const KIND_LIST = [...EXCEPTION_KINDS].join('|');
const USED_BY_VALUES = new Set(['content', 'code']);
const EXCEPTION_FIELDS = new Set(['pattern', 'kind', 'reason', 'usedBy', 'deferredTo', 'added']);

/**
 * Shape of the task id in `deferredTo` (§B.5.2).
 *
 * WHY A FORMAT CHECK AND NOT A LIVENESS CHECK. The stronger rule — "the owner
 * task must exist AND still be open" — was considered and REJECTED, on one
 * decisive fact rather than on taste: the task registry lives in `memory-bank/`,
 * which is GITIGNORED and has zero tracked files in this repository. It is a
 * local workflow store, not a source artifact.
 *
 * That makes a liveness check unimplementable without a worse defect than the
 * one it fixes. In a fresh clone or in CI — the environments that actually gate
 * a release — `memory-bank/` is simply ABSENT, leaving two options, both bad:
 *
 *   - fail the build when the registry is missing: `docs:strict`, and therefore
 *     `build`, stops working for every consumer who is not this workstation;
 *   - skip the check when the registry is missing: the rule then evaporates in
 *     exactly the environment that gates releases, while still reading like a
 *     guarantee in the source. A check that degrades to nothing where it counts
 *     is worse than no check, because it stops anyone from looking for a real one.
 *
 * It would also make the build NON-HERMETIC: the same source tree would build
 * green or red depending on local workflow state, and the failure would surface
 * at a moment unrelated to the change being built.
 *
 * So the mechanism enforces what is checkable from the source tree alone — that
 * the owner is NAMED and RESOLVABLE — and the liveness half is carried by an
 * explicit process rule (§B.5.2: closing a task requires adjudicating every
 * `deferred` entry that names it) plus the per-unit visibility of the committed
 * `## Deferred coverage` report section, which lists all 18 units by name.
 *
 * This is an HONEST WEAKENING, recorded as such: the residual hole is that a
 * closed TASK-010 leaves its entries green. The report makes that hole visible
 * to a human; nothing in this script makes it loud. Do not read this comment as
 * a claim that the hole is closed.
 */
const DEFERRED_TO_PATTERN = /^TASK-\d+$/;
const REQUEST_FIELDS = new Set([...EXCEPTION_FIELDS, 'requestedBy']);
const FRONTMATTER_FIELDS = new Set(['title', 'order', 'section', 'covers']);

/** Configuration/environment failure — exit 2, distinct from a rule violation. */
class ConfigError extends Error {}

/**
 * Accumulated rule violations — exit 1.
 *
 * COLLECTED, not thrown one at a time: an author fixing a page should see every
 * problem of that page in one run, the same reason `scanDirectives` collects
 * instead of stopping at the first finding.
 */
class Problems {
  constructor() {
    this.messages = [];
  }

  add(message) {
    this.messages.push(`docs-gen: ${message}`);
  }

  get empty() {
    return this.messages.length === 0;
  }

  /** Abort now if anything was collected — later stages assume earlier ones held. */
  checkpoint() {
    if (!this.empty) {
      throw new RuleFailure(this.messages);
    }
  }
}

class RuleFailure extends Error {
  constructor(messages) {
    super(messages.join('\n'));
    this.messages = messages;
  }
}

// --------------------------------------------------------------------------
// Small shared predicates
// --------------------------------------------------------------------------

/**
 * §B.3 glob semantics: `*` is legal only as the LAST character and matches a
 * NON-EMPTY suffix. Everything else is an exact comparison.
 *
 * This is the matching rule used against the INVENTORY and against directive
 * values. The `kind:"dynamic"` staleness subject uses a DIFFERENT relation —
 * see {@link matchesDynamicSubject} and the note there (F-D8-1).
 */
function patternMatches(pattern, value) {
  if (!pattern.endsWith('*')) {
    return value === pattern;
  }
  const prefix = pattern.slice(0, -1);
  return value.length > prefix.length && value.startsWith(prefix);
}

/** A `query=` value satisfies a key when it is a prefix ON A SEGMENT BOUNDARY (§C.5). */
function isSegmentPrefix(query, key) {
  return key === query || key.startsWith(`${query}.`);
}

/** First dot-separated segment plus its dot — `aiFocusedEditor.x.y` → `aiFocusedEditor.`. */
function firstSegmentPrefix(key) {
  const dot = key.indexOf('.');
  return dot < 0 ? `${key}.` : `${key.slice(0, dot + 1)}`;
}

function byText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique(values) {
  return [...new Set(values)];
}

function posixPath(value) {
  return value.split(sep).join('/');
}

// --------------------------------------------------------------------------
// Inventory (§B.4, §1.5, §C.7)
// --------------------------------------------------------------------------

/**
 * Strip an algorithm prefix so the two producers can be compared at all.
 *
 * The extractor writes `sha256:<hex>` (§B.4) while `computeSourceFingerprint`
 * returns bare hex (§1.5). Comparing the two raw strings would make the
 * freshness check fail on EVERY run — a permanently dead build that looks like
 * a stale inventory. Normalising both sides is the fix; keeping the prefix in
 * the artifact is right, because it says which hash it is.
 */
function normalizeFingerprint(value) {
  return typeof value === 'string' && value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
}

async function loadInventory(repoRoot) {
  const inventoryPath = join(repoRoot, INVENTORY_RELATIVE_PATH);
  let text;
  try {
    text = await fs.readFile(inventoryPath, 'utf8');
  } catch {
    throw new ConfigError('docs-gen: inventory missing — run "bun run docs:inventory" first');
  }
  let inventory;
  try {
    inventory = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`docs-gen: inventory is not valid JSON (${error.message}) — re-run docs:inventory`);
  }
  if (inventory?.version !== 1) {
    throw new ConfigError(
      `docs-gen: inventory version ${JSON.stringify(inventory?.version)} is not supported (expected 1) — re-run docs:inventory`
    );
  }
  const actual = await computeSourceFingerprint(repoRoot);
  if (normalizeFingerprint(inventory.sourceFingerprint) !== normalizeFingerprint(actual)) {
    throw new ConfigError(
      'docs-gen: inventory is stale (source fingerprint mismatch) — re-run docs:inventory'
    );
  }
  return inventory;
}

/**
 * The coverage universe (§C.7), DEDUPLICATED BY ID.
 *
 * §C.7 defines `INV` as a SET of ids but sizes it as
 * `commands.length + preferences.length`. Those two are NOT the same number:
 * `commands[]` holds one entry per DECLARATION SITE, and the current tree has
 * 173 entries for 167 distinct ids (a command declared in two places, e.g. a
 * palette entry and a toolbar entry, appears twice). Sizing the universe by
 * entry count would make the §B.6 accounting invariant — the sum of the buckets
 * equals the inventory size — unsatisfiable, since every bucket counts UNITS.
 * The build would then die on `coverage accounting mismatch` no matter what the
 * content said.
 *
 * The rule this file implements is therefore explicit: ONE CAPABILITY IS ONE
 * UNIT OF COVERAGE, no matter how many places declare it. Documenting a command
 * once covers it once.
 */
function buildInventoryModel(inventory) {
  const commandIds = unique((inventory.commands ?? []).map(command => command.id)).sort(byText);
  const preferenceKeys = unique((inventory.preferences ?? []).map(preference => preference.key)).sort(
    byText
  );
  const units = [...commandIds, ...preferenceKeys];
  const unitSet = new Set(units);
  if (unitSet.size !== units.length) {
    // Structurally impossible today (commands are kebab-case, preference keys
    // camelCase — §C.3), but if it ever happened the two report rows would
    // over-count the universe and the invariant would fail with a misleading
    // message. Say what actually happened instead.
    throw new ConfigError(
      'docs-gen: an id is both a command and a preference key — the inventory universe is not a disjoint union'
    );
  }
  return {
    commandIds,
    commandIdSet: new Set(commandIds),
    preferenceKeys,
    preferenceKeySet: new Set(preferenceKeys),
    units,
    unitSet,
    dynamicPrefixes: inventory.dynamicPrefixes ?? [],
    codeReferencedIds: inventory.codeReferencedIds ?? [],
    namespaces: inventory.namespaces ?? [],
    skipped: inventory.skipped ?? []
  };
}

/**
 * `OWN_PREFIXES` (§4.1.1) — DERIVED FROM THE ACTUAL INVENTORY, never hardcoded.
 *
 * Commands and preferences use DIFFERENT notations (`ai-focused-editor.` vs
 * `aiFocusedEditor.`, §C.3). Taking only the command namespaces would let
 * `{pattern:"aiFocusedEditor.wellcome", kind:"external"}` — a typo for
 * `welcome` — silence the `query=` fence for one of OUR OWN keys, which is the
 * exact defect the fence exists to catch.
 */
function ownPrefixes(model) {
  return unique([
    ...model.namespaces,
    ...model.preferenceKeys.map(firstSegmentPrefix)
  ]).sort(byText);
}

// --------------------------------------------------------------------------
// Allowlist and request queue (§B.5, §4.1)
// --------------------------------------------------------------------------

function readJsoncOrThrow(text, relativePath) {
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    throw new ConfigError(
      `docs-gen: ${relativePath} is not valid JSONC (${printParseErrorCode(first.error)} at offset ${first.offset})`
    );
  }
  return value;
}

/**
 * Load and validate one exception file. The allowlist (`docs/coverage-exceptions.jsonc`)
 * and the request queue (`docs/coverage-exceptions.requests.jsonc`) share EVERY
 * field rule — `kind`, `reason`, `usedBy`, `added`, the `OWN_PREFIXES` limit
 * (§4.1.1, F-D8-6). A rule enforced on one file only is a route around it: an
 * entry can simply be written in the other file.
 *
 * An absent file is an EMPTY set, not an error: a repository with nothing to
 * exempt and nothing pending is a legitimate state, and the queue is empty by
 * definition right after adjudication.
 */
async function loadExceptions(repoRoot, relativePath, { isQueue }, model, problems) {
  const absolutePath = join(repoRoot, relativePath);
  let text;
  try {
    text = await fs.readFile(absolutePath, 'utf8');
  } catch {
    return [];
  }
  const document = readJsoncOrThrow(text, relativePath);
  const listKey = isQueue ? 'requests' : 'exceptions';
  const raw = document?.[listKey];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError(`docs-gen: ${relativePath} must hold an array under "${listKey}"`);
  }

  const prefixes = ownPrefixes(model);
  const allowedFields = isQueue ? REQUEST_FIELDS : EXCEPTION_FIELDS;
  const entries = [];
  for (const [index, entry] of raw.entries()) {
    const where = `${relativePath}[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.add(`${where} is not an object`);
      continue;
    }
    const pattern = entry.pattern;
    if (typeof pattern !== 'string' || pattern.length === 0) {
      problems.add(`${where} needs a non-empty "pattern"`);
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (!allowedFields.has(field)) {
        problems.add(`unknown field "${field}" for "${pattern}" in ${relativePath}`);
      }
    }
    const starIndex = pattern.indexOf('*');
    if (starIndex >= 0 && starIndex !== pattern.length - 1) {
      problems.add(`'*' is only allowed as the last character of pattern "${pattern}" in ${relativePath}`);
    }
    const kind = entry.kind;
    if (typeof kind !== 'string' || !EXCEPTION_KINDS.has(kind)) {
      problems.add(
        isQueue
          ? `invalid request kind ${JSON.stringify(kind)} (expected ${KIND_LIST})`
          : `invalid exception kind ${JSON.stringify(kind)} (expected ${KIND_LIST}) in ${relativePath}`
      );
      continue;
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      problems.add(`entry "${pattern}" needs a non-empty reason in ${relativePath}`);
    }
    if (entry.usedBy !== undefined) {
      if (typeof entry.usedBy !== 'string' || !USED_BY_VALUES.has(entry.usedBy)) {
        problems.add(
          `invalid usedBy ${JSON.stringify(entry.usedBy)} (expected content|code) for "${pattern}" in ${relativePath}`
        );
      } else if (kind !== 'external') {
        problems.add(
          `usedBy is only valid with kind:"external" — "${pattern}" is kind:"${kind}" in ${relativePath}`
        );
      }
    }
    // `deferredTo` — the TEETH of `kind:"deferred"` (§B.5).
    //
    // A deferred entry says "this surface will be described, elsewhere, later".
    // Without a named owner that sentence has no second half: nothing ever
    // becomes due, nothing is ever reviewed, and the entry silently turns into
    // the permanent exemption its `kind` was introduced to avoid. So the field
    // is MANDATORY and a blank/whitespace value is a build failure — the same
    // shape of rule as the non-empty `reason` above, for the same reason.
    //
    // Symmetrically it is REFUSED on every other kind (as `usedBy` is refused
    // outside `external`): a task reference on an `exempt` entry would read as
    // a deferral while being counted as a permanent exemption.
    if (kind === 'deferred') {
      if (typeof entry.deferredTo !== 'string' || entry.deferredTo.trim().length === 0) {
        problems.add(
          `kind:"deferred" entry "${pattern}" needs a non-empty deferredTo naming the task that owes the page` +
            ` in ${relativePath}`
        );
      } else if (!DEFERRED_TO_PATTERN.test(entry.deferredTo.trim())) {
        // The owner must be a RESOLVABLE task id, not prose. Free text
        // ("later", "the diagrams epic") names no one: it cannot be looked up,
        // so the promise it encodes can never be checked by a human either.
        //
        // NOTE ON THE LIMIT OF THIS RULE (deliberate, see §B.5.2): this is a
        // FORMAT check, not a LIVENESS check. It cannot tell whether TASK-010
        // exists, is open, or was closed without writing the pages it owes.
        // Liveness is deliberately NOT checked here — see the block comment on
        // DEFERRED_TO_PATTERN for why that check does not belong in this script.
        problems.add(
          `invalid deferredTo ${JSON.stringify(entry.deferredTo)} for "${pattern}" in ${relativePath}` +
            ` — expected a task id of the form TASK-123 (the owner must be resolvable, not prose)`
        );
      }
    } else if (entry.deferredTo !== undefined) {
      problems.add(
        `deferredTo is only valid with kind:"deferred" — "${pattern}" is kind:"${kind}" in ${relativePath}`
      );
    }
    if (entry.added !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.added))) {
      problems.add(
        `invalid added ${JSON.stringify(entry.added)} (expected YYYY-MM-DD) for "${pattern}" in ${relativePath}`
      );
    }
    if (isQueue && (typeof entry.requestedBy !== 'string' || entry.requestedBy.length === 0)) {
      problems.add(`request "${pattern}" needs a non-empty requestedBy in ${relativePath}`);
    }
    if (kind === 'external') {
      const truncated = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      const own = prefixes.find(
        prefix =>
          truncated.startsWith(prefix) || (pattern.endsWith('*') && prefix.startsWith(truncated))
      );
      if (own !== undefined) {
        problems.add(
          `kind:"external" pattern "${pattern}" targets an OWN prefix (${own}) — own ids must be covered by a page, exempted, or marked dynamic`
        );
      }
    }
    entries.push({
      pattern,
      kind,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      usedBy: kind === 'external' ? entry.usedBy ?? 'content' : undefined,
      deferredTo: kind === 'deferred' && typeof entry.deferredTo === 'string' ? entry.deferredTo.trim() : undefined,
      source: relativePath
    });
  }
  return entries;
}

// --------------------------------------------------------------------------
// Pages (§B.3)
// --------------------------------------------------------------------------

async function listMarkdownFiles(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(absolutePath);
    }
  }
  return files.sort(byText);
}

/** Split `---\n…\n---\n` off the head of a page, keeping the body byte-exact. */
function splitFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return undefined;
  }
  const firstBreak = text.indexOf('\n');
  const rest = text.slice(firstBreak + 1);
  const terminator = rest.search(/^---[ \t]*(\r?\n|$)/m);
  if (terminator < 0) {
    return undefined;
  }
  const yamlText = rest.slice(0, terminator);
  const afterTerminator = rest.slice(terminator);
  const terminatorEnd = afterTerminator.indexOf('\n');
  const body = terminatorEnd < 0 ? '' : afterTerminator.slice(terminatorEnd + 1);
  const consumed = text.length - body.length;
  const lineOffset = text.slice(0, consumed).split('\n').length - 1;
  return { yamlText, body, lineOffset };
}

/**
 * Validate `covers` (§B.3, discipline of §2a/F-D2-1) and return the claims.
 *
 * A BARE STRING GLOB is rejected rather than accepted-with-a-shrug: the object
 * form exists so absorption always carries a written justification, and a
 * string that happens to end in `*` would be the one way to get absorption for
 * free.
 */
function validateCovers(covers, page, model, ceiling, problems) {
  if (covers === undefined) {
    return [];
  }
  if (!Array.isArray(covers)) {
    problems.add(`frontmatter key "covers" must be a list in ${page.file}`);
    return [];
  }
  const claims = [];
  for (const claim of covers) {
    if (typeof claim === 'string') {
      if (claim.includes('*')) {
        problems.add(`bare glob "${claim}" in covers at ${page.file} — use { pattern, reason }`);
        continue;
      }
      if (!model.unitSet.has(claim)) {
        problems.add(`covers id "${claim}" is not in the inventory at ${page.file}`);
        continue;
      }
      claims.push(claim);
      continue;
    }
    if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) {
      problems.add(`covers entry must be a string or { pattern, reason } in ${page.file}`);
      continue;
    }
    for (const field of Object.keys(claim)) {
      if (field !== 'pattern' && field !== 'reason') {
        problems.add(`unknown covers field "${field}" in ${page.file}`);
      }
    }
    const pattern = claim.pattern;
    if (typeof pattern !== 'string' || pattern.length === 0) {
      problems.add(`covers entry needs a non-empty "pattern" in ${page.file}`);
      continue;
    }
    if (typeof claim.reason !== 'string' || claim.reason.trim().length === 0) {
      problems.add(`covers glob "${pattern}" needs a non-empty reason at ${page.file}`);
    }
    const starIndex = pattern.indexOf('*');
    if (starIndex >= 0 && starIndex !== pattern.length - 1) {
      problems.add(
        `'*' is only allowed as the last character of covers pattern "${pattern}" at ${page.file}`
      );
      continue;
    }
    if (starIndex < 0) {
      if (!model.unitSet.has(pattern)) {
        problems.add(`covers id "${pattern}" is not in the inventory at ${page.file}`);
        continue;
      }
      claims.push({ pattern, reason: claim.reason });
      continue;
    }
    // RAW matches, not the post-priority bucket (§C.7 / F-D6-4): a wide glob
    // whose ids happen to be listed exactly elsewhere still absorbs them, and
    // the ceiling is about what the pattern SWALLOWS.
    const matches = model.units.filter(unit => patternMatches(pattern, unit));
    if (matches.length === 0) {
      problems.add(
        `stale covers glob "${pattern}" matches nothing in the inventory at ${page.file} — remove it`
      );
      continue;
    }
    if (matches.length > ceiling) {
      problems.add(
        `covers glob "${pattern}" matches ${matches.length} ids, above the ceiling N=${ceiling}, at ${page.file} — split it into exact ids or separate pages`
      );
      continue;
    }
    claims.push({ pattern, reason: claim.reason });
  }
  return claims;
}

/**
 * Read every page of every language, validate its frontmatter and scan its
 * directives.
 *
 * THE BUILD-TIME POLICY OVER `scanDirectives` IS `diagnostics.length > 0`, not
 * "errors only" (§A.4). Three of the seven rows of the asymmetry table — an
 * unknown attribute, a malformed `icon`, a markdown metacharacter in a label —
 * come back as `ok: true` WITH warnings, because the RUNTIME must keep
 * rendering a degraded directive. Checking only the fatal channel would leave
 * those three rules unimplemented while looking implemented.
 */
async function loadPages(repoRoot, model, ceiling, problems) {
  const pages = [];
  for (const lang of DOCS_LANGS) {
    const languageRoot = join(repoRoot, CONTENT_RELATIVE_PATH, lang);
    for (const absolutePath of await listMarkdownFiles(languageRoot)) {
      const file = posixPath(join(CONTENT_RELATIVE_PATH, lang, absolutePath.slice(languageRoot.length + 1)));
      const id = posixPath(absolutePath.slice(languageRoot.length + 1)).replace(/\.md$/, '');
      const text = await fs.readFile(absolutePath, 'utf8');
      const split = splitFrontmatter(text);
      if (!split) {
        problems.add(`${file} has no frontmatter — expected '---' on the first line and a closing '---'`);
        continue;
      }
      let front;
      try {
        front = parseYaml(split.yamlText) ?? {};
      } catch (error) {
        problems.add(`invalid frontmatter YAML in ${file}: ${error.message}`);
        continue;
      }
      if (typeof front !== 'object' || front === null || Array.isArray(front)) {
        problems.add(`frontmatter of ${file} must be a mapping`);
        continue;
      }
      for (const key of Object.keys(front)) {
        if (!FRONTMATTER_FIELDS.has(key)) {
          problems.add(`unknown frontmatter key "${key}" in ${file}`);
        }
      }
      const page = { id, lang, file, markdown: split.body };
      if (typeof front.title !== 'string' || front.title.trim().length === 0) {
        problems.add(`frontmatter key "title" must be a non-empty string in ${file}`);
      } else {
        page.title = front.title;
      }
      if (typeof front.order !== 'number' || !Number.isInteger(front.order) || front.order < 0) {
        problems.add(`frontmatter key "order" must be an integer >= 0 in ${file}`);
      } else {
        page.order = front.order;
      }
      if (front.section !== undefined) {
        if (typeof front.section !== 'string' || front.section.trim().length === 0) {
          problems.add(`frontmatter key "section" must be a non-empty string in ${file}`);
        } else {
          page.section = front.section;
        }
      }
      page.covers = validateCovers(front.covers, page, model, ceiling, problems);

      const scan = scanDirectives(split.body);
      for (const diagnostic of scan.diagnostics) {
        problems.add(
          `${diagnostic.message} at ${file}:${diagnostic.position.line + split.lineOffset}:${diagnostic.position.column}`
        );
      }
      page.directives = scan.directives.map(directive => ({
        ...directive,
        line: lineOf(split.body, directive.start) + split.lineOffset,
        column: columnOf(split.body, directive.start)
      }));
      pages.push(page);
    }
  }
  return pages;
}

function lineOf(source, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index++) {
    if (source.charCodeAt(index) === 10) {
      line++;
    }
  }
  return line;
}

function columnOf(source, offset) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return offset - lineStart + 1;
}

// --------------------------------------------------------------------------
// Fences (§C.5, §3, §A.7)
// --------------------------------------------------------------------------

/**
 * The three reference fences plus the placement rule, applied to EVERY page of
 * EVERY language — all of them fail in BOTH modes.
 *
 * `warn` softens exactly one thing: COMPLETENESS, which is incomplete by
 * construction while the content is being written. A button wired to a command
 * that does not exist is not incompleteness; it is a dead affordance in the
 * dev build the prototype gate looks at with human eyes.
 *
 * QUEUE_OK (§4.4): in `warn` a pending request with `kind` `external` or
 * `dynamic` also satisfies a fence, so a content author is not deadlocked
 * waiting for adjudication. It can never reach a release because §4.3 refuses
 * to build `strict` at all while the queue is non-empty — the loosening reuses
 * an existing lock instead of adding a hole.
 *
 * BOTH FENCES TREAT THE QUEUE THE SAME WAY (F-D8-3). §C.5 mentioned
 * `kind:"dynamic"` for `command=` and not for `query=`, while §4.4 states the
 * rule once for both fences as `inventory ∪ ALLOW [∪ QUEUE_OK]`. The asymmetry
 * reads as an editing slip rather than a decision — a dynamically-registered
 * preference family would otherwise have no route at all — so the general
 * formula wins and the fences are symmetric.
 */
function checkFences(pages, model, allowlist, queue, mode, problems) {
  const defaultPageIds = new Set(pages.filter(page => page.lang === DEFAULT_DOCS_LANG).map(page => page.id));
  const queueOk = queue.filter(entry => entry.kind === 'external' || entry.kind === 'dynamic');
  const usesQueue = mode === 'warn';
  const passedViaQueue = new Set();

  const satisfiedByExceptions = value => {
    if (allowlist.some(entry => patternMatches(entry.pattern, value))) {
      return true;
    }
    if (usesQueue && queueOk.some(entry => patternMatches(entry.pattern, value))) {
      passedViaQueue.add(value);
      return true;
    }
    return false;
  };

  for (const page of pages) {
    for (const directive of page.directives) {
      const at = `${page.file}:${directive.line}:${directive.column}`;
      if (directive.name === 'action') {
        // MEMBERSHIP IN `commands[]`, NOT `kind === "command"` — decided, not
        // overlooked (ISS-096 rider). `kind` is a SYNTACTIC guess: §C.2 branch 3
        // only recognises a literal registered by identifier IN THE SAME FILE,
        // and the current tree has 44 `kind:"unclassified"` entries that are a
        // MIX — menu/toolbar paths (`…chapter-context`, `…preview.toolbar`) next
        // to genuine commands registered across files
        // (`ai-focused-editor.proofreading.proofreadSelection`,
        // `ai-focused-editor.transcript.playPause`). Narrowing the fence to
        // `kind:"command"` would turn a NAMED extraction limit into a content
        // blocker: the author of the proofreading page could not link the very
        // command the page is about. The cost of the opposite mistake is small
        // and already handled — a menu id survives the fence, then line 1 of the
        // no-dead-buttons contract (§D.5) renders it `disabled` with a tooltip.
        // A wrong build failure is worse than a visibly disabled button.
        const command = directive.attributes.command;
        if (!model.commandIdSet.has(command) && !satisfiedByExceptions(command)) {
          problems.add(
            `unknown command "${command}" in :action at ${at} — not in the inventory, not in ${ALLOWLIST_RELATIVE_PATH}`
          );
        }
      } else if (directive.name === 'settings') {
        const query = directive.attributes.query;
        const matchesKey = model.preferenceKeys.some(key => isSegmentPrefix(query, key));
        if (!matchesKey && !satisfiedByExceptions(query)) {
          problems.add(
            `unknown settings query "${query}" in :settings at ${at} — not a segment-boundary prefix of any preference key, not in ${ALLOWLIST_RELATIVE_PATH}`
          );
        }
      } else if (directive.name === 'doc' || directive.name === 'scenario') {
        const target = directive.attributes.page;
        if (!defaultPageIds.has(target)) {
          problems.add(
            `directive :${directive.name}{page="${target}"} at ${page.file}:${directive.line} targets a page missing from content/${DEFAULT_DOCS_LANG}`
          );
        }
      }
      if (directive.name === 'scenario' && page.id !== 'home') {
        problems.add(
          `:::scenario is only allowed on the guide root page (home) at ${page.file}:${directive.line}`
        );
      }
    }
  }

  // Fence 4a — completeness of the default set (§3).
  for (const page of pages) {
    if (page.lang !== DEFAULT_DOCS_LANG && !defaultPageIds.has(page.id)) {
      problems.add(
        `page "${page.id}" exists in content/${page.lang} but is missing from the default set content/${DEFAULT_DOCS_LANG}`
      );
    }
  }

  return { passedViaQueue: passedViaQueue.size };
}

// --------------------------------------------------------------------------
// Staleness of exceptions (§B.5.1, F-D8-1)
// --------------------------------------------------------------------------

/**
 * The `kind:"dynamic"` subject relation — DELIBERATELY NOT §B.3 matching.
 *
 * The subject is `dynamicPrefixes[]`, whose single real element is
 * `ai-focused-editor.mode.run.` — a PREFIX, not an id. Under §B.3 the shipped
 * entry `ai-focused-editor.mode.run.*` requires a NON-EMPTY suffix and so would
 * not match that prefix, making the very first allowlist entry stale and the
 * group-D build command dead on arrival (F-D8-1). For subject comparison the
 * trailing `*` is therefore DROPPED and the entry is alive when the subject
 * holds an element equal to, or extending, the truncated pattern. §B.3 is
 * untouched — it stays the rule for matching against the INVENTORY.
 */
function matchesDynamicSubject(pattern, subject) {
  const truncated = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
  return subject.some(element => element === truncated || element.startsWith(truncated));
}

/**
 * Each `kind` is checked against the subject where its referent actually lives
 * (§B.5.1). One universal subject (`INV`) would declare all three shipped
 * entries stale: a dynamic family is in `skipped[]` by construction, and the
 * two foreign settings commands are called FROM CODE and never appear as a
 * directive value. No branch disables the detector — each redirects it.
 */
function checkStaleExceptions(allowlist, model, contentValues, defaultSetIsEmpty, problems) {
  const stats = new Map();
  for (const entry of allowlist) {
    let subject;
    let matches;
    if (entry.kind === 'exempt' || entry.kind === 'deferred') {
      // THE SAME SUBJECT for both, because the referent is the same thing: an
      // id of OUR OWN inventory. A `deferred` entry whose command has been
      // deleted from the product is exactly as stale as an `exempt` one — the
      // page TASK-010 owes would describe a button that no longer exists — and
      // the detector has to say so instead of letting the row sit in the report
      // forever. This is the one property `deferred` deliberately INHERITS from
      // `exempt`; everything the report does with it differs (see the summary
      // row and the `## Deferred coverage` section).
      subject = 'the inventory';
      matches = model.units.filter(unit => patternMatches(entry.pattern, unit));
    } else if (entry.kind === 'dynamic') {
      subject = 'dynamicPrefixes[]';
      matches = matchesDynamicSubject(entry.pattern, model.dynamicPrefixes)
        ? model.dynamicPrefixes.filter(
            prefix =>
              prefix === (entry.pattern.endsWith('*') ? entry.pattern.slice(0, -1) : entry.pattern) ||
              prefix.startsWith(entry.pattern.endsWith('*') ? entry.pattern.slice(0, -1) : entry.pattern)
          )
        : [];
    } else if (entry.usedBy === 'code') {
      subject = 'codeReferencedIds[]';
      matches = model.codeReferencedIds.filter(id => patternMatches(entry.pattern, id));
    } else {
      subject = 'the directive values of the content';
      matches = [...contentValues].filter(value => patternMatches(entry.pattern, value));
      if (defaultSetIsEmpty) {
        // The subject does not exist yet — the content branch of the detector
        // switches on with the first page, exactly as §B.5.1 says.
        stats.set(entry, matches.length);
        continue;
      }
    }
    if (matches.length === 0) {
      problems.add(
        `stale exception "${entry.pattern}" (kind=${entry.kind}) matches nothing in ${subject} — remove it`
      );
    }
    stats.set(entry, matches.length);
  }
  return stats;
}

// --------------------------------------------------------------------------
// Coverage function (§C.7)
// --------------------------------------------------------------------------

/**
 * Which of the four sources covers each unit, and by which one it is COUNTED.
 *
 * A unit is counted EXACTLY ONCE, by the lowest applicable source number, so
 * the report rows sum to the size of the universe (§B.6). The priority affects
 * only the report: every CHECK (the ceiling, both staleness detectors) works on
 * RAW match sets, or a wide glob plus a few exact `covers` would slip past the
 * ceiling (§C.7 / F-D6-4).
 *
 * SOURCE 3 COVERS ONLY WHAT IT NAMES (ISS-096, §C.7 revised).
 *
 * The rule used to be "`:settings{query=Q}` covers every preference key Q is a
 * segment-boundary prefix of", justified by the claim that an occurrence covers
 * EXACTLY ONE unit and therefore needs no ceiling. For `:action{command=…}`
 * that claim is true — the fence demands an exact inventory id. For `query=` it
 * was false, and the prototype measured the size of the hole: two buttons,
 * `query="aiConnect"` and `query="mediaTranscription"`, silently reported 18
 * preference keys as documented on a page that mentions none of them by name.
 *
 * Three properties of the old rule made it the wrong repair target:
 *   1. the credit is UNBOUNDED — one button pays for a whole namespace;
 *   2. the credit is INVISIBLE at authoring time — the count is a property of
 *      the product, not of the page, so the author never sees the number;
 *   3. worst, the credit is RETROACTIVE — a preference key added to the product
 *      tomorrow arrives already "documented", which is precisely the signal the
 *      completeness fence exists to raise.
 *
 * A ceiling (the alternative considered: at most N keys per occurrence) fixes
 * only (1). It leaves a new key silently absorbed while a namespace stays under
 * N, and it turns a legitimate "open the transcription settings" button into a
 * BUILD FAILURE the day the eighth key lands — punishing the affordance for the
 * product's growth. So the fix is the narrow one: an occurrence covers the unit
 * it NAMES. A prefix query stays perfectly legal — the fence (§C.5) is
 * untouched, the button renders and works — it simply does not pay for
 * documentation. What the author gets back is `covers`, which is explicit,
 * reviewed, and stale-checked.
 *
 * The two directives are now symmetric and the original justification is true
 * rather than aspirational: ONE OCCURRENCE COVERS AT MOST ONE UNIT, so no
 * ceiling is needed on this source.
 */
function computeCoverage(pages, model, allowlist) {
  const defaultPages = pages.filter(page => page.lang === DEFAULT_DOCS_LANG);

  const exact = new Map();
  const glob = new Map();
  const globAbsorption = [];
  for (const page of defaultPages) {
    for (const claim of page.covers) {
      if (typeof claim === 'string') {
        if (!exact.has(claim)) {
          exact.set(claim, page.id);
        }
        continue;
      }
      const matches = model.units.filter(unit => patternMatches(claim.pattern, unit));
      globAbsorption.push({
        pattern: claim.pattern,
        page: page.id,
        reason: claim.reason,
        absorbed: matches.length
      });
      for (const unit of matches) {
        if (!glob.has(unit)) {
          glob.set(unit, { page: page.id, pattern: claim.pattern });
        }
      }
    }
  }

  const directive = new Map();
  const prefixOnlySettings = [];
  const contentValues = new Set();
  for (const page of pages) {
    for (const occurrence of page.directives) {
      if (occurrence.name === 'action') {
        contentValues.add(occurrence.attributes.command);
      } else if (occurrence.name === 'settings') {
        contentValues.add(occurrence.attributes.query);
      }
    }
  }
  for (const page of defaultPages) {
    for (const occurrence of page.directives) {
      if (occurrence.name === 'action') {
        const command = occurrence.attributes.command;
        if (model.commandIdSet.has(command) && !directive.has(command)) {
          directive.set(command, page.id);
        }
      } else if (occurrence.name === 'settings') {
        // §C.7 п.3, EXACT NAMING (ISS-096). A `:settings{query=…}` whose value
        // is a mere SEGMENT PREFIX covers NOTHING: it is an affordance, not a
        // coverage claim. See the block comment above `computeCoverage`.
        const query = occurrence.attributes.query;
        if (model.preferenceKeySet.has(query)) {
          if (!directive.has(query)) {
            directive.set(query, page.id);
          }
          continue;
        }
        const shadowed = model.preferenceKeys.filter(key => isSegmentPrefix(query, key));
        if (shadowed.length > 0) {
          prefixOnlySettings.push({
            query,
            file: page.file,
            line: occurrence.line,
            column: occurrence.column,
            keys: shadowed
          });
        }
      }
    }
  }

  const allowlisted = new Map();
  for (const unit of model.units) {
    const entry = allowlist.find(candidate => patternMatches(candidate.pattern, unit));
    if (entry) {
      allowlisted.set(unit, entry);
    }
  }

  const buckets = {
    exact: [],
    directive: [],
    glob: [],
    external: [],
    dynamic: [],
    exempt: [],
    // NOT a coverage bucket in the "documented" sense — a SCHEDULED DEBT bucket.
    // It sits here because the accounting invariant has to stay total over the
    // inventory, and it is reported on its own row and in its own section so
    // that "described" and "promised" never read as the same number (§B.6).
    deferred: [],
    uncovered: []
  };
  for (const unit of model.units) {
    if (exact.has(unit)) {
      buckets.exact.push(unit);
    } else if (glob.has(unit)) {
      buckets.glob.push(unit);
    } else if (directive.has(unit)) {
      buckets.directive.push(unit);
    } else if (allowlisted.has(unit)) {
      buckets[allowlisted.get(unit).kind].push(unit);
    } else {
      buckets.uncovered.push(unit);
    }
  }

  return { buckets, directive, globAbsorption, contentValues, prefixOnlySettings };
}

// --------------------------------------------------------------------------
// Emission (§B.2)
// --------------------------------------------------------------------------

function pageLiteral(page) {
  const value = {
    id: page.id,
    lang: page.lang,
    title: page.title,
    order: page.order
  };
  if (page.section !== undefined) {
    value.section = page.section;
  }
  value.markdown = page.markdown;
  value.covers = page.covers;
  return value;
}

/**
 * The generated module (§B.2). Records are TOTAL over `DocsLang` — every
 * language gets a key even when its set is empty, which is what makes the dead
 * `?? DOCS_MANIFEST['ru']` guard unnecessary (F-D6-1): an incomplete language is
 * handled by `resolveDocsManifest`, not by a lookup that can never miss.
 */
function renderModule(pages) {
  const content = {};
  const manifest = {};
  for (const lang of DOCS_LANGS) {
    const ofLang = pages.filter(page => page.lang === lang).sort((left, right) => byText(left.id, right.id));
    content[lang] = Object.fromEntries(ofLang.map(page => [page.id, pageLiteral(page)]));
    manifest[lang] = {
      lang,
      entries: sortDocsManifestEntries(
        ofLang.map(page => {
          const entry = { id: page.id, title: page.title, order: page.order };
          if (page.section !== undefined) {
            entry.section = page.section;
          }
          return entry;
        })
      )
    };
  }
  return `// AUTOGENERATED by scripts/generate-docs-content.mjs — do not edit.
import type { DocsLang, DocsManifest, DocsPage, DocsContentProvider } from '../../common/docs/docs-contract';

export const DOCS_CONTENT: Readonly<Record<DocsLang, Readonly<Record<string, DocsPage>>>> = ${JSON.stringify(
    content,
    undefined,
    2
  )};

export const DOCS_MANIFEST: Readonly<Record<DocsLang, DocsManifest>> = ${JSON.stringify(
    manifest,
    undefined,
    2
  )};

export const generatedDocsContentProvider: DocsContentProvider = {
  getPage: (lang, id) => DOCS_CONTENT[lang]?.[id],
  getManifest: lang => DOCS_MANIFEST[lang]
};
`;
}

// --------------------------------------------------------------------------
// Report (§B.6)
// --------------------------------------------------------------------------

function table(header, alignment, rows) {
  if (rows.length === 0) {
    return [`| ${header.join(' | ')} |`, `|${alignment.join('|')}|`].join('\n');
  }
  return [
    `| ${header.join(' | ')} |`,
    `|${alignment.join('|')}|`,
    ...rows.map(row => `| ${row.join(' | ')} |`)
  ].join('\n');
}

/**
 * The committed coverage report — DETERMINISTIC AND UNDATED (§B.6).
 *
 * A timestamp would change the file on every build, and the diff would stop
 * meaning "coverage changed" — which is the only reason F-D3-1 asked for a
 * committed artifact instead of a build log line.
 */
function renderReport(model, coverage, allowlist, allowlistMatches, queue, ceiling, passedViaQueue) {
  const { buckets } = coverage;
  const universe = model.units.length;
  const exemptShare = universe === 0 ? 0 : (buckets.exempt.length / universe) * 100;
  const deferredShare = universe === 0 ? 0 : (buckets.deferred.length / universe) * 100;

  const summary = table(
    ['Metric', 'Value'],
    ['---', '---'],
    [
      // The SCOPE of the whole guarantee, printed first because every number
      // below is relative to it (F-D9-8).
      //
      // The namespace list is frozen in a literal (`INVENTORY_NAMESPACES` in
      // extract-feature-inventory.mjs). A product command registered in a THIRD
      // namespace is not merely uncovered — it never enters the inventory, so it
      // is never required to be described AND, unlike a template-literal id, it
      // does not even surface under `Skipped declarations`. That is the one
      // completely SILENT way out from under the guarantee. Printing the active
      // list here does not close the hole, but it makes any change to it show up
      // as a diff line in this committed report instead of passing unnoticed.
      ['Inventory namespaces', model.namespaces.length ? model.namespaces.map(n => `\`${n}\``).join(', ') : '(none declared)'],
      ['Inventory ids (commands)', model.commandIds.length],
      ['Inventory keys (preferences)', model.preferenceKeys.length],
      ['Covered by exact id', buckets.exact.length],
      ['Covered by directive occurrence', buckets.directive.length],
      ['Absorbed by glob', buckets.glob.length],
      ['Allowlisted: external', buckets.external.length],
      ['Allowlisted: dynamic', buckets.dynamic.length],
      ['Allowlisted: exempt', buckets.exempt.length],
      ['Exempt share of inventory', `${exemptShare.toFixed(1)}%`],
      // Its OWN row, immediately below the exempt pair and ABOVE `Uncovered`,
      // because that is where a reader looks for "how much is not described".
      // Folding it into any `Covered …` row would turn a promise into a
      // reported fact — the exact failure mode F-D2-2 diagnosed for `exempt`.
      ['Deferred to a task', buckets.deferred.length],
      ['Deferred share of inventory', `${deferredShare.toFixed(1)}%`],
      ['Uncovered', buckets.uncovered.length],
      ['Glob absorption ceiling (N)', ceiling],
      ['Pending exception requests', queue.length],
      ['Passed via pending external request', passedViaQueue]
    ]
  );

  const directiveRows = buckets.directive
    .map(unit => [unit, coverage.directive.get(unit)])
    .sort((left, right) => byText(left[0], right[0]));

  const globRows = coverage.globAbsorption
    .map(item => [item.pattern, item.page, String(item.absorbed), item.reason])
    .sort((left, right) => byText(left[0], right[0]) || byText(left[1], right[1]));

  const allowlistRows = allowlist
    .map(entry => [entry.pattern, entry.kind, String(allowlistMatches.get(entry) ?? 0), entry.reason])
    .sort((left, right) => byText(left[0], right[0]));

  // One row PER INVENTORY UNIT, not per allowlist entry: a single `…excalidraw.*`
  // pattern would otherwise hide nine undescribed buttons behind one line, which
  // is the visibility the section exists to provide. `Deferred to` is repeated on
  // every row so the debt is readable without cross-referencing the allowlist.
  const deferredRows = [...buckets.deferred]
    .sort(byText)
    .map(unit => {
      const entry = allowlist.find(candidate => patternMatches(candidate.pattern, unit));
      return [unit, entry?.deferredTo ?? '', entry?.pattern ?? '', entry?.reason ?? ''];
    });

  const uncovered =
    buckets.uncovered.length === 0
      ? '_(none)_'
      : [...buckets.uncovered].sort(byText).map(unit => `- ${unit}`).join('\n');

  const skippedRows = [...model.skipped]
    .map(entry => [entry.file, String(entry.line), entry.why])
    .sort((left, right) => byText(left[0], right[0]) || Number(left[1]) - Number(right[1]));

  return `<!-- AUTOGENERATED by scripts/generate-docs-content.mjs — do not edit by hand. -->
# Coverage report

## Summary

${summary}

## Covered by directive occurrence

${table(['Id', 'Page'], ['---', '---'], directiveRows)}

## Glob absorption

${table(['Pattern', 'Page', 'Absorbed', 'Reason'], ['---', '---', '---:', '---'], globRows)}

## Allowlist

${table(['Pattern', 'Kind', 'Matches', 'Reason'], ['---', '---', '---:', '---'], allowlistRows)}

## Deferred coverage

${table(['Id', 'Deferred to', 'Pattern', 'Reason'], ['---', '---', '---', '---'], deferredRows)}

## Uncovered ids

${uncovered}

## Skipped declarations (not extractable)

${table(['File', 'Line', 'Why'], ['---', '---:', '---'], skippedRows)}
`;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function argumentValue(argv, name) {
  const prefix = `--${name}=`;
  const match = argv.find(argument => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

/**
 * `--coverage` ABSENT MEANS STRICT (§1.3) — the fail-safe default.
 *
 * The damage is asymmetric: a false "too strict" costs a developer a minute,
 * a false "too lenient" costs the guarantee the task is built on, silently.
 * There is no `off` mode for the same reason — a switch that disables the
 * check outright is a ready-made way around the teeth.
 */
function parseMode(argv) {
  const bare = argv.find(argument => argument === '--coverage');
  if (bare) {
    throw new ConfigError('docs-gen: invalid --coverage value \'\' (expected "strict" or "warn")');
  }
  const value = argumentValue(argv, 'coverage');
  if (value === undefined) {
    return 'strict';
  }
  if (value !== 'strict' && value !== 'warn') {
    throw new ConfigError(`docs-gen: invalid --coverage value '${value}' (expected "strict" or "warn")`);
  }
  return value;
}

function parseCeiling(argv) {
  const value = argumentValue(argv, 'glob-ceiling');
  if (value === undefined) {
    return DEFAULT_GLOB_CEILING;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`docs-gen: invalid --glob-ceiling value '${value}' (expected a positive integer)`);
  }
  return parsed;
}

/**
 * The repository root, EXPLICITLY (§1.0) — `--repo-root=<abs>` or the script's
 * own location, verified by the `workspaces` field. "Walk up to the first
 * `.git`" breaks in a worktree and in a CI container, and fails by writing the
 * artifacts somewhere else in silence.
 */
async function resolveRepositoryRoot(argv, scriptDirectory) {
  const explicit = argumentValue(argv, 'repo-root');
  const candidate = explicit ? resolve(explicit) : resolve(scriptDirectory, '../../..');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(join(candidate, 'package.json'), 'utf8'));
  } catch {
    manifest = undefined;
  }
  if (!manifest || manifest.workspaces === undefined) {
    throw new ConfigError(`docs-gen: cannot locate repository root (tried "${candidate}") — pass --repo-root`);
  }
  return candidate;
}

const KNOWN_ARGUMENTS = new Set(['coverage', 'repo-root', 'glob-ceiling', 'module', 'report']);

function checkArguments(argv) {
  for (const argument of argv) {
    const name = argument.startsWith('--') ? argument.slice(2).split('=')[0] : argument;
    if (!KNOWN_ARGUMENTS.has(name)) {
      throw new ConfigError(`docs-gen: unknown argument "${argument}"`);
    }
  }
}

function outputPath(argv, name, repoRoot, relativePath) {
  const explicit = argumentValue(argv, name);
  if (!explicit) {
    return join(repoRoot, relativePath);
  }
  return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
}

async function writeFile(absolutePath, contents) {
  await fs.mkdir(dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, 'utf8');
}

async function main(argv) {
  checkArguments(argv);
  const mode = parseMode(argv);
  const ceiling = parseCeiling(argv);
  const repoRoot = await resolveRepositoryRoot(argv, dirname(fileURLToPath(import.meta.url)));

  const inventory = await loadInventory(repoRoot);
  const model = buildInventoryModel(inventory);

  const problems = new Problems();
  const allowlist = await loadExceptions(repoRoot, ALLOWLIST_RELATIVE_PATH, { isQueue: false }, model, problems);
  const queue = await loadExceptions(repoRoot, QUEUE_RELATIVE_PATH, { isQueue: true }, model, problems);
  // §4.3 — checked HERE, before the fences, on purpose. A `strict` build with a
  // pending queue is unshippable whatever the pages say, and the fences do NOT
  // consult the queue in `strict`: reporting the dangling `command=` first would
  // send the author to fix a page whose real problem is an unadjudicated
  // request. The diagnosis has to name the actual blocker.
  if (mode === 'strict' && queue.length > 0) {
    problems.add(
      `${queue.length} unapplied coverage-exception request(s) — adjudicate them into ${ALLOWLIST_RELATIVE_PATH}`
    );
  }
  problems.checkpoint();

  const pages = await loadPages(repoRoot, model, ceiling, problems);
  problems.checkpoint();

  const { passedViaQueue } = checkFences(pages, model, allowlist, queue, mode, problems);
  const coverage = computeCoverage(pages, model, allowlist);
  const defaultSetIsEmpty = pages.every(page => page.lang !== DEFAULT_DOCS_LANG);
  const allowlistMatches = checkStaleExceptions(
    allowlist,
    model,
    coverage.contentValues,
    defaultSetIsEmpty,
    problems
  );
  problems.checkpoint();

  const accounted =
    coverage.buckets.exact.length +
    coverage.buckets.directive.length +
    coverage.buckets.glob.length +
    coverage.buckets.external.length +
    coverage.buckets.dynamic.length +
    coverage.buckets.exempt.length +
    coverage.buckets.deferred.length +
    coverage.buckets.uncovered.length;
  if (accounted !== model.units.length) {
    throw new ConfigError(
      `docs-gen: coverage accounting mismatch (sum=${accounted}, inventory=${model.units.length})`
    );
  }

  await writeFile(outputPath(argv, 'module', repoRoot, MODULE_RELATIVE_PATH), renderModule(pages));
  await writeFile(
    outputPath(argv, 'report', repoRoot, REPORT_RELATIVE_PATH),
    renderReport(model, coverage, allowlist, allowlistMatches, queue, ceiling, passedViaQueue)
  );

  // Mode-dependent teeth, LAST: both artifacts are written either way, so a
  // strict build that stops on an uncovered id still leaves the report that
  // says WHICH ids, and `tsc -w` still has a module to compile.
  if (mode === 'strict') {
    if (coverage.buckets.uncovered.length > 0) {
      problems.add(
        `${coverage.buckets.uncovered.length} uncovered id(s) — document them, exempt them, defer them to a task,` +
          ` or mark them dynamic (see ${REPORT_RELATIVE_PATH})`
      );
    }
    problems.checkpoint();
  }

  // ADVISORY, never fatal (ISS-096). A prefix `query=` covers nothing, and the
  // keys it points at surface in `Uncovered ids` — truthful, but from there the
  // author cannot tell that the button they wrote was expected to pay for them.
  // This line says so at the exact source position.
  //
  // It is NOT a rule violation on purpose: the very same directive is correct on
  // a page that ALSO lists those keys in `covers`, and failing the build would
  // make the fix "delete the button", i.e. a worse page. The teeth live in the
  // completeness fence, which now sees the keys it was blind to.
  for (const item of coverage.prefixOnlySettings) {
    const uncovered = item.keys.filter(key => coverage.buckets.uncovered.includes(key));
    process.stdout.write(
      `docs-gen: NOTE :settings{query="${item.query}"} at ${item.file}:${item.line}:${item.column} is a segment` +
        ` prefix of ${item.keys.length} preference key(s) and covers none of them` +
        ` (${uncovered.length} of them uncovered) — an occurrence covers only the key it names exactly;` +
        ` describe those keys and list them in "covers", or point the button at one key\n`
    );
  }

  const notes = [];
  if (mode === 'warn' && coverage.buckets.uncovered.length > 0) {
    notes.push(`${coverage.buckets.uncovered.length} uncovered id(s)`);
  }
  if (mode === 'warn' && queue.length > 0) {
    notes.push(`${queue.length} pending exception request(s)`);
  }
  process.stdout.write(
    `docs-gen: ${pages.length} page(s), ${model.units.length} inventory unit(s), mode=${mode}` +
      `${notes.length > 0 ? ` — WARN: ${notes.join('; ')}` : ''}\n`
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    if (error instanceof RuleFailure) {
      process.stderr.write(`${error.messages.join('\n')}\n`);
      process.exit(1);
    }
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`docs-gen: ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}

export { buildInventoryModel, matchesDynamicSubject, patternMatches };
