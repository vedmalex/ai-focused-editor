/**
 * The import-graph analyser behind this package's layer rule (TASK-022 WP-0).
 *
 * The rule itself — SIX prohibitions, both halves of (e), the deep form of (f)
 * — is stated once, in `plan.md`, section "Слои пакета и правило импортов".
 * This module is its MACHINE FORM and nothing else; it does not restate the
 * reasoning, it enforces it.
 *
 * WHY AN ANALYSER AND NOT A GREP. A flat grep sees one literal in one file. It
 * cannot see that `src/common/a.ts` imports `./b`, which imports `./c`, which
 * imports `node:sqlite` — and the transitive path is the interesting one,
 * because that is how a boundary actually erodes. Every prohibition below is
 * therefore evaluated over the REACHABLE set of a file, not its own import
 * list, and each violation carries the chain that produced it.
 *
 * WHY IT LIVES IN `test/` AND NOT `src/`. It reads the filesystem, so it would
 * violate prohibition (a) if it sat in `src/common`, and it is not product
 * code, so it has no business shipping in `lib`. `tsconfig.json` includes only
 * `src`, so this file is invisible to the package build by construction.
 */

import { builtinModules } from 'node:module';

/** One source file of the package, as the analyser sees it. */
export interface SourceModule {
  /** Package-relative POSIX path, e.g. `src/common/graph/graph-node.ts`. */
  path: string;
  /** Raw source text. */
  text: string;
}

/** The six prohibitions, plus the two halves (e) is split into. */
export type ProhibitionId = 'a' | 'b' | 'c' | 'd' | 'e1' | 'e2' | 'f';

export interface Violation {
  /** Which prohibition was broken. */
  rule: ProhibitionId;
  /** The file IN SCOPE of the prohibition (may differ from where the bad
   *  import literally sits — that is the point of transitivity). */
  file: string;
  /** The offending import specifier. */
  specifier: string;
  /** Internal import chain from `file` to the file carrying `specifier`.
   *  A single-element chain means the import is direct. */
  chain: string[];
  /** Human-readable explanation, for the assertion message. */
  message: string;
}

/** A relative import that resolves to no file in the package. Not one of the
 *  six prohibitions — but an unresolvable edge is an invisible hole in the
 *  graph, so every check below would silently under-report without it. */
export interface UnresolvedImport {
  file: string;
  specifier: string;
}

// --------------------------------------------------------------------------
// Specifier extraction
// --------------------------------------------------------------------------

/**
 * Specifier patterns.
 *
 * Anchoring on `from '...'` rather than on `import ... from '...'` is
 * deliberate: a multi-line import list makes any `import[\s\S]*?from` pattern
 * able to swallow the NEXT import statement whole, and the swallowed one then
 * goes unseen — a false-negative in the check whose entire job is not to have
 * any. The `(?<![.\w$])` guard keeps `Array.from('abc')` out.
 *
 * `import type ... from` needs no separate pattern (same syntax), and a
 * type-only import still counts: an erased import still names a dependency the
 * boundary is about.
 */
const IMPORT_PATTERNS: readonly RegExp[] = [
  /(?<![.\w$])from\s*['"]([^'"]+)['"]/g,
  /(?<![.\w$])import\s*['"]([^'"]+)['"]/g,
  /(?<![.\w$])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?<![.\w$])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
];

/** Every module specifier `text` imports, in no particular order, deduplicated. */
export function extractImportSpecifiers(text: string): string[] {
  const stripped = stripComments(text);
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripped)) !== null) {
      found.add(match[1]);
    }
  }
  return [...found];
}

/**
 * Blank out comments so a specifier NAMED IN PROSE is not read as an import.
 * Comments in this package discuss forbidden packages on purpose (that is how
 * the boundary stays understandable); treating those mentions as imports would
 * make the analyser fail on its own documentation.
 *
 * Replacement preserves length and newlines, so nothing else shifts.
 */
function stripComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const two = text.slice(index, index + 2);
    if (two === '//') {
      const end = text.indexOf('\n', index);
      const stop = end < 0 ? text.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
      continue;
    }
    out += text[index];
    index++;
  }
  return out;
}

// --------------------------------------------------------------------------
// Internal resolution
// --------------------------------------------------------------------------

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const stack: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!absolute) {
        stack.push('..');
      }
      continue;
    }
    stack.push(part);
  }
  return (absolute ? '/' : '') + stack.join('/');
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Resolve a relative specifier against `fromPath`, TypeScript-style. */
export function resolveRelative(fromPath: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  const base = normalize(`${dirname(fromPath)}/${specifier}`);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (known.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

interface ModuleGraph {
  /** file -> internal files it imports directly */
  internal: Map<string, string[]>;
  /** file -> external specifiers it imports directly */
  external: Map<string, string[]>;
  unresolved: UnresolvedImport[];
}

function buildGraph(modules: readonly SourceModule[]): ModuleGraph {
  const known = new Set(modules.map(module => module.path));
  const internal = new Map<string, string[]>();
  const external = new Map<string, string[]>();
  const unresolved: UnresolvedImport[] = [];

  for (const module of modules) {
    const internalTargets: string[] = [];
    const externalTargets: string[] = [];
    for (const specifier of extractImportSpecifiers(module.text)) {
      if (isRelative(specifier)) {
        const resolved = resolveRelative(module.path, specifier, known);
        if (resolved) {
          internalTargets.push(resolved);
        } else {
          unresolved.push({ file: module.path, specifier });
        }
      } else {
        externalTargets.push(specifier);
      }
    }
    internal.set(module.path, internalTargets);
    external.set(module.path, externalTargets);
  }
  return { internal, external, unresolved };
}

/** Every internal file reachable from `start` (including `start`), with the
 *  shortest chain that reaches it. */
function reachableChains(graph: ModuleGraph, start: string): Map<string, string[]> {
  const chains = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const chain = chains.get(current)!;
    for (const next of graph.internal.get(current) ?? []) {
      if (!chains.has(next)) {
        chains.set(next, [...chain, next]);
        queue.push(next);
      }
    }
  }
  return chains;
}

// --------------------------------------------------------------------------
// The six prohibitions
// --------------------------------------------------------------------------

const NODE_BUILTINS = new Set(builtinModules);

/** (a) Any `node:*` import — and, since the reason is "`bun` does not resolve
 *  it", the un-prefixed builtin spellings of the same modules. The list comes
 *  from the RUNTIME (`builtinModules`), never from a hand-kept array. */
function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) {
    return true;
  }
  const head = specifier.split('/')[0];
  return NODE_BUILTINS.has(head);
}

/** (c) A frontend-only Theia entrypoint. `@theia/core/lib/common` is allowed
 *  in `src/common` and deliberately not matched here. */
function isTheiaBrowserEntry(specifier: string): boolean {
  return /^@theia\/[^/]+\/lib\/browser(\/|$)/.test(specifier);
}

/**
 * (d) AI/LLM clients anywhere on the INDEX-BUILDING path.
 *
 * This is the ONE prohibition the plan states by ENUMERATION rather than by
 * complement ("`ai-connect-theia`, `@theia/ai-*` и любого LLM-клиента"), and
 * an enumeration decays: a client nobody listed passes. The named-vendor set
 * below is therefore the WEAK part of this check and is documented as such —
 * the load-bearing parts are the two structural patterns above it, which do
 * not need maintenance.
 */
const LLM_CLIENT_PACKAGES: ReadonlySet<string> = new Set([
  'openai',
  'ollama',
  'cohere-ai',
  'langchain',
  'replicate',
  'groq-sdk'
]);

function isAiClient(specifier: string): boolean {
  if (specifier.startsWith('@theia/ai-')) {
    return true;
  }
  if (specifier.includes('ai-connect')) {
    return true;
  }
  if (specifier.startsWith('@anthropic-ai/') || specifier.startsWith('@langchain/') || specifier.startsWith('@google/generative-ai')) {
    return true;
  }
  return LLM_CLIENT_PACKAGES.has(specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'));
}

/** (f) The manuscript workspace package — BY PACKAGE NAME **or** by a deep
 *  path into its sources. The deep form is the one that actually occurs in
 *  this repository, and a `dependencies`-based check would not see it. */
const FORBIDDEN_PACKAGE = '@ai-focused-editor/manuscript-workspace';

function isForbiddenPackage(specifier: string): boolean {
  return specifier === FORBIDDEN_PACKAGE || specifier.startsWith(`${FORBIDDEN_PACKAGE}/`);
}

const inCommon = (path: string) => path.startsWith('src/common/');
const inGraph = (path: string) => path.startsWith('src/common/graph/');
const inNode = (path: string) => path.startsWith('src/node/');
/** (d)'s scope is WIDER than `src/common`: an AI call can hide in the backend
 *  half of the indexer too. `src/browser` is excluded deliberately — the WP-6
 *  tool providers READ the index, they do not BUILD it. */
const onIndexBuildPath = (path: string) => inCommon(path) || inNode(path);

/**
 * Check every prohibition over `modules` and return all violations.
 *
 * Pure: it takes the module set as data, which is what lets the rejecting
 * cases feed it a hand-built graph instead of writing a deliberately broken
 * file into the package and hoping to remember to delete it.
 */
export function checkImportGraph(modules: readonly SourceModule[]): Violation[] {
  const graph = buildGraph(modules);
  const violations: Violation[] = [];

  const externalRule = (
    rule: ProhibitionId,
    inScope: (path: string) => boolean,
    forbidden: (specifier: string) => boolean,
    describe: (specifier: string) => string
  ) => {
    for (const module of modules) {
      if (!inScope(module.path)) {
        continue;
      }
      for (const [reached, chain] of reachableChains(graph, module.path)) {
        for (const specifier of graph.external.get(reached) ?? []) {
          if (forbidden(specifier)) {
            violations.push({
              rule,
              file: module.path,
              specifier,
              chain,
              message: `(${rule}) ${module.path} reaches ${describe(specifier)} via ${chain.join(' -> ')}`
            });
          }
        }
      }
    }
  };

  // (a) src/common must not reach a Node builtin.
  externalRule('a', inCommon, isNodeBuiltin, spec => `Node builtin '${spec}'`);

  // (c) src/common must not reach a Theia frontend entrypoint.
  externalRule('c', inCommon, isTheiaBrowserEntry, spec => `Theia browser entry '${spec}'`);

  // (d) the index-building path must not reach an AI/LLM client.
  externalRule('d', onIndexBuildPath, isAiClient, spec => `AI client '${spec}'`);

  // (f) NOTHING in the package, in any of the four layers, may reach the
  //     manuscript workspace package — by name or by deep source path.
  externalRule('f', () => true, isForbiddenPackage, spec => `forbidden package path '${spec}'`);

  // (b) src/common must not reach src/node (transitively — the direct form is
  //     just the one-hop case).
  for (const module of modules) {
    if (!inCommon(module.path)) {
      continue;
    }
    for (const [reached, chain] of reachableChains(graph, module.path)) {
      if (inNode(reached)) {
        violations.push({
          rule: 'b',
          file: module.path,
          specifier: reached,
          chain,
          message: `(b) ${module.path} reaches src/node module ${reached} via ${chain.join(' -> ')}`
        });
      }
    }
  }

  // (e) The graph core's boundary, closed on BOTH sides.
  for (const module of modules) {
    if (!inGraph(module.path)) {
      continue;
    }
    // Half 1 — FOREIGN ECOSYSTEMS, stated BY COMPLEMENT: the core may import
    // NOTHING but modules inside `src/common/graph/`. Anything with a
    // non-relative specifier is therefore red, INCLUDING packages that do not
    // exist in this repository yet. An enumeration would have to be extended
    // for every new neighbour, and would be green until someone remembered.
    for (const specifier of graph.external.get(module.path) ?? []) {
      violations.push({
        rule: 'e1',
        file: module.path,
        specifier,
        chain: [module.path],
        message: `(e1) graph core ${module.path} imports '${specifier}'; the core may import nothing outside src/common/graph/`
      });
    }
    // Half 2 — NEIGHBOURS INSIDE `src/common`. Without this half the core
    // could accumulate any number of sibling dependencies and stay green,
    // while those dependencies are EXACTLY what the cost of lifting the folder
    // consists of.
    for (const target of graph.internal.get(module.path) ?? []) {
      if (!inGraph(target)) {
        violations.push({
          rule: 'e2',
          file: module.path,
          specifier: target,
          chain: [module.path, target],
          message: `(e2) graph core ${module.path} imports ${target}, which is outside src/common/graph/`
        });
      }
    }
  }

  return violations;
}

/** Relative imports that resolve to nothing — see {@link UnresolvedImport}. */
export function unresolvedImports(modules: readonly SourceModule[]): UnresolvedImport[] {
  return buildGraph(modules).unresolved;
}
