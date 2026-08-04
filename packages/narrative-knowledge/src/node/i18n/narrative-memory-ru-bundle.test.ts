/**
 * ОВ-8 tooth 3 — every member of `IndexFailureCode` has a Russian phrase —
 * WIDENED IN WP-5 to the whole phrase catalog of the package.
 *
 * The test WALKS THE UNION and fails on the first missing key, rather than
 * checking a hand-written list of keys. That direction matters: a list would go
 * stale the moment someone adds a code, and the user would be shown a raw
 * identifier where a sentence belongs.
 *
 * The bundle FILE was created by WP-1, because the tooth is WP-1's, even though
 * the `LocalizationContribution` that registers it with Theia is WP-5's
 * delivery. WP-5 has now shipped that registration
 * (`narrative-memory-ru-localization-contribution.ts`) and, with it, four more
 * families of phrase: the three `staleReason`s, the six status headlines, the
 * Rebuild refusal reasons, and the labels of the two commands and five
 * preference keys.
 *
 * WHY THIS FILE GREW RATHER THAN GAINING A SIBLING. The original "no keys
 * BEYOND the union" case compared the bundle's leaf set against
 * `INDEX_FAILURE_CODES` alone. Every phrase WP-5 added made it red — correctly:
 * the bundle really did contain keys that check knew nothing about. The cheap
 * repair would have been to relax it to a subset check, which would have
 * deleted the only guard against dead translations. So the EXPECTED SET was
 * widened instead, to the catalog the surfaces actually render from, and the
 * check stayed an equality in both directions.
 */

import { describe, expect, test } from 'bun:test';
import {
  INDEX_FAILURE_CODES,
  NARRATIVE_MEMORY_NLS_PREFIX,
  NARRATIVE_MEMORY_PHRASES,
  NARRATIVE_MEMORY_TEMPLATED_PHRASES,
  indexFailureLocalizationKey
} from '../../common';
import bundle from './ru/narrative-memory.json';

/** The bundle is nested by key segment, the way Theia's `nls` bundles are. */
function lookup(key: string): unknown {
  const [namespace, domain, leaf] = key.split('/');
  const scope = (bundle as Record<string, Record<string, Record<string, unknown>>>)[namespace]?.[domain];
  return scope?.[leaf];
}

function leaves(): string[] {
  return Object.keys(
    (bundle as Record<string, Record<string, Record<string, unknown>>>)['ai-focused-editor']['narrative-memory']
  );
}

/** Every key the package promises a phrase for: arity-0 catalog + templated. */
const EXPECTED_KEYS = [
  ...NARRATIVE_MEMORY_PHRASES.map(entry => entry.key),
  ...NARRATIVE_MEMORY_TEMPLATED_PHRASES.map(entry => entry.key)
];

describe('ru bundle — index failures', () => {
  test('every IndexFailureCode has a non-empty phrase', () => {
    const missing = INDEX_FAILURE_CODES.filter(code => {
      const phrase = lookup(indexFailureLocalizationKey(code));
      return typeof phrase !== 'string' || phrase.trim().length === 0;
    });
    expect(missing).toEqual([]);
  });

  test('the bundle has no keys BEYOND the catalog — a phrase for nothing is dead text', () => {
    const expected = EXPECTED_KEYS.map(key => key.split('/')[2]);
    expect(leaves().sort()).toEqual([...expected].sort());
  });

  test('no phrase carries a substitution placeholder', () => {
    // ОВ-8's "who sees what" table puts the path and the occurrence count
    // BESIDE the phrase in Show Index Status, and keeps them OUT of the status
    // bar entirely — so the phrases are arity 0. A `{0}` here would render as
    // an empty pair of brackets whenever `relPath` is absent, which it is
    // exactly when the file lay outside the workspace.
    for (const code of INDEX_FAILURE_CODES) {
      expect(String(lookup(indexFailureLocalizationKey(code)))).not.toMatch(/\{\d+\}/);
    }
  });

  test('the incident id is never part of a phrase — a translator may reorder words', () => {
    for (const code of INDEX_FAILURE_CODES) {
      expect(String(lookup(indexFailureLocalizationKey(code))).toLowerCase()).not.toContain('incident');
    }
  });
});

describe('ru bundle — the WP-5 phrase catalog', () => {
  test('every catalog phrase has a non-empty Russian translation', () => {
    const missing = NARRATIVE_MEMORY_PHRASES.filter(entry => {
      const phrase = lookup(entry.key);
      return typeof phrase !== 'string' || phrase.trim().length === 0;
    }).map(entry => entry.key);
    expect(missing).toEqual([]);
  });

  test('every templated phrase has a non-empty Russian translation', () => {
    const missing = NARRATIVE_MEMORY_TEMPLATED_PHRASES.filter(entry => {
      const phrase = lookup(entry.key);
      return typeof phrase !== 'string' || phrase.trim().length === 0;
    }).map(entry => entry.key);
    expect(missing).toEqual([]);
  });

  test('NO catalog phrase carries a placeholder — the catalog is invisible to the arity guard', () => {
    // THE LOAD-BEARING CASE FOR THE SPLIT. The repository-wide placeholder
    // arity guard lexes source for `nls.localize(` with LITERAL arguments; a
    // key resolved out of `NARRATIVE_MEMORY_PHRASES` gives it neither, so a
    // `{0}` behind such a key would never be compared against the arguments any
    // call site passes — the precise blind spot that guard exists to close,
    // reintroduced one layer down. A phrase that needs a substitution belongs
    // in `NARRATIVE_MEMORY_TEMPLATED_PHRASES` and is written as a literal call
    // site in `src/browser`, where the guard sees both halves.
    const offenders = NARRATIVE_MEMORY_PHRASES.filter(entry =>
      /\{\d+\}/.test(String(lookup(entry.key) ?? entry.default))
    ).map(entry => entry.key);
    expect(offenders).toEqual([]);
  });

  test('EVERY templated phrase really carries a placeholder — otherwise it is in the wrong list', () => {
    // The other direction of the same split. A phrase parked in the templated
    // list with no `{N}` would be exempt from the check above for no reason,
    // and the exemption would spread by copy-paste.
    const offenders = NARRATIVE_MEMORY_TEMPLATED_PHRASES.filter(
      entry => !/\{\d+\}/.test(String(lookup(entry.key)))
    ).map(entry => entry.key);
    expect(offenders).toEqual([]);
  });

  test('the catalog is not vacuous and really is this package\'s namespace', () => {
    // Every check above is an "assert no offenders" shape, which passes
    // trivially over an empty catalog.
    expect(NARRATIVE_MEMORY_PHRASES.length).toBeGreaterThan(20);
    expect(NARRATIVE_MEMORY_TEMPLATED_PHRASES.length).toBeGreaterThan(0);
    for (const entry of [...NARRATIVE_MEMORY_PHRASES, ...NARRATIVE_MEMORY_TEMPLATED_PHRASES]) {
      expect(entry.key.startsWith(`${NARRATIVE_MEMORY_NLS_PREFIX}/`)).toBe(true);
      expect(entry.default.trim().length).toBeGreaterThan(0);
    }
  });

  test('no key is declared twice, in either list or across them', () => {
    expect(new Set(EXPECTED_KEYS).size).toBe(EXPECTED_KEYS.length);
  });
});
