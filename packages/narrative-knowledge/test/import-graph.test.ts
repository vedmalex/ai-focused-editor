/**
 * The layer rule of `@ai-focused-editor/narrative-knowledge`, enforced
 * (TASK-022 WP-0). Six prohibitions, evaluated TRANSITIVELY, each with its own
 * REJECTING CASE — and (e) with one per half, (f) in its deep-path form.
 *
 * A prohibition that has never been seen to fail is not known to work. So the
 * rejecting cases are not a manual ritual performed once at review time: each
 * one is a hand-built module graph fed to the same `checkImportGraph` the real
 * package is measured with, asserted RED, on every `bun run verify`. The real
 * package is asserted GREEN by the same function in the same run.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  checkImportGraph,
  extractImportSpecifiers,
  unresolvedImports,
  type ProhibitionId,
  type SourceModule
} from './import-graph';

const packageRoot = join(import.meta.dir, '..');
const sourceRoot = join(packageRoot, 'src');

/** Mirrors the package `tsconfig.json` `exclude` so the check and the compiler
 *  see the same production surface. */
function isProductionSource(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts');
}

function loadPackageModules(): SourceModule[] {
  const modules: SourceModule[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        if (entry !== 'node_modules' && entry !== 'lib') {
          walk(absolute);
        }
        continue;
      }
      if (isProductionSource(absolute)) {
        modules.push({
          path: relative(packageRoot, absolute).split(sep).join('/'),
          text: readFileSync(absolute, 'utf8')
        });
      }
    }
  };
  walk(sourceRoot);
  return modules;
}

const packageModules = loadPackageModules();

function rulesBroken(modules: SourceModule[]): ProhibitionId[] {
  return [...new Set(checkImportGraph(modules).map(violation => violation.rule))].sort();
}

// ---------------------------------------------------------------------------
// The real package
// ---------------------------------------------------------------------------

describe('layer rule — the real package', () => {
  test('the walk actually found the four layers (a green check over an empty set proves nothing)', () => {
    expect(packageModules.length).toBeGreaterThan(0);
    for (const layer of ['src/common/', 'src/common/graph/', 'src/node/', 'src/browser/']) {
      expect(packageModules.some(module => module.path.startsWith(layer))).toBe(true);
    }
  });

  test('every relative import resolves — an unresolvable edge is an invisible hole in the graph', () => {
    expect(unresolvedImports(packageModules)).toEqual([]);
  });

  test('no violation of any of the SIX prohibitions', () => {
    const violations = checkImportGraph(packageModules);
    expect(violations.map(violation => violation.message)).toEqual([]);
  });

  // The plan states this as a separate readiness item, and it is genuinely
  // separate: prohibition (f) looks at IMPORTS, this looks at TEXT. A stale
  // doc-comment pointing at the old home is not a build failure, but it is a
  // reader pointed at the wrong package, which is how the next relocation gets
  // planned against a fiction.
  test('the string "manuscript-workspace" appears nowhere under src/', () => {
    const offenders = packageModules
      .filter(module => module.text.includes('manuscript-workspace'))
      .map(module => module.path);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rejecting cases — one per prohibition, two for (e)
// ---------------------------------------------------------------------------

/** The graph core file every rejecting case for (e) starts from. */
const CORE = 'src/common/graph/graph-node.ts';

describe('rejecting case per prohibition', () => {
  test('(a) src/common reaching a node:* module — TRANSITIVELY, through two hops', () => {
    const modules: SourceModule[] = [
      { path: 'src/common/index.ts', text: "import { a } from './a';" },
      { path: 'src/common/a.ts', text: "import { b } from './b';" },
      { path: 'src/common/b.ts', text: "import { DatabaseSync } from 'node:sqlite';" }
    ];
    const violations = checkImportGraph(modules);
    expect(violations.some(v => v.rule === 'a' && v.file === 'src/common/index.ts')).toBe(true);
    // …and the chain names the real culprit, not just the entry point.
    const reported = violations.find(v => v.rule === 'a' && v.file === 'src/common/index.ts')!;
    expect(reported.chain).toEqual(['src/common/index.ts', 'src/common/a.ts', 'src/common/b.ts']);
    // Direct one-hop form is caught too.
    expect(rulesBroken([{ path: 'src/common/x.ts', text: "import { readFileSync } from 'fs';" }])).toContain('a');
  });

  test('(b) src/common reaching src/node — the same failure with an intermediary', () => {
    const modules: SourceModule[] = [
      { path: 'src/common/index.ts', text: "import { store } from './store-factory';" },
      { path: 'src/common/store-factory.ts', text: "import { SqliteStore } from '../node/sqlite-store';" },
      { path: 'src/node/sqlite-store.ts', text: 'export class SqliteStore {}' }
    ];
    expect(rulesBroken(modules)).toContain('b');
  });

  test('(c) src/common reaching a Theia frontend entrypoint — while @theia/core/lib/common stays legal', () => {
    expect(rulesBroken([
      { path: 'src/common/x.ts', text: "import { StatusBar } from '@theia/core/lib/browser';" }
    ])).toContain('c');

    expect(rulesBroken([
      { path: 'src/common/x.ts', text: "import { Disposable } from '@theia/core/lib/common';" }
    ])).not.toContain('c');
  });

  test('(d) the index-building path reaching an AI client — in src/node as well as src/common', () => {
    expect(rulesBroken([
      { path: 'src/common/extract.ts', text: "import { chat } from '@ai-focused-editor/ai-connect-theia';" }
    ])).toContain('d');

    expect(rulesBroken([
      { path: 'src/node/indexer.ts', text: "import { LanguageModel } from '@theia/ai-core';" }
    ])).toContain('d');

    // src/browser is OUTSIDE (d) on purpose: WP-6's tool providers READ the
    // index, they do not build it. This half of the rule is as load-bearing as
    // the other — a (d) that also covered src/browser would block WP-6.
    expect(rulesBroken([
      { path: 'src/browser/tool-provider.ts', text: "import { LanguageModel } from '@theia/ai-core';" }
    ])).not.toContain('d');
  });

  test('(e) half 1 — the graph core importing URI from @theia/core/lib/common: legal under (c), RED under (e)', () => {
    const modules: SourceModule[] = [
      { path: CORE, text: "import URI from '@theia/core/lib/common/uri';\nexport interface N { uri: URI }" }
    ];
    const broken = rulesBroken(modules);
    expect(broken).toContain('e1');
    // The point of this case: it passes every other prohibition. If (e) did
    // not exist, this import would be green.
    expect(broken).toEqual(['e1']);
  });

  test('(e) half 1 is stated BY COMPLEMENT — a package nobody has enumerated is red too', () => {
    const broken = rulesBroken([
      { path: CORE, text: "import { thing } from 'some-package-invented-after-this-rule-was-written';" }
    ]);
    expect(broken).toContain('e1');
  });

  test('(e) half 2 — the graph core importing IndexState from src/common/index-state.ts', () => {
    const modules: SourceModule[] = [
      { path: CORE, text: "import type { IndexState } from '../index-state';\nexport interface N { s: IndexState }" },
      { path: 'src/common/index-state.ts', text: "export type IndexState = { state: 'ready' };" }
    ];
    const broken = rulesBroken(modules);
    // This import breaks NONE of the four foreign-ecosystem enumerations —
    // it is not node:*, not src/node, not @theia/*, not an AI client. Half 2
    // is the only thing that catches it, so without half 2 the separability
    // of the core would be a word.
    expect(broken).toEqual(['e2']);
  });

  test('(e) allows the reverse direction: src/common importing FROM graph/', () => {
    const modules: SourceModule[] = [
      { path: 'src/common/index.ts', text: "export * from './graph';" },
      { path: 'src/common/graph/index.ts', text: "export * from './graph-node';" },
      { path: CORE, text: 'export interface NarrativeGraphNode { id: string }' }
    ];
    expect(rulesBroken(modules)).toEqual([]);
  });

  test('(f) DEEP SOURCE PATH into the manuscript workspace package — the form that actually occurs', () => {
    // This is verbatim how `obsidian-plugin` imported the registry before this
    // relocation. A check that looked at `dependencies`, or at the bare package
    // name alone, would NOT see it — so the deep form is the mandatory case.
    const deep = '@ai-focused-editor/manuscript-workspace/src/common/entity-type-registry';
    expect(rulesBroken([
      { path: 'src/common/extract.ts', text: `import type { EffectiveEntityType } from '${deep}';` }
    ])).toContain('f');
  });

  test('(f) bare package name, and from ANY of the four layers, TRANSITIVELY', () => {
    for (const layer of ['src/common', 'src/common/graph', 'src/node', 'src/browser']) {
      const modules: SourceModule[] = [
        { path: `${layer}/entry.ts`, text: "import { x } from './hop';" },
        { path: `${layer}/hop.ts`, text: "import { y } from '@ai-focused-editor/manuscript-workspace';" }
      ];
      expect(rulesBroken(modules)).toContain('f');
    }
  });
});

// ---------------------------------------------------------------------------
// The analyser's own teeth
// ---------------------------------------------------------------------------

describe('specifier extraction', () => {
  test('sees type-only, multi-line, re-export, side-effect, dynamic and require forms', () => {
    const text = [
      "import type { A } from 'pkg-type';",
      'import {',
      '  B,',
      '  C',
      "} from 'pkg-multiline';",
      "export * from 'pkg-reexport';",
      "export { D } from 'pkg-named-reexport';",
      "import 'pkg-side-effect';",
      "const e = await import('pkg-dynamic');",
      "const f = require('pkg-require');"
    ].join('\n');
    expect(extractImportSpecifiers(text).sort()).toEqual([
      'pkg-dynamic',
      'pkg-multiline',
      'pkg-named-reexport',
      'pkg-reexport',
      'pkg-require',
      'pkg-side-effect',
      'pkg-type'
    ]);
  });

  test('a multi-line import does not swallow the import that follows it', () => {
    // The failure mode this guards: an `import[\s\S]*?from` pattern matches
    // from the FIRST import across the second and reports only one specifier.
    const text = [
      'import {',
      '  A',
      "} from 'first';",
      "import { B } from 'node:sqlite';"
    ].join('\n');
    expect(extractImportSpecifiers(text).sort()).toEqual(['first', 'node:sqlite']);
  });

  test('a forbidden package NAMED IN A COMMENT is not an import', () => {
    const text = [
      '/**',
      " * Do not import '@ai-focused-editor/manuscript-workspace' from here.",
      ' */',
      "import { ok } from './ok';",
      "// import { bad } from 'node:sqlite';"
    ].join('\n');
    expect(extractImportSpecifiers(text)).toEqual(['./ok']);
  });

  test('Array.from("x") is not an import', () => {
    expect(extractImportSpecifiers("const a = Array.from('abc');")).toEqual([]);
  });
});
