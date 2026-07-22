/**
 * The release chain must CONTAIN strict (tech_spec §1.4, §F.4, WP-2).
 *
 * The scenario being defended against is not "somebody sets `--coverage=warn`
 * in `build`" — that is the obvious half. It is the quiet half: an edit that
 * DROPS the flag, or a `build:dev` that slowly diverges from `build` by more
 * than the flag, so the prototype gate ends up verifying a chain nobody ships.
 * Both halves are invisible to every other test in this repository, because
 * every other test runs the generator directly.
 *
 * The chain is expanded TRANSITIVELY: `build` says `bun run docs:strict`, which
 * says `bun run docs:gen:strict`, which is where the flag actually lives. An
 * assertion over the raw `build` string would pass on a `docs:strict` that no
 * longer mentions the mode at all.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';

const PACKAGE_ROOT = join(import.meta.dir, '..');

async function scripts(): Promise<Record<string, string>> {
  const manifest = JSON.parse(await fs.readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  return manifest.scripts as Record<string, string>;
}

/**
 * One flat command line: every `bun run <name>` token replaced by the body of
 * `<name>`, recursively. A cycle terminates rather than hanging — a broken
 * `package.json` should fail this test, not the whole test run.
 */
function flatten(all: Record<string, string>, name: string, seen: Set<string> = new Set()): string {
  if (seen.has(name)) {
    return `<cycle:${name}>`;
  }
  const body = all[name];
  if (body === undefined) {
    return `<missing:${name}>`;
  }
  const next = new Set(seen).add(name);
  return body
    .split('&&')
    .map(step => {
      const match = step.trim().match(/^bun run ([\w:.-]+)$/);
      return match ? flatten(all, match[1], next) : step.trim();
    })
    .join(' && ');
}

describe('the build chain (§1.4)', () => {
  test('1: the release chain CONTAINS --coverage=strict', async () => {
    expect(flatten(await scripts(), 'build')).toContain('--coverage=strict');
  });

  test('2: the release chain does NOT contain --coverage=warn', async () => {
    expect(flatten(await scripts(), 'build')).not.toContain('--coverage=warn');
  });

  test('3: the canonical step order — inventory, then generator, then tsc (§2a/F-D2-3)', async () => {
    const flat = flatten(await scripts(), 'build');
    const inventory = flat.indexOf('extract-feature-inventory.mjs');
    const generator = flat.indexOf('generate-docs-content.mjs');
    const compile = flat.indexOf('tsc');
    expect(inventory).toBeGreaterThanOrEqual(0);
    expect(generator).toBeGreaterThan(inventory);
    expect(compile).toBeGreaterThan(generator);
  });

  test('4: the dev chain contains warn and NOT strict — group D must stay unblocked', async () => {
    const flat = flatten(await scripts(), 'build:dev');
    expect(flat).toContain('--coverage=warn');
    expect(flat).not.toContain('--coverage=strict');
  });

  test('5: the two chains are IDENTICAL apart from the mode token', async () => {
    // Without this, assertion 1 holds while `build:dev` quietly stops doing what
    // `build` does — and the prototype gate verifies a chain nobody ships.
    const all = await scripts();
    const strip = (value: string): string => value.replace(/--coverage=\w+/g, '--coverage=<mode>');
    expect(strip(flatten(all, 'build:dev'))).toBe(strip(flatten(all, 'build')));
  });

  test('6: no traversal glob leaked back into the scripts (§1.5, F-D5-10)', async () => {
    // Roots, excludes, order and hash live in `src/node/docs/source-scan.ts`.
    // A second glob list would let the extractor and the generator cover
    // different files while their fingerprints still agreed.
    for (const name of ['extract-feature-inventory.mjs', 'generate-docs-content.mjs']) {
      const text = await fs.readFile(join(import.meta.dir, name), 'utf8');
      expect(text).not.toContain('src/**/*.ts');
      expect(text).not.toMatch(/readdirSync?\(/);
    }
  });

  test('`compile` is the pre-existing `build` verbatim — this task changed no compilation step', async () => {
    const compile = (await scripts()).compile;
    expect(compile).toBe(
      'rm -rf lib && tsc && mkdir -p lib/browser/themes && cp src/browser/themes/*.json lib/browser/themes/ && ' +
        'mkdir -p lib/node/i18n/ru && cp src/node/i18n/ru/*.json lib/node/i18n/ru/ && ' +
        'mkdir -p lib/node/ai && cp src/node/ai/*.yaml lib/node/ai/'
    );
  });

  test('`clean` removes BOTH generated artifacts, or it does not clean', async () => {
    const clean = (await scripts()).clean;
    expect(clean).toContain('docs-inventory.generated.json');
    expect(clean).toContain('src/browser/docs/docs-content.generated.ts');
  });

  test('`watch` regenerates first — `tsc -w` cannot start without the generated module', async () => {
    expect(flatten(await scripts(), 'watch')).toContain('generate-docs-content.mjs');
  });
});
