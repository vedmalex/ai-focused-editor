/**
 * The GATES are composed the way they claim to be (gh#89).
 *
 * WHY A TEST ABOUT `package.json` EARNS ITS PLACE. gh#48 WP-2 shipped with
 * `typecheck:narrative-knowledge` RED, and nothing noticed for a whole work
 * package: the port grew three methods, the test doubles of that port did not,
 * and the only lane that would have said so was reachable exclusively from
 * `bun run verify` — the most expensive script in the repository and therefore
 * the least often run. The build could not catch it either, because
 * `tsconfig.json` excludes `*.test.ts` on purpose, so a test double never
 * reaches `tsc` on the build path at all.
 *
 * The repair is a composition — `test` now runs the typechecks — and a
 * composition is exactly the kind of thing that decays silently. This file is
 * the registry-as-code discipline the repository already applies to marker
 * owners and tool ids, applied to the gates: the rule lives in an assertion
 * rather than in somebody's memory of why the line is there.
 *
 * IT ASSERTS THE COMPOSITION, NOT THE WORDING. Each case checks that one script
 * REACHES another, so renaming an inner step or reordering the chain is free;
 * dropping a step is not.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function scriptsOf(packageDir: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, packageDir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

const ROOT = scriptsOf('.');

/** Every script `name` reaches, following `bun run <other>` transitively. */
function reachableFrom(name: string, scripts: Record<string, string> = ROOT): Set<string> {
  const seen = new Set<string>();
  const walk = (current: string): void => {
    if (seen.has(current)) {
      return;
    }
    seen.add(current);
    const body = scripts[current];
    if (body === undefined) {
      return;
    }
    for (const match of body.matchAll(/bun run ([\w:-]+)/g)) {
      walk(match[1]!);
    }
  };
  walk(name);
  return seen;
}

describe('the cheap gate covers the typechecks (gh#89)', () => {
  test('`test` reaches every per-package typecheck', () => {
    const reached = reachableFrom('test');
    // Named individually rather than as "some script starting with typecheck":
    // a package whose typecheck is added later and wired nowhere is exactly the
    // failure this file exists for, and it must be a visible edit HERE.
    expect(reached.has('typecheck:narrative-knowledge')).toBe(true);
    expect(reached.has('typecheck:obsidian')).toBe(true);
  });

  test('`verify` still reaches them, through `test` rather than beside it', () => {
    const reached = reachableFrom('verify');
    expect(reached.has('typecheck:narrative-knowledge')).toBe(true);
    expect(reached.has('typecheck:obsidian')).toBe(true);
    // PAIRED NEGATIVE: `verify` must not name them a second time. A duplicated
    // step is not wrong, it is a SECOND PLACE that can drift out of step with
    // the first — which is how the original gap was born.
    expect(ROOT.verify).not.toContain('typecheck:narrative-knowledge');
  });

  test('every test lane `verify` runs is reachable from `test` too', () => {
    // The property that actually matters: `bun run test` is the gate a person
    // runs, so anything `verify` proves about the code — as opposed to about a
    // built application — has to be reachable from it. The UI/Electron smokes
    // are deliberately NOT: they need a bundled app.
    const fromTest = reachableFrom('test');
    for (const lane of ['test:packages', 'test:widget', 'test:typography', 'test:scripts', 'test:narrative-index']) {
      expect(fromTest.has(lane)).toBe(true);
    }
  });
});

describe('the typechecks cannot be fooled by stale incremental state (gh#89)', () => {
  test('each typecheck clears `*.tsbuildinfo` before running', () => {
    // The trap this closes: `tsc` reusing build info skips files, so a run can
    // come back green locally and red on a clean checkout. The rule used to be
    // a verbal one ("clear it first"), which is another way of saying nobody
    // does it under pressure.
    for (const dir of ['packages/narrative-knowledge', 'packages/obsidian-plugin']) {
      const typecheck = scriptsOf(dir).typecheck;
      expect(typecheck).toBeDefined();
      expect(typecheck).toContain('tsbuildinfo');
    }
  });

  test('the narrative-knowledge typecheck really is the config that INCLUDES tests', () => {
    // The whole point of the lane: `tsconfig.json` excludes `*.test.ts`, so a
    // typecheck pointed at it would be green over exactly the files that broke.
    expect(scriptsOf('packages/narrative-knowledge').typecheck).toContain('tsconfig.typecheck.json');
    const config = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/narrative-knowledge/tsconfig.typecheck.json'), 'utf8')
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n')
    ) as { include?: string[] };
    expect(config.include).toContain('test');
    expect(config.include).toContain('src');
  });
});
