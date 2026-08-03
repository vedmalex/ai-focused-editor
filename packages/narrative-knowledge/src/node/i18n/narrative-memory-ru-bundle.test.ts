/**
 * ОВ-8 tooth 3 — every member of `IndexFailureCode` has a Russian phrase.
 *
 * The test WALKS THE UNION and fails on the first missing key, rather than
 * checking a hand-written list of keys. That direction matters: a list would go
 * stale the moment someone adds a code, and the user would be shown a raw
 * identifier where a sentence belongs.
 *
 * The bundle FILE is created here because the tooth is WP-1's, even though the
 * `LocalizationContribution` that registers it with Theia is WP-5's delivery.
 * Nothing here binds anything — it is a JSON file and an assertion over it.
 */

import { describe, expect, test } from 'bun:test';
import { INDEX_FAILURE_CODES, indexFailureLocalizationKey } from '../../common';
import bundle from './ru/narrative-memory.json';

/** The bundle is nested by key segment, the way Theia's `nls` bundles are. */
function lookup(key: string): unknown {
  const [namespace, domain, leaf] = key.split('/');
  const scope = (bundle as Record<string, Record<string, Record<string, unknown>>>)[namespace]?.[domain];
  return scope?.[leaf];
}

describe('ru bundle — index failures', () => {
  test('every IndexFailureCode has a non-empty phrase', () => {
    const missing = INDEX_FAILURE_CODES.filter(code => {
      const phrase = lookup(indexFailureLocalizationKey(code));
      return typeof phrase !== 'string' || phrase.trim().length === 0;
    });
    expect(missing).toEqual([]);
  });

  test('the bundle has no keys BEYOND the union — a phrase for a code that does not exist is dead text', () => {
    const leaves = Object.keys(
      (bundle as Record<string, Record<string, Record<string, unknown>>>)['ai-focused-editor']['narrative-memory']
    );
    const expected = INDEX_FAILURE_CODES.map(code => indexFailureLocalizationKey(code).split('/')[2]);
    expect(leaves.sort()).toEqual([...expected].sort());
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
