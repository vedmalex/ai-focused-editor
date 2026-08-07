import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Localization } from '@theia/core/lib/common/i18n/localization';
import { MULTI_FILE_MAX } from '../../common/typography/multi-file-limits';
// The CANONICAL rule registry (CR/F-CR-1). DOM/Theia-browser free by hard
// constraint, which is what lets this Node lane import it at all — see the
// module header of `common/typography/typography-rules.ts`.
import { TYPOGRAPHY_RULES } from '../../common/typography/typography-rules';

/**
 * PLACEHOLDER-ARITY GUARD FOR THE LOCALIZED STRINGS (QA/ISS-261, hardened
 * QA/F-QA3-2..4 in TASK-020).
 *
 * Theia substitutes arguments positionally and FAIL-OPEN:
 *
 *   message.replace(/{([^}]+)}/g, (match, group) => args[group] ?? match)
 *
 * An index the caller never supplied is therefore not an error — it is rendered
 * to the user VERBATIM, as a literal `{1}`. Nothing in the type system sees this:
 * the English default lives at the `nls.localize` call site while the Russian
 * text lives in a JSON dictionary keyed by a string, so the two drift silently.
 *
 * That is exactly how ISS-258's remediation broke the PRIMARY locale of a
 * Russian-first product: dropping the file-count argument from
 * `.../typography/batch-files-too-many` fixed the English string and left the
 * two-placeholder Russian one behind, so a Russian user saw a phantom count AND
 * a raw `{1}`. All 2600+ tests stayed green, because every one of them asserted
 * on the English default.
 *
 * This suite closes the CLASS rather than that one string. It parses every
 * `nls.localize(key, default, ...args)` call in the repository, flattens every
 * `src/node/i18n/ru/*.json` dictionary the way
 * `registerLocalizationFromRequire` does (nested keys joined with `/`), and
 * checks the translations against the call sites they will actually be
 * substituted into.
 *
 * The scan is deliberately a plain lexer, not a TypeScript parse: it must run in
 * the ordinary test lane in milliseconds. Its blind spots are made LOUD instead
 * of silent — see the "the scan itself is not vacuous" case, which fails if the
 * lexer ever stops finding call sites.
 *
 * TASK-020 hardening (QA it.3 carry-forward, F-QA3-2/3/4 — the guard itself had
 * the same class of gap it exists to close):
 *
 *  - F-QA3-2: a key localized from TWO call sites used to be checked only
 *    against the FIRST one the directory walk met (`calls.has(key)) continue`).
 *    A second site with a SMALLER arity was invisible. `scanLocalizeCalls` now
 *    keeps every call site per key, and the Russian checks are evaluated against
 *    all of them: the STRICTEST (smallest) argument count (`aggregateArity`),
 *    and — for the index check — the requirement that SOME single call site
 *    offers every index the translation uses (see {@link subsetOffenders}).
 *  - F-QA3-3: a key registered only via `Command.toLocalizedCommand(..., key)`
 *    (or another non-literal path) never entered `calls`, so every Russian
 *    arity check silently `continue`d past it — protected from an orphan-key
 *    check (the literal string is still findable in source) but NOT from a
 *    placeholder-arity check. A new guard asserts every placeholder-bearing
 *    translation has a scanned `nls.localize(...)` call site to check it
 *    against.
 *  - F-QA3-4: the rendered-cap test hardcoded `'500'` instead of the production
 *    constant. It now imports {@link MULTI_FILE_MAX} (from `common/typography`,
 *    DOM/Theia-free — importing the browser `typography-commands.ts` directly
 *    would pull monaco/`@theia/core/lib/browser` into this Node test lane) and
 *    mirrors whatever the constant actually is.
 */

const HERE = import.meta.dir;
const REPO_ROOT = join(HERE, '../../../../..');

/** This package's own dictionaries. Named separately because one test below
 *  reaches into a specific file of it by name. */
const RU_DIR = join(HERE, 'ru');

/**
 * EVERY package's Russian dictionaries, not just this one (TASK-022 WP-5,
 * plan AD-1 / UR-010(2)).
 *
 * THE GATE WAS SILENTLY NARROW. The source scan above has always covered
 * `packages` and `apps` whole (`DEFAULT_SCAN_ROOTS`), but the DICTIONARY side
 * read one directory — this package's. The three `ai-connect-theia` bundles
 * (`ai-config.json`, `ai-log.json`, `ai-usage.json`), registered through
 * `AiConnectRuLocalizationContribution`, were therefore never checked against
 * a single call site: not for an over-running `{N}`, not for an invented
 * number, not for orphanhood. That is the failure mode plan R-9 is about — a
 * gate that stays green because it is looking away — and it is the reason a
 * new package inherits NO repository-wide guard for free.
 *
 * DISCOVERED, NOT LISTED. An explicit array would have to be extended by
 * whoever adds the next package's bundle, which is exactly the step that was
 * missed for `ai-connect-theia`; a walk closes the CLASS instead of the two
 * instances known today. The floor case below turns a walk that finds nothing
 * — a moved convention, a renamed directory — into a red test rather than a
 * vacuous green.
 */
function russianDictionaryDirs(): string[] {
  const packagesRoot = join(REPO_ROOT, 'packages');
  const found: string[] = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(packagesRoot, entry.name, 'src', 'node', 'i18n', 'ru');
    // `existsSync` FIRST, and no `try`/`catch` around the `statSync`. The
    // obvious shape here is a broad `catch` treating any throw as "this package
    // has no dictionaries" — and it silently swallowed a missing import while
    // this widening was being written, leaving the walk finding ZERO
    // directories and every check below vacuously green. The floor case
    // ("really found every package's dictionaries") is what caught it; the
    // narrow form is what stops it recurring.
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      found.push(candidate);
    }
  }
  return found.sort();
}

const RU_DIRS = russianDictionaryDirs();

/** Namespaces this repository OWNS (and therefore may assert English-side arity on). */
const OWNED_KEY_PREFIXES = ['ai-focused-editor/', 'ai-connect/'];

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

/** Every `.ts`/`.tsx` under `dir`, skipping build output and dependencies. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git' || entry.name === 'src-gen') {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(path, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Split the argument list of a call whose `(` sits at `open`, skipping over
 * strings, template substitutions and comments so a comma inside them is not
 * mistaken for an argument separator.
 */
function splitArguments(src: string, open: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const char = src[i];
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      i++;
      for (; i < src.length; i++) {
        if (src[i] === '\\') {
          i++;
          continue;
        }
        if (src[i] === quote) {
          break;
        }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          let braces = 1;
          i += 2;
          for (; i < src.length && braces > 0; i++) {
            if (src[i] === '{') {
              braces++;
            } else if (src[i] === '}') {
              braces--;
            }
          }
          i--;
        }
      }
      continue;
    }
    if (char === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (char === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        i++;
      }
      i++;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth++;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, i));
        return args;
      }
      continue;
    }
    if (char === ',' && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return undefined;
}

const STRING_LITERAL = /^\s*(['"])((?:[^\\]|\\.)*?)\1\s*$/;

/** The value of `arg` when it is a single quoted string literal, else undefined. */
function stringLiteral(arg: string): string | undefined {
  const match = STRING_LITERAL.exec(arg);
  if (!match) {
    return undefined;
  }
  return match[2]
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** The distinct `{N}` indices in `text`, ascending. */
function placeholderIndices(text: string): number[] {
  const indices = new Set<number>();
  for (const match of text.matchAll(/\{(\d+)\}/g)) {
    indices.add(Number(match[1]));
  }
  return [...indices].sort((a, b) => a - b);
}

interface LocalizeCallSite {
  /** The English default — the source of truth for which indices exist. */
  readonly def: string;
  /** Number of substitution arguments, or -1 when a spread makes it unknowable. */
  readonly argCount: number;
  readonly file: string;
}

/** The repository trees the whole-repo scan below covers. */
const DEFAULT_SCAN_ROOTS: readonly string[] = ['packages', 'apps'];

/**
 * `nls.localize(key, default, ...args)` call sites, grouped by key. A key CAN
 * legitimately be localized from more than one call site (QA/F-QA3-2) — every
 * site the scan meets is kept, in encounter order.
 *
 * `roots` is parameterised (repo-relative OR absolute) purely so the COLLECTION
 * itself can be given end-to-end teeth: the "keeps EVERY call site" suite below
 * points it at a throwaway fixture tree outside the repository. The default is
 * the whole-repo scan, so the module-level `scanLocalizeCalls()` call is
 * behaviourally unchanged.
 */
function scanLocalizeCalls(roots: readonly string[] = DEFAULT_SCAN_ROOTS): {
  calls: Map<string, LocalizeCallSite[]>;
  text: string;
} {
  const calls = new Map<string, LocalizeCallSite[]>();
  const chunks: string[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(isAbsolute(root) ? root : join(REPO_ROOT, root))) {
      const src = readFileSync(file, 'utf8');
      chunks.push(src);
      let idx = 0;
      while ((idx = src.indexOf('nls.localize(', idx)) !== -1) {
        const open = idx + 'nls.localize'.length;
        const args = splitArguments(src, open);
        // Advance by ONE character, never past the parsed call: a single
        // mis-lexed call must not swallow the ones that follow it.
        idx = open + 1;
        if (!args) {
          continue;
        }
        const [rawKey, rawDefault, ...rest] = args;
        const key = rawKey === undefined ? undefined : stringLiteral(rawKey);
        const def = rawDefault === undefined ? undefined : stringLiteral(rawDefault);
        if (key === undefined || def === undefined) {
          continue;
        }
        const spread = rest.some(arg => arg.trim().startsWith('...'));
        const site: LocalizeCallSite = {
          def,
          argCount: spread ? -1 : rest.length,
          // `relative`, not a `slice` of REPO_ROOT: a fixture root outside the
          // repository would otherwise be reported as a mangled substring.
          file: relative(REPO_ROOT, file)
        };
        const existing = calls.get(key);
        if (existing) {
          existing.push(site);
        } else {
          calls.set(key, [site]);
        }
      }
    }
  }
  return { calls, text: chunks.join('\n') };
}

interface AggregatedArity {
  /**
   * The SMALLEST argument count across every KNOWN (non-spread) call site for
   * a key — the strictest constraint a single shared translation must satisfy.
   * -1 when every site is unknowable (all spread `...args`).
   */
  readonly minArgCount: number;
}

/**
 * Aggregate a key's call sites for cross-checking against its translation
 * (QA/F-QA3-2).
 *
 * Deliberately arity-only. An earlier revision also exposed the UNION of every
 * site's English placeholder indices, and {@link subsetOffenders} accepted a
 * translation whose indices were a subset of that union — which admits a
 * translation that MIXES indices from different sites and therefore matches no
 * single one of them in full (QA/F-QA1-4). The index check is now an
 * EXISTS-SITE test done per site, so no union is computed anywhere.
 */
function aggregateArity(sites: readonly LocalizeCallSite[]): AggregatedArity {
  const known = sites.map(site => site.argCount).filter(count => count >= 0);
  return { minArgCount: known.length > 0 ? Math.min(...known) : -1 };
}

// ---------------------------------------------------------------------------
// Dictionary load
// ---------------------------------------------------------------------------

/** Flatten nested dictionary objects into `a/b/c` keys, as Theia's registry does. */
function flatten(node: unknown, prefix: string, out: Map<string, string>): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}/${key}` : key;
    if (typeof value === 'string') {
      out.set(path, value);
    } else {
      flatten(value, path, out);
    }
  }
}

interface Translation {
  readonly key: string;
  readonly text: string;
  readonly file: string;
}

function loadRussianDictionaries(dirs: readonly string[] = RU_DIRS): Translation[] {
  const out: Translation[] = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter(entry => entry.endsWith('.json'))) {
      const absolute = join(dir, name);
      const flat = new Map<string, string>();
      flatten(JSON.parse(readFileSync(absolute, 'utf8')), '', flat);
      for (const [key, text] of flat) {
        // REPO-RELATIVE, not the bare basename. With one directory a basename
        // identified the file; across packages two of them could be called
        // `ai-log.json`, and an offender message naming an ambiguous file sends
        // the reader to the wrong one.
        out.push({ key, text, file: relative(REPO_ROOT, absolute) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Russian-check logic, extracted as pure functions (QA/F-QA3-2, F-QA3-3): the
// same functions run both against the whole-repo scan below AND against the
// synthetic reproductions in the "regression guards have teeth" suite, so the
// synthetic cases exercise the ACTUAL production check, not a re-implementation
// of it that could itself drift out of sync.
// ---------------------------------------------------------------------------

/**
 * QA/F-QA3-2 + QA/F-QA1-4: SOME single call site's English default must offer
 * EVERY index the translation uses.
 *
 * The weaker "subset of the union of all sites' indices" rule this replaces let
 * a translation assemble `{0}` from one site and `{1}` from another and match
 * neither in full — the exact multi-site blind spot F-QA3-2 exists to close,
 * reintroduced one level up. A shared translation is rendered by ONE call at a
 * time, so it has to fit ONE call site as a whole.
 */
function subsetOffenders(calls: ReadonlyMap<string, readonly LocalizeCallSite[]>, translations: readonly Translation[]): string[] {
  const offenders: string[] = [];
  for (const { key, text, file } of translations) {
    const sites = calls.get(key);
    if (!sites) {
      continue;
    }
    const russian = placeholderIndices(text);
    if (russian.length === 0) {
      continue;
    }
    const fits = sites.some(site => {
      const english = new Set(placeholderIndices(site.def));
      return russian.every(index => english.has(index));
    });
    if (!fits) {
      offenders.push(
        `${file} :: ${key} uses {${russian.join('}, {')}} and NO single call site's English default ` +
        `offers all of them — ru="${text}" en=${JSON.stringify(sites.map(site => site.def))}`
      );
    }
  }
  return offenders;
}

/** QA/F-QA3-2: a translation must not reference an index the STRICTEST (smallest-arity) call site never passes. */
function overIndexOffenders(calls: ReadonlyMap<string, readonly LocalizeCallSite[]>, translations: readonly Translation[]): string[] {
  const offenders: string[] = [];
  for (const { key, text, file } of translations) {
    const sites = calls.get(key);
    if (!sites) {
      continue;
    }
    const { minArgCount } = aggregateArity(sites);
    if (minArgCount < 0) {
      continue;
    }
    const over = placeholderIndices(text).filter(index => index >= minArgCount);
    if (over.length > 0) {
      const strictest = sites.find(site => site.argCount === minArgCount);
      offenders.push(
        `${file} :: ${key} uses {${over.join('}, {')}} but its strictest call site ` +
        `(${strictest?.file ?? '?'}) passes only ${minArgCount} argument(s)`
      );
    }
  }
  return offenders;
}

/** A hardcoded digit not backed by ANY call site's English default. */
function inventedNumberOffenders(calls: ReadonlyMap<string, readonly LocalizeCallSite[]>, translations: readonly Translation[]): string[] {
  const offenders: string[] = [];
  for (const { key, text, file } of translations) {
    const sites = calls.get(key);
    if (!sites) {
      continue;
    }
    const englishNumbers = new Set(sites.flatMap(site => site.def.replace(/\{\d+\}/g, '').match(/\d+/g) ?? []));
    const invented = (text.replace(/\{\d+\}/g, '').match(/\d+/g) ?? []).filter(n => !englishNumbers.has(n));
    if (invented.length > 0) {
      offenders.push(`${file} :: ${key} hardcodes ${invented.join(', ')} — ru="${text}" en=${JSON.stringify(sites.map(site => site.def))}`);
    }
  }
  return offenders;
}

/**
 * QA/F-QA3-3: a placeholder-bearing translation whose key has NO scanned
 * `nls.localize(...)` call site at all.
 *
 * KNOWN LIMIT (QA/F-QA1-3 — do not read this as "every registration path is
 * covered"): the predicate is `!calls.has(key)`, i.e. it only closes keys with
 * ZERO scanned call sites. A key registered BOTH through `nls.localize(...)`
 * AND through some other path (`Command.toLocalizedCommand(..., key)`, a
 * runtime-assembled key, a `localize` re-export the lexer does not know) is
 * PARTIALLY scanned: the arity checks run against the scanned site(s) only, and
 * an unscanned site passing FEWER arguments stays invisible. Closing that would
 * take a real TypeScript parse of the non-literal registration paths; it is
 * recorded as a residual risk rather than silently implied to be covered.
 */
function unscannedPlaceholderOffenders(calls: ReadonlyMap<string, readonly LocalizeCallSite[]>, translations: readonly Translation[]): string[] {
  return translations
    .filter(entry => placeholderIndices(entry.text).length > 0)
    .filter(entry => !calls.has(entry.key))
    .map(entry => `${entry.file} :: ${entry.key} = "${entry.text}" (no nls.localize(...) call site found — arity unchecked, e.g. registered only via Command.toLocalizedCommand)`);
}

const { calls, text: allSources } = scanLocalizeCalls();
const translations = loadRussianDictionaries();

function owned(key: string): boolean {
  return OWNED_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

describe('localized strings — the scan itself is not vacuous', () => {
  /**
   * Everything below is an "assert no offenders" shape, which passes trivially if
   * the lexer silently stops finding call sites or dictionaries. These floors
   * turn that failure mode into a red test instead of a green vacuum.
   */
  test('the lexer finds the repository\'s localize calls and dictionaries', () => {
    expect(calls.size).toBeGreaterThan(1000);
    expect(translations.length).toBeGreaterThan(1000);
    // A concrete, load-bearing call site really was parsed, arguments included.
    const capped = calls.get('ai-focused-editor/typography/batch-files-too-many');
    expect(capped).toBeDefined();
    expect(capped).toHaveLength(1);
    expect(capped![0].argCount).toBe(1);
    expect(placeholderIndices(capped![0].def)).toEqual([0]);
  });

  test('the keys the dictionaries translate really are the keys the code asks for', () => {
    // Not every translated key comes from `nls.localize` — command labels go
    // through `Command.toLocalizedCommand(…, key)` and a few keys are assembled
    // at runtime — so this is a hard FLOOR on the join, not a coverage ratio. If
    // the key-path convention ever drifts (e.g. `/` vs `.`), the join collapses
    // to nothing and every check below silently stops testing anything.
    const matched = translations.filter(entry => calls.has(entry.key));
    expect(matched.length).toBeGreaterThan(1000);

    // Spot-check the join across unrelated areas, so a partial drift is caught too.
    for (const key of [
      'ai-focused-editor/typography/batch-files-applied',
      'ai-focused-editor/doctor/problem-entity-card-missing',
      'ai-focused-editor/sources/problem-duplicate-id'
    ]) {
      expect(calls.has(key)).toBe(true);
      expect(translations.some(entry => entry.key === key)).toBe(true);
    }
  });

  test('the dictionary walk really found EVERY package\'s bundles (TASK-022 WP-5, UR-010(2))', () => {
    // THE FLOOR THAT MADE THE WIDENING REAL. Replacing one directory with a
    // walk is exactly the kind of change that can end in a walk finding
    // nothing, and every "assert no offenders" check above would then pass
    // louder than before. It is not hypothetical: while this was being written
    // the walk threw on a missing import, the `catch` treated it as "no
    // dictionaries here", and this case is what turned the resulting silence
    // red.
    expect(RU_DIRS.length).toBeGreaterThanOrEqual(3);
    for (const owner of ['manuscript-workspace', 'ai-connect-theia', 'narrative-knowledge']) {
      expect(RU_DIRS.some(dir => dir.includes(`/packages/${owner}/`))).toBe(true);
    }

    // And the CONTENT of the newly covered bundles really entered the checks —
    // a directory found but read as empty would be the same vacuum one level
    // down. One key from each of the three `ai-connect-theia` dictionaries
    // (never guarded until now) and one from the new package's.
    for (const key of [
      'ai-focused-editor/ai-config/tt-alias',
      'ai-focused-editor/narrative-memory/index-failure-internal'
    ]) {
      expect(translations.some(entry => entry.key === key)).toBe(true);
    }
    for (const bundle of ['ai-config.json', 'ai-log.json', 'ai-usage.json', 'narrative-memory.json']) {
      expect(translations.some(entry => entry.file.endsWith(bundle))).toBe(true);
    }
  });
});

describe('localized strings — the widened dictionary walk has teeth (TASK-022 WP-5)', () => {
  /**
   * The plan's readiness block asks for the guard to be "зелёный на расширенном
   * списке И красный при намеренно сломанном плейсхолдере в НОВОМ бандле".
   * Green on the widened list is every check above. Red on a deliberately
   * broken phrase is here — and it is fed to the SAME production functions the
   * real dictionaries go through, against the REAL scanned call sites, so a
   * pass proves the actual check bites rather than a re-implementation of it.
   */
  const NARRATIVE = 'packages/narrative-knowledge/src/node/i18n/ru/narrative-memory.json';

  test('a placeholder smuggled into an arity-0 narrative-memory phrase is CAUGHT', () => {
    // `status-ready` is rendered through the package's phrase CATALOG, so its
    // key never appears as a literal at an `nls.localize(` call site and the
    // arity comparisons have nothing to compare it against. That silence is
    // precisely what `unscannedPlaceholderOffenders` exists to make loud.
    const broken: Translation[] = [
      {
        key: 'ai-focused-editor/narrative-memory/status-ready',
        text: 'Индекс рукописи: готов {0}',
        file: NARRATIVE
      }
    ];
    expect(unscannedPlaceholderOffenders(calls, broken)).not.toEqual([]);
    // The same phrase WITHOUT the placeholder is clean — otherwise the case
    // above would pass on a check that flags everything.
    expect(
      unscannedPlaceholderOffenders(calls, [{ ...broken[0], text: 'Индекс рукописи: готов' }])
    ).toEqual([]);
  });

  test('an over-running index in a TEMPLATED narrative-memory phrase is CAUGHT', () => {
    // The other half of the package's phrase split: a phrase that needs a
    // substitution is written as a literal call site in `src/browser`, so the
    // scan DOES see it, and the ordinary arity comparison applies. Production
    // passes one argument, so `{1}` is a phantom.
    const key = 'ai-focused-editor/narrative-memory/diagnostic-broken-mention';
    expect(calls.has(key)).toBe(true);
    const broken: Translation[] = [
      { key, text: 'В рукописи нет сущности с именем «{0}» в файле {1}.', file: NARRATIVE }
    ];
    expect(overIndexOffenders(calls, broken)).not.toEqual([]);
    expect(subsetOffenders(calls, broken)).not.toEqual([]);
    // And the shipped text passes both, so the case above is about the break
    // rather than about the key.
    const shipped = translations.find(entry => entry.key === key)!;
    expect(overIndexOffenders(calls, [shipped])).toEqual([]);
    expect(subsetOffenders(calls, [shipped])).toEqual([]);
  });
});

describe('localized strings — English defaults never out-run their arguments', () => {
  test('every owned default\'s highest {N} is within the call\'s argument list', () => {
    const offenders: string[] = [];
    for (const [key, sites] of calls) {
      if (!owned(key)) {
        continue;
      }
      for (const site of sites) {
        if (site.argCount < 0) {
          continue;
        }
        const indices = placeholderIndices(site.def);
        if (indices.length > 0 && indices[indices.length - 1] >= site.argCount) {
          offenders.push(`${key} (${site.file}): args=${site.argCount} default="${site.def}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('localized strings — Russian translations never out-run their arguments (ISS-258, ISS-261)', () => {
  /**
   * THE core check. Russian is the product's primary locale, so a translation
   * that references an argument the call site does not pass is a user-visible
   * defect in the DEFAULT experience, not an edge case.
   *
   * TASK-020/F-QA3-2: checked against EVERY call site for the key, aggregated —
   * not just the first one the directory walk happened to meet.
   */
  test('every translation\'s {N} indices are a subset of some call site\'s English default', () => {
    expect(subsetOffenders(calls, translations)).toEqual([]);
  });

  test('no translation references an argument index the strictest call site never passes', () => {
    expect(overIndexOffenders(calls, translations)).toEqual([]);
  });

  test('no translation invents a number no call site ever measured', () => {
    // A hardcoded digit in a translation is the same defect wearing different
    // clothes: it reports a quantity that no argument backs. Digits that also
    // occur in SOME call site's English template are the translator legitimately
    // carrying a constant across.
    expect(inventedNumberOffenders(calls, translations)).toEqual([]);
  });

  test('every translation that carries a placeholder is actually referenced by the code', () => {
    // A dead key with a placeholder is invisible to every check above (there is
    // no call site to compare it against), yet it is precisely the shape that
    // rots into a raw `{0}` the day someone wires it up.
    //
    // Scoped to placeholder-bearing keys on purpose: ~30 translations are keyed
    // dynamically (`ai-focused-editor/create/type-${kind}`) and cannot be found
    // by a literal search — none of them carry a placeholder. A future dynamic
    // key that DOES would surface here, which is the right place to review it.
    const orphans = translations
      .filter(entry => placeholderIndices(entry.text).length > 0)
      // Match on the CLOSING quote so `.../adjacent-page` is not considered
      // referenced by a call to `.../adjacent-pages`.
      .filter(entry => !['\'', '"', '`'].some(quote => allSources.includes(entry.key + quote)))
      .map(entry => `${entry.file} :: ${entry.key} = "${entry.text}"`);

    expect(orphans).toEqual([]);
  });

  test('every placeholder-bearing translation has a scanned nls.localize(...) call site to check its arity against (QA/F-QA3-3)', () => {
    // The orphan check above only proves the key literal appears SOMEWHERE in
    // source (which a `Command.toLocalizedCommand(..., key)` registration also
    // satisfies). It does NOT prove the arity checks above ever looked at this
    // key — `subsetOffenders`/`overIndexOffenders`/`inventedNumberOffenders` all
    // silently `continue` past a key with no entry in `calls`. This guard makes
    // that silent skip loud: a placeholder-bearing key registered through any
    // non-`nls.localize(...)` path is flagged here instead of sailing through
    // unchecked.
    expect(unscannedPlaceholderOffenders(calls, translations)).toEqual([]);
  });
});

describe('localized strings — every typography rule really has its Russian text (CR/F-CR-3)', () => {
  /**
   * EXISTENCE, not arity. Everything above compares a translation that EXISTS
   * against its call site; nothing anywhere asserted that a rule's nls key
   * resolves to a Russian entry at all.
   *
   * The consequence is silent by construction. `buildTypographySchema`
   * (`common/typography/typography-rule-contribution.ts`) renders each rule's
   * settings description through
   * `nls.localize(rule.descriptionKey, `Auto-typography rule "${humanizeId(rule.id)}"`)`,
   * and `nls.localize` FALLS BACK to that English default when the key is
   * missing. So a 15th rule added to the canonical registry without a
   * dictionary entry ships a machine-generated English string —
   * «Auto-typography rule "Foo bar".» — into the settings UI of a
   * Russian-first product, with every test green. That is ISS-258's class
   * exactly ("all 2600+ tests stayed green, because every one of them asserted
   * on the English default"), one step earlier in the pipeline.
   *
   * The sibling test `typography-frontend-module.test.ts` only checks that the
   * key STARTS WITH `ai-focused-editor/typography/` — a well-formed key that
   * translates to nothing passes it.
   *
   * SCOPE, deliberately narrow: the typography rule registry, not "every owned
   * key has a Russian translation". The wider sweep is a different (and much
   * larger) piece of work — it would have to classify English-only diagnostic
   * strings, dynamic keys and third-party namespaces — and belongs in its own
   * request rather than smuggled in here.
   *
   * FIELD-AGNOSTIC on purpose: the check reads every `*Key` string field a rule
   * declares rather than naming `descriptionKey`. `TypographyRule` currently
   * declares exactly one (a `titleKey` existed and was removed in CR/F-CR-2 —
   * Theia never renders a per-property `title`), but a future second nls-keyed
   * field is then covered the day it is added instead of the day someone
   * remembers this file.
   */

  /** Every `<name>Key: string` field on a rule — the nls keys it renders through. */
  function nlsKeyFields(rule: object): Array<{ field: string; key: string }> {
    return Object.entries(rule)
      .filter(([field, value]) => field.endsWith('Key') && typeof value === 'string')
      .map(([field, value]) => ({ field, key: value as string }));
  }

  /** The keys the Russian dictionaries actually define, with non-blank text. */
  const russianKeys = new Set(translations.filter(entry => entry.text.trim().length > 0).map(entry => entry.key));

  test('every nls key of every canonical rule resolves to a non-empty Russian string', () => {
    const offenders: string[] = [];
    for (const rule of TYPOGRAPHY_RULES) {
      for (const { field, key } of nlsKeyFields(rule)) {
        if (!russianKeys.has(key)) {
          offenders.push(
            `rule "${rule.id}" — ${field} = "${key}" has no Russian entry in src/node/i18n/ru/, ` +
            'so the settings row falls back to the generated English default'
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the check is not vacuous: it really inspected every rule, descriptionKey included', () => {
    // An "assert no offenders" shape passes trivially if the registry import
    // resolves to nothing or if the field filter stops matching. Both failure
    // modes are red here instead of silently green above.
    expect(TYPOGRAPHY_RULES.length).toBeGreaterThan(0);
    const fields = new Set<string>();
    for (const rule of TYPOGRAPHY_RULES) {
      const found = nlsKeyFields(rule);
      // Every rule contributes at least one key to the check.
      expect(found.length).toBeGreaterThan(0);
      for (const { field } of found) {
        fields.add(field);
      }
    }
    // The one field the settings UI is known to render through.
    expect(fields.has('descriptionKey')).toBe(true);
    // …and the dictionary side of the comparison is populated.
    expect(russianKeys.size).toBeGreaterThan(1000);
  });
});

describe('localized strings — regression guards have teeth (QA/F-QA3-2, F-QA3-3, TASK-020)', () => {
  /**
   * These reproduce the two bug SHAPES directly against synthetic `calls`/
   * `translations` inputs and assert the PRODUCTION check functions
   * (`overIndexOffenders`, `subsetOffenders`, `unscannedPlaceholderOffenders`)
   * actually catch them.
   *
   * SCOPE, precisely (QA/F-QA1-3 — an earlier version of this comment claimed
   * more than the cases deliver): the synthetic inputs are hand-built `Map`s, so
   * `scanLocalizeCalls` never runs here. These cases give teeth to
   * `aggregateArity` and the offender functions ONLY. Reverting the COLLECTION
   * to one-site-per-key leaves every case below green — the end-to-end teeth on
   * the collection itself live in the fixture-tree suite that follows, which is
   * what actually goes red on that revert.
   *
   * Reverting `unscannedPlaceholderOffenders` to always return `[]` turns the
   * F-QA3-3 case red (verified — see task evidence).
   */

  test('F-QA3-2: a duplicate call site with a SMALLER arity is not shadowed by the first one scanned', () => {
    // Reproduces ISS-258's shape directly: the SAME key localized from two call
    // sites, the second one passing FEWER arguments than the first. A Russian
    // translation that only fits the first (larger-arity) site must still be
    // caught, because a shared translation has to satisfy BOTH call sites.
    const key = 'synthetic/duplicate-key-diverging-arity';
    const syntheticCalls = new Map<string, LocalizeCallSite[]>([
      [key, [
        { def: 'Wrote {0} file(s), {1} fix(es).', argCount: 2, file: 'synthetic/site-a.ts' },
        { def: 'Wrote {0} file(s).', argCount: 1, file: 'synthetic/site-b.ts' } // smaller-arity duplicate
      ]]
    ]);
    const syntheticTranslations: Translation[] = [
      { key, text: 'Записано {0} файл(ов), {1} исправление(й).', file: 'synthetic.json' }
    ];

    // Uses {1}, which site-b (argCount 1) never passes when the run reaches it.
    expect(overIndexOffenders(syntheticCalls, syntheticTranslations)).not.toEqual([]);
  });

  test('F-QA3-2 control: a translation that fits every call site\'s arity stays silent', () => {
    const key = 'synthetic/duplicate-key-matching-arity';
    const syntheticCalls = new Map<string, LocalizeCallSite[]>([
      [key, [
        { def: 'Wrote {0} file(s), {1} fix(es).', argCount: 2, file: 'synthetic/site-a.ts' },
        { def: 'Applied {0} file(s), {1} change(s).', argCount: 2, file: 'synthetic/site-b.ts' }
      ]]
    ]);
    const syntheticTranslations: Translation[] = [
      { key, text: 'Записано {0} файл(ов), {1} исправление(й).', file: 'synthetic.json' }
    ];
    expect(overIndexOffenders(syntheticCalls, syntheticTranslations)).toEqual([]);
    expect(subsetOffenders(syntheticCalls, syntheticTranslations)).toEqual([]);
  });

  test('F-QA1-4: a translation that MIXES indices from two different call sites matches neither and is flagged', () => {
    // Neither site offers both {0} and {1}; only their UNION does. Under the
    // old union rule this sailed through, yet at runtime the translation is
    // rendered by ONE of these calls and leaves a raw placeholder either way.
    const key = 'synthetic/indices-split-across-sites';
    const syntheticCalls = new Map<string, LocalizeCallSite[]>([
      [key, [
        { def: 'Read {0} file(s).', argCount: 2, file: 'synthetic/site-a.ts' },
        { def: 'Wrote {1} fix(es).', argCount: 2, file: 'synthetic/site-b.ts' }
      ]]
    ]);
    const syntheticTranslations: Translation[] = [
      { key, text: 'Прочитано {0}, записано {1}.', file: 'synthetic.json' }
    ];

    // Arities are fine (both sites pass 2), so ONLY the index check can catch it.
    expect(overIndexOffenders(syntheticCalls, syntheticTranslations)).toEqual([]);
    expect(subsetOffenders(syntheticCalls, syntheticTranslations)).not.toEqual([]);
  });

  test('F-QA1-4 control: a translation fully covered by ONE of several sites stays silent', () => {
    const key = 'synthetic/indices-covered-by-one-site';
    const syntheticCalls = new Map<string, LocalizeCallSite[]>([
      [key, [
        { def: 'Read {0} file(s).', argCount: 2, file: 'synthetic/site-a.ts' },
        { def: 'Read {0} file(s), wrote {1}.', argCount: 2, file: 'synthetic/site-b.ts' }
      ]]
    ]);
    const syntheticTranslations: Translation[] = [
      { key, text: 'Прочитано {0}, записано {1}.', file: 'synthetic.json' }
    ];
    expect(subsetOffenders(syntheticCalls, syntheticTranslations)).toEqual([]);
  });

  test('F-QA3-3: a placeholder-bearing translation with no nls.localize(...) call site is flagged', () => {
    // Simulates a key registered only via `Command.toLocalizedCommand(..., key)`
    // (or any other non-literal path): the scan never produces a `calls` entry.
    const syntheticCalls = new Map<string, LocalizeCallSite[]>();
    const syntheticTranslations: Translation[] = [
      { key: 'synthetic/command-only-key', text: 'Найдено {0} совпадений.', file: 'synthetic.json' }
    ];
    expect(unscannedPlaceholderOffenders(syntheticCalls, syntheticTranslations)).not.toEqual([]);
  });

  test('F-QA3-3 control: a placeholder-free translation with no call site is legitimate (dynamic keys) and stays silent', () => {
    const syntheticCalls = new Map<string, LocalizeCallSite[]>();
    const syntheticTranslations: Translation[] = [
      { key: 'synthetic/create/type-chapter', text: 'Глава', file: 'synthetic.json' }
    ];
    expect(unscannedPlaceholderOffenders(syntheticCalls, syntheticTranslations)).toEqual([]);
  });
});

describe('localized strings — the scanner keeps EVERY call site of a key (QA/F-QA3-2, end-to-end)', () => {
  /**
   * The teeth on the COLLECTION step, which the synthetic cases above cannot
   * reach: they hand-build the `Map` that `scanLocalizeCalls` is supposed to
   * produce, so reverting the scanner to one-site-per-key left them all green.
   *
   * This runs the REAL `scanLocalizeCalls` over a throwaway fixture tree holding
   * the same key at two call sites with DIFFERENT arities. Deduplicating to the
   * first site loses one of them, and the loss is red whichever site the
   * directory walk happens to meet first:
   *
   *   - keeping site A first  → only one site, `minArgCount` is 2, not 1;
   *   - keeping site B first  → only one site, the length assertion fails.
   *
   * so no assertion here depends on `readdirSync` ordering.
   *
   * The fixture MUST live in a temp directory, never under `src/`: anything
   * under `src/` is compiled by `tsc --noEmit` and swept up by the whole-repo
   * scan at the top of this module.
   */

  const KEY = 'fixture/two-sites-diverging-arity';
  /**
   * Assembled instead of written out, so the WHOLE-REPO scan at the top of this
   * module does not read this file's own fixture source as a live call site.
   */
  const CALLEE = `nls.${'localize'}`;
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'arity-scan-'));
    writeFileSync(
      join(fixtureDir, 'a-site.ts'),
      `export const a = ${CALLEE}('${KEY}', 'A {0} of {1}', first, second);\n`,
      'utf8'
    );
    writeFileSync(
      join(fixtureDir, 'b-site.ts'),
      `export const b = ${CALLEE}('${KEY}', 'B {0}', first);\n`,
      'utf8'
    );
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('both call sites of one key survive the scan, and the STRICTEST arity wins', () => {
    const { calls: scanned } = scanLocalizeCalls([fixtureDir]);

    const sites = scanned.get(KEY);
    expect(sites).toBeDefined();
    // The whole point: two sites, not one.
    expect(sites).toHaveLength(2);
    // Order-independent identity check, so neither assertion leans on the walk order.
    expect(new Set(sites!.map(site => site.def))).toEqual(new Set(['A {0} of {1}', 'B {0}']));
    expect(new Set(sites!.map(site => site.argCount))).toEqual(new Set([1, 2]));

    // The value a dedup silently destroys: the SMALLER arity, contributed by
    // whichever site the dedup would have thrown away.
    expect(aggregateArity(sites!).minArgCount).toBe(1);
  });

  test('a translation that only fits the wider site is caught end-to-end, scan included', () => {
    const { calls: scanned } = scanLocalizeCalls([fixtureDir]);
    const fixtureTranslations: Translation[] = [
      { key: KEY, text: 'A {0} из {1}', file: 'fixture.json' }
    ];

    // {1} exists in site A's English default (so the index check is satisfied)
    // but site B passes only ONE argument — exactly ISS-258's shape, and only
    // visible because the scan kept site B.
    expect(subsetOffenders(scanned, fixtureTranslations)).toEqual([]);
    expect(overIndexOffenders(scanned, fixtureTranslations)).not.toEqual([]);
  });

  test('the fixture scan reports a usable file path for a root outside the repository', () => {
    // `relative(REPO_ROOT, file)` rather than a `slice` of REPO_ROOT's length:
    // the latter silently mangles any path that is not under the repo root, and
    // an offender message naming a mangled file is worse than no message.
    const { calls: scanned } = scanLocalizeCalls([fixtureDir]);
    for (const site of scanned.get(KEY)!) {
      expect(site.file).toMatch(/(a-site|b-site)\.ts$/);
    }
  });
});

describe('localized strings — rendering the Russian batch messages for real (ISS-258)', () => {
  /**
   * The checks above are static. This one runs Theia's ACTUAL substitution over
   * the Russian text with the ACTUAL argument list the production call site
   * passes, and asserts on what a Russian user would read on screen.
   */
  const RU_TYPOGRAPHY: Record<string, string> = (() => {
    const flat = new Map<string, string>();
    flatten(JSON.parse(readFileSync(join(RU_DIR, 'typography.json'), 'utf8')), '', flat);
    return Object.fromEntries(flat);
  })();

  /** The `{0}` Theia leaves behind when an argument is missing. */
  function unsubstituted(rendered: string): string[] {
    return [...rendered.matchAll(/\{\d+\}/g)].map(match => match[0]);
  }

  test('CRITICAL: the over-the-cap warning renders with no raw placeholder and no phantom count', () => {
    // Production passes exactly one argument: the THRESHOLD (see
    // typography-commands.ts / common/typography/multi-file-limits.ts — the walk
    // aborts one past the cap, so the collected length is a number the run never
    // measured). QA/F-QA3-4: mirrors the REAL constant rather than a hardcoded
    // '500', so a future cap change cannot desync this test from production.
    const args = [String(MULTI_FILE_MAX)];
    const rendered = Localization.format(
      RU_TYPOGRAPHY['ai-focused-editor/typography/batch-files-too-many'],
      args
    );

    // (1) Nothing is left for the user to decode.
    expect(unsubstituted(rendered)).toEqual([]);
    // (2) The only number on screen is the one argument that was supplied.
    expect(rendered.match(/\d+/g)).toEqual([String(MULTI_FILE_MAX)]);
    // …and it is not vacuous: the message really did substitute something.
    expect(rendered).toContain(String(MULTI_FILE_MAX));
    expect(rendered).toContain('Markdown');
  });

  test('every Russian batch message renders cleanly with its production argument list', () => {
    // One entry per call site that reports a batch outcome, with the argument
    // count production actually passes.
    const callSites: Array<[string, string[]]> = [
      ['batch-applied', ['7']],
      ['batch-clean', []],
      ['batch-buffer-not-converged', []],
      ['batch-files-too-many', [String(MULTI_FILE_MAX)]],
      ['batch-files-preview', ['3', '12']],
      ['batch-files-write', ['3']],
      ['batch-files-more', ['4']],
      ['batch-files-applied', ['3', '12']],
      ['batch-files-dirty-skipped', ['2']],
      ['batch-files-skipped-changed', ['1']],
      ['batch-files-failed', ['1']],
      ['batch-files-not-converged', ['2']],
      ['batch-files-none', []],
      ['batch-files-cancelled', []],
      ['batch-files-read-failed', []],
      ['batch-open-editor', []],
      ['batch-select-text', []],
      ['batch-none-enabled', []]
    ];

    const offenders: string[] = [];
    for (const [suffix, args] of callSites) {
      const key = `ai-focused-editor/typography/${suffix}`;
      const template = RU_TYPOGRAPHY[key];
      if (template === undefined) {
        offenders.push(`${key} has no Russian translation — the user falls back to English`);
        continue;
      }
      const rendered = Localization.format(template, args);
      const leftover = unsubstituted(rendered);
      if (leftover.length > 0) {
        offenders.push(`${key} renders raw ${leftover.join(', ')} with ${args.length} argument(s): "${rendered}"`);
      }
      const shown = rendered.match(/\d+/g) ?? [];
      const unexplained = shown.filter(number => !args.includes(number) && !template.includes(number));
      if (unexplained.length > 0) {
        offenders.push(`${key} shows the unmeasured number(s) ${unexplained.join(', ')}: "${rendered}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
