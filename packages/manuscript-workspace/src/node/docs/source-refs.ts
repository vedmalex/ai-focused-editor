/**
 * Source-ref hashing (TASK-018 tech_spec §3 WP-U4-1).
 *
 * A docs page declares, in its frontmatter, WHICH product sources it documents,
 * at one of three granularities. This module turns one such declaration into a
 * stable hash the drift gate compares against a committed baseline:
 *
 *  - `{path}`          — the whole file's bytes (coarsest; every edit drifts).
 *  - `{path, symbol}`  — the text of ONE named declaration (a noisy file can be
 *                        pinned to just the symbol the page actually describes).
 *  - `{path, mode}`    — an `agent`/mode's user-visible SIGNATURE from a YAML
 *                        modes file (label/description/systemPrompt), so a page
 *                        drifts only when the agent's identity changes, not when
 *                        an unrelated mode in the same file is edited.
 *
 * WHY `src/node/`: this reads files and imports `crypto`, so by Theia convention
 * it must not live in `src/common/**` (which the browser layer also imports).
 * It is consumed only by the two build scripts, never at runtime.
 *
 * The `{path, mode}` branch computes the mode signature through the SINGLE
 * shared `computeAgentSignature` helper in `src/common/ai/agent-signature.ts`,
 * the very function the browser runtime uses to decide whether to re-register a
 * chat agent — so the docs drift check and the runtime can never disagree on
 * what an agent's identity is (tech_spec §1, F-D1.1-3 / R1).
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type * as ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { computeAgentSignature } from '../../common/ai/agent-signature';

/**
 * `typescript` is imported LAZILY (dynamic `import`), NOT at module top level.
 *
 * The full TS compiler is a heavy module (tens of MB, seconds to initialise). It
 * is needed ONLY by the `{path, symbol}` branch below. Because this module is
 * imported by `generate-docs-content.mjs` — a script the docs test suite spawns
 * as a fresh subprocess HUNDREDS of times — an eager top-level `import` would
 * load the compiler in every one of those spawns, whether or not a symbol ref is
 * ever hashed, and the added startup cost was enough to intermittently OOM/kill
 * those subprocesses. Loading it on demand keeps the common paths light.
 */
async function loadTypeScript(): Promise<typeof ts> {
  return (await import('typescript')).default;
}

/** A file-level source ref: the whole file's bytes are the subject. */
export interface DocsFileRef {
  path: string;
}

/** A symbol-level source ref: one named declaration's text is the subject. */
export interface DocsSymbolRef {
  path: string;
  symbol: string;
}

/** A mode-level source ref: an agent/mode's identity signature is the subject. */
export interface DocsModeRef {
  path: string;
  mode: string;
}

/** The three granularities of a source ref (§3 WP-U4-1). */
export type DocsSourceRef = DocsFileRef | DocsSymbolRef | DocsModeRef;

/** A `{path, symbol}` ref carries a `symbol`; a `{path, mode}` ref carries a `mode`. */
function isSymbolRef(ref: DocsSourceRef): ref is DocsSymbolRef {
  return typeof (ref as DocsSymbolRef).symbol === 'string';
}

function isModeRef(ref: DocsSourceRef): ref is DocsModeRef {
  return typeof (ref as DocsModeRef).mode === 'string';
}

/**
 * The stable identity of a ref within a page's baseline (§3 WP-U4-1):
 * `path` | `path#symbol` | `path@mode`. Deterministic, so the committed
 * `docs-source-refs.blessed.json` keys are diffable across runs.
 */
export function refKey(ref: DocsSourceRef): string {
  if (isSymbolRef(ref)) {
    return `${ref.path}#${ref.symbol}`;
  }
  if (isModeRef(ref)) {
    return `${ref.path}@${ref.mode}`;
  }
  return ref.path;
}

/** A diagnosed stale ref — the page points at something the sources no longer hold. */
export class SourceRefError extends Error {}

/** The outcome of validating a page's frontmatter `sourceRefs` value (§3 WP-U4-2). */
export interface ParsedSourceRefs {
  /** The well-formed refs, in declaration order. */
  refs: DocsSourceRef[];
  /** One message per malformed entry; empty when the whole value is valid. */
  errors: string[];
}

/**
 * Validate a frontmatter `sourceRefs` value into typed {@link DocsSourceRef}s
 * (§3 WP-U4-2). SHARED by the generator (which turns errors into build problems)
 * and `bless-docs` (which records the hashes), so the one shape rule cannot
 * drift between the two scripts.
 *
 * A ref must be an object carrying a non-empty `path` and EXACTLY ONE of `symbol`
 * or `mode` (or neither, for the file-level form). Any other field, both `symbol`
 * and `mode`, or a missing/empty `path` is an error rather than a silent drop —
 * a typo in a ref must be as loud as a typo in `covers`.
 */
export function parseSourceRefs(value: unknown): ParsedSourceRefs {
  const refs: DocsSourceRef[] = [];
  const errors: string[] = [];
  if (value === undefined) {
    return { refs, errors };
  }
  if (!Array.isArray(value)) {
    errors.push('"sourceRefs" must be a list');
    return { refs, errors };
  }
  for (const [index, entry] of value.entries()) {
    const where = `sourceRefs[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${where} must be an object with a "path"`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (field !== 'path' && field !== 'symbol' && field !== 'mode') {
        errors.push(`${where} has an unknown field "${field}" (expected path, symbol or mode)`);
      }
    }
    if (typeof record.path !== 'string' || record.path.trim().length === 0) {
      errors.push(`${where} needs a non-empty "path"`);
      continue;
    }
    const hasSymbol = record.symbol !== undefined;
    const hasMode = record.mode !== undefined;
    if (hasSymbol && hasMode) {
      errors.push(`${where} cannot carry both "symbol" and "mode" — a ref is one granularity`);
      continue;
    }
    if (hasSymbol) {
      if (typeof record.symbol !== 'string' || record.symbol.trim().length === 0) {
        errors.push(`${where} "symbol" must be a non-empty string`);
        continue;
      }
      refs.push({ path: record.path, symbol: record.symbol });
      continue;
    }
    if (hasMode) {
      if (typeof record.mode !== 'string' || record.mode.trim().length === 0) {
        errors.push(`${where} "mode" must be a non-empty string`);
        continue;
      }
      refs.push({ path: record.path, mode: record.mode });
      continue;
    }
    refs.push({ path: record.path });
  }
  return { refs, errors };
}

/** The text of the FIRST named declaration called `symbol`, in source order. */
function findNamedDeclarationText(
  ts: typeof import('typescript'),
  sourceFile: ts.SourceFile,
  symbol: string
): string | undefined {
  let text: string | undefined;
  const visit = (node: ts.Node): void => {
    if (text !== undefined) {
      return;
    }
    if (
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === symbol) ||
      ((ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node)) &&
        node.name?.text === symbol) ||
      (ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === symbol)
    ) {
      text = node.getText(sourceFile);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return text;
}

/**
 * The `sha256:`-prefixed hash of the subject a source ref names, resolved
 * against `root` (§3 WP-U4-1).
 *
 * A ref whose file, symbol or mode cannot be found REJECTS rather than hashing
 * a default: a page that pins a symbol which was renamed away is stale, and the
 * drift gate must say so instead of silently succeeding on an empty string.
 */
export async function hashSourceRef(root: string, ref: DocsSourceRef): Promise<string> {
  const absolutePath = join(root, ref.path);

  if (isSymbolRef(ref)) {
    let text: string;
    try {
      text = await readFile(absolutePath, 'utf8');
    } catch {
      throw new SourceRefError(`source ref ${refKey(ref)} points at a missing file`);
    }
    const ts = await loadTypeScript();
    const sourceFile = ts.createSourceFile(absolutePath, text, ts.ScriptTarget.ES2017, true);
    const declarationText = findNamedDeclarationText(ts, sourceFile, ref.symbol);
    if (declarationText === undefined) {
      throw new SourceRefError(
        `source ref ${refKey(ref)} names a declaration not found in ${ref.path}`
      );
    }
    return `sha256:${sha256Hex(declarationText)}`;
  }

  if (isModeRef(ref)) {
    let text: string;
    try {
      text = await readFile(absolutePath, 'utf8');
    } catch {
      throw new SourceRefError(`source ref ${refKey(ref)} points at a missing file`);
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (error) {
      throw new SourceRefError(
        `source ref ${refKey(ref)} could not parse ${ref.path} as YAML: ${(error as Error).message}`
      );
    }
    const modes = (parsed as { modes?: unknown } | null)?.modes;
    const mode = Array.isArray(modes)
      ? (modes.find(candidate => (candidate as { id?: unknown })?.id === ref.mode) as
          | { id: string; label?: string; description?: string; systemPrompt: string }
          | undefined)
      : undefined;
    if (!mode) {
      throw new SourceRefError(`source ref ${refKey(ref)} names a mode not found in ${ref.path}`);
    }
    const signature = computeAgentSignature({
      id: mode.id,
      label: mode.label ?? '',
      description: mode.description,
      systemPrompt: mode.systemPrompt
    });
    return `sha256:${sha256Hex(signature)}`;
  }

  let contents: Buffer;
  try {
    contents = await readFile(absolutePath);
  } catch {
    throw new SourceRefError(`source ref ${refKey(ref)} points at a missing file`);
  }
  return `sha256:${sha256Hex(contents)}`;
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
