#!/usr/bin/env bun
/**
 * Feature-inventory extractor (tech_spec §C, WP-1).
 *
 * Walks the product sources and writes `docs-inventory.generated.json` (§B.4):
 * every command id and every preference key the product exposes, plus the
 * declarations it could NOT extract. The documentation build reads that file
 * and fails when a capability is described by no page — so a hole here is not
 * a missing line in a report, it is a silently lifted guarantee. That is why
 * several rules below fail loudly instead of skipping quietly.
 *
 * RUN WITH `bun` (§1.2): the traversal is imported from the TypeScript source
 * `src/node/docs/source-scan.ts`, which `tsc` only compiles LATER in the build
 * chain (`docs:inventory` → `docs:gen` → `tsc`), so `lib/` does not exist yet.
 *
 * The traversal itself is NOT redeclared here (§1.5, F-D5-10). Two glob lists
 * would let the extractor and the generator cover different files while their
 * fingerprints still agree — a false-negative staleness detector, the worst of
 * the available failure modes. Roots, excludes, order and hash live in exactly
 * one module and both scripts import it.
 */

import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import {
  BASE_MODES_RELATIVE_PATH,
  INVENTORY_SOURCE_ROOTS,
  computeSourceFingerprint,
  listInventorySources,
  listSkillFiles,
  toInventoryRelativePath
} from '../src/node/docs/source-scan.ts';
import { splitFrontmatter } from '../src/node/docs/frontmatter.ts';
import { MODE_AGENT_ID_PREFIX, PROJECT_AI_MODE_FRAGMENT_PREFIX } from '../src/common/ai/agent-ids.ts';

/**
 * Command namespaces that belong to this product (§C.2).
 *
 * The filter is MANDATORY, not a tidiness measure (ФАКТ-ПОПРАВКА П1): of the
 * 169 string `id:` literals under `src/browser/**`, ten are not commands at all
 * — capability presets, colour-theme ids and one empty placeholder. Without the
 * filter they enter the inventory, and every one of them then demands a
 * documentation page or an exception.
 *
 * BOTH prefixes are required (П2): `ai-connect-theia` declares two commands in
 * `ai-connect.*`, while `document-preview-theia` declares none of its own and
 * uses `ai-focused-editor.office.*`.
 */
export const INVENTORY_NAMESPACES = Object.freeze(['ai-focused-editor.', 'ai-connect.']);

/**
 * Callees whose argument marks an object literal as a command declaration
 * (§C.2 branches 1 and 3). Matched by MEMBER NAME with any receiver, so
 * `this.commandRegistry.registerCommand`, `commands.registerCommand` and a
 * bare `registerCommand` are all the same declaration site.
 */
const COMMAND_DECLARATION_CALLEES = new Set([
  'registerCommand',
  'toLocalizedCommand',
  'toDefaultLocalizedCommand'
]);

/**
 * Command-registry lookups whose first argument names a command (§C.8).
 *
 * Matched STRUCTURALLY — a `CallExpression` on a `PropertyAccessExpression`
 * with one of these member names, whatever the receiver expression is. Keying
 * on a receiver named `commandRegistry` would find nothing on the current tree,
 * where the calls read `this.commands.getCommand(...)` /
 * `this.commands.executeCommand(...)`, and `codeReferencedIds[]` would ship
 * empty. That array is the staleness subject for `external` + `usedBy:"code"`
 * allowlist entries (§B.5.1), so an empty one makes the shipped allowlist stale
 * against itself and kills the group-D build command.
 */
const COMMAND_LOOKUP_CALLEES = new Set(['executeCommand', 'getCommand', 'isEnabled']);

/**
 * Callees whose object-literal argument declares a built-in prompt fragment
 * (§3 WP-U3-2). Matched by MEMBER NAME with any receiver, like
 * {@link COMMAND_DECLARATION_CALLEES}, so `this.promptService.addBuiltInPromptFragment`
 * and a bare `addBuiltInPromptFragment` are the same declaration site.
 */
const FRAGMENT_DECLARATION_CALLEES = new Set(['addBuiltInPromptFragment']);

/** Output artifact, relative to the repository root (§B.4, gitignored). */
const INVENTORY_OUTPUT_RELATIVE_PATH = 'packages/manuscript-workspace/docs-inventory.generated.json';

/** `text` in a `skipped` entry is for human eyes in the report; keep it one line. */
const SKIPPED_TEXT_LIMIT = 200;

/** A diagnosed extractor failure (exit 2), as opposed to a crash. */
class InventoryError extends Error {}

// --------------------------------------------------------------------------
// Source access
// --------------------------------------------------------------------------

/**
 * Parsed-file store over the traversal set, with a lazy escape hatch for import
 * targets outside it.
 *
 * `ts.createSourceFile` per file — NOT `ts.createProgram` (§C.1). Every signal
 * needed here is syntactic (a property name, a literal kind, a type annotation
 * by name, an argument position); a Program would have to resolve three
 * tsconfigs and the whole `@theia/*` graph, which is far slower and adds a
 * failure mode where a type-resolution error takes the inventory down with it.
 * `setParentNodes` is on because the ancestry classification (§C.2) and the
 * structural `skipped` filter (§C.6) both walk upward.
 */
function createSourceStore(repoRoot) {
  const parsed = new Map();

  function parse(absolutePath, text) {
    const sourceFile = ts.createSourceFile(absolutePath, text, ts.ScriptTarget.ES2017, true);
    const entry = { sourceFile, relativePath: toInventoryRelativePath(repoRoot, absolutePath), absolutePath };
    parsed.set(absolutePath, entry);
    return entry;
  }

  return {
    add: (absolutePath, text) => parse(absolutePath, text),
    /** Already-walked files hit the cache; an imported const outside the walk is read on demand. */
    load(absolutePath) {
      if (parsed.has(absolutePath)) {
        return parsed.get(absolutePath);
      }
      let text;
      try {
        text = readFileSync(absolutePath, 'utf8');
      } catch {
        parsed.set(absolutePath, undefined);
        return undefined;
      }
      return parse(absolutePath, text);
    }
  };
}

/** 1-based line of `node`, as reported everywhere in the inventory (§C.1). */
function lineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

// --------------------------------------------------------------------------
// §C.3 — resolving an identifier to a string literal
// --------------------------------------------------------------------------

/** Any `const <name> = <expr>` in this file, at any nesting depth. */
function findLocalDeclaration(name, sourceFile) {
  let found;
  const visit = node => {
    if (found) {
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** `export const <name> = <expr>` — the export keyword is required across a file boundary. */
function findExportedDeclaration(name, sourceFile) {
  const declaration = findLocalDeclaration(name, sourceFile);
  if (!declaration) {
    return undefined;
  }
  const statement = declaration.parent?.parent;
  const isExported =
    statement &&
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return isExported ? declaration : undefined;
}

/** The import that introduces `name` into `sourceFile`, plus the name it has at the source. */
function findImportBinding(name, sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    const bindings = statement.importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      // A default or namespace import would need member resolution; §C.3 does
      // not define one, and a wrong guess here invents inventory entries.
      continue;
    }
    for (const element of bindings.elements) {
      if (element.name.text === name) {
        return {
          specifier: ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined,
          exportedName: (element.propertyName ?? element.name).text
        };
      }
    }
  }
  return undefined;
}

/** `./x` → `./x.ts` or `./x/index.ts`. Bare specifiers (`@theia/…`) are out of scope. */
function resolveRelativeModule(specifier, fromFile) {
  if (!specifier || !specifier.startsWith('.')) {
    return undefined;
  }
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts')) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/**
 * The initializer `name` is bound to: locally first, then across one import hop
 * (§C.3 steps 1 and 2).
 *
 * Step 2 is ФАКТ-ПОПРАВКА П3, not a generalisation for its own sake: the third
 * preference schema keys its only property with `[LIVE_VALIDATION_PREFERENCE]`,
 * a const IMPORTED from `./live-validation-contribution`. A local-only resolver
 * loses that key outright, and a lost preference key makes the `query=` gate
 * quietly wrong in both directions.
 *
 * Transitive chains (`const A = B`) are deliberately NOT followed — they do not
 * occur on the current tree, and an attempt yields a `skipped` entry or a hard
 * failure, i.e. it is noticed rather than half-handled.
 */
function resolveIdentifierDeclaration(name, origin, store) {
  const local = findLocalDeclaration(name, origin.sourceFile);
  if (local) {
    return { expression: local.initializer, origin };
  }
  const binding = findImportBinding(name, origin.sourceFile);
  if (!binding) {
    return undefined;
  }
  const targetPath = resolveRelativeModule(binding.specifier, origin.absolutePath);
  if (!targetPath) {
    return undefined;
  }
  const target = store.load(targetPath);
  if (!target) {
    return undefined;
  }
  const exported = findExportedDeclaration(binding.exportedName, target.sourceFile);
  return exported ? { expression: exported.initializer, origin: target } : undefined;
}

/**
 * `expression` as a string literal, or `undefined` when it is not statically a
 * string. A `StringLiteral`, or an `Identifier` resolvable to one (§C.2/§C.3).
 */
function resolveExpressionToString(expression, origin, store) {
  if (ts.isStringLiteral(expression)) {
    return expression.text;
  }
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }
  const declaration = resolveIdentifierDeclaration(expression.text, origin, store);
  if (!declaration) {
    return undefined;
  }
  return ts.isStringLiteral(declaration.expression) ? declaration.expression.text : undefined;
}

// --------------------------------------------------------------------------
// §C.2 — the three-branch ancestry classification
// --------------------------------------------------------------------------

/** Member name of the callee, whatever the receiver is (`a.b.registerCommand` → `registerCommand`). */
function calleeName(callExpression) {
  const callee = callExpression.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return undefined;
}

/** Branch 3's lookup: is `name` handed to a registration call as its FIRST argument, in this file? */
function isRegisteredByIdentifier(name, sourceFile) {
  let found = false;
  const visit = node => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(node) && COMMAND_DECLARATION_CALLEES.has(calleeName(node) ?? '')) {
      const first = node.arguments[0];
      if (first && ts.isIdentifier(first) && first.text === name) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * `"command"` when the object literal holding this `id:` structurally sits where
 * a command declaration sits, `"unclassified"` otherwise (§C.2).
 *
 * Three branches, and the third is load-bearing rather than decorative (F-D6-6):
 * a literal assigned to an UNANNOTATED variable and registered by identifier
 * passes neither branch 1 (the argument is an identifier, not the literal) nor
 * branch 2 (no `: Command`). With a non-string id it would then land in neither
 * `commands` NOR `skipped` — an invisible omission, which is the exact defect
 * the §C.6 visibility rule exists to prevent.
 *
 * ONE function, shared with §C.6: the two must not drift, or the set of things
 * reported as skipped stops matching the set of things treated as commands.
 */
function classifyCommandAncestry(node, sourceFile) {
  const objectLiteral = node.parent;
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
    return 'unclassified';
  }
  const parent = objectLiteral.parent;
  if (!parent) {
    return 'unclassified';
  }

  // Branch 1 — the literal is itself an argument of a declaration call.
  if (ts.isCallExpression(parent) && parent.arguments.some(argument => argument === objectLiteral)) {
    if (COMMAND_DECLARATION_CALLEES.has(calleeName(parent) ?? '')) {
      return 'command';
    }
  }

  if (ts.isVariableDeclaration(parent) && parent.initializer === objectLiteral) {
    // Branch 2 — `const x: Command = { … }`.
    if (parent.type) {
      const annotation = parent.type;
      if (
        ts.isTypeReferenceNode(annotation) &&
        ts.isIdentifier(annotation.typeName) &&
        annotation.typeName.text === 'Command'
      ) {
        return 'command';
      }
      return 'unclassified';
    }
    // Branch 3 — unannotated, but registered by identifier in the SAME file.
    // Cross-file would need a Program, which §C.1 rejects; the limit is named.
    if (ts.isIdentifier(parent.name) && isRegisteredByIdentifier(parent.name.text, sourceFile)) {
      return 'command';
    }
  }

  return 'unclassified';
}

// --------------------------------------------------------------------------
// §C.6 — visibility of what could not be extracted
// --------------------------------------------------------------------------

/** The expression an `id:` really carries, after at most one identifier hop. */
function effectiveInitializer(expression, origin, store) {
  if (!ts.isIdentifier(expression)) {
    return { expression, origin };
  }
  return resolveIdentifierDeclaration(expression.text, origin, store);
}

/** One of the four closed `why` values of §B.4. */
function classifySkipReason(effective) {
  if (!effective) {
    return 'unresolvable-identifier-id';
  }
  const expression = effective.expression;
  if (ts.isTemplateExpression(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return 'template-literal-id';
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return 'concatenated-id';
  }
  if (ts.isCallExpression(expression)) {
    return 'call-expression-id';
  }
  return 'unresolvable-identifier-id';
}

/** Operands of a left-nested `a + b + c`, in source order. */
function flattenConcatenation(expression, into) {
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    flattenConcatenation(expression.left, into);
    flattenConcatenation(expression.right, into);
    return;
  }
  into.push(expression);
}

/**
 * The leading STATIC run of a dynamic id (§C.6), e.g.
 * `` `${MODE_RUN_COMMAND_PREFIX}${mode.id}` `` → `ai-focused-editor.mode.run.`.
 *
 * Accumulates literal chunks and statically resolvable expressions from the
 * left and stops at the first unknown one — the prefix has to be a real prefix,
 * so anything after a gap is unusable. An unresolvable leading part yields no
 * prefix at all; the `skipped` entry still stands, because visibility of the
 * omission must not be traded for the new field.
 *
 * Without this, `kind:"dynamic"` allowlist entries have NO staleness subject:
 * their ids never reach `commands[]` by construction, so a detector aimed at
 * `commands[]` calls every such entry stale, forever.
 */
function leadingStaticPrefix(effective, store) {
  if (!effective) {
    return undefined;
  }
  const expression = effective.expression;
  const origin = effective.origin;
  const pieces = [];

  if (ts.isNoSubstitutionTemplateLiteral(expression)) {
    pieces.push(expression.text);
  } else if (ts.isTemplateExpression(expression)) {
    pieces.push(expression.head.text);
    for (const span of expression.templateSpans) {
      pieces.push(span.expression, span.literal.text);
    }
  } else if (ts.isBinaryExpression(expression)) {
    flattenConcatenation(expression, pieces);
  } else {
    return undefined;
  }

  let prefix = '';
  for (const piece of pieces) {
    if (typeof piece === 'string') {
      prefix += piece;
      continue;
    }
    const resolved = resolveExpressionToString(piece, origin, store);
    if (resolved === undefined) {
      break;
    }
    prefix += resolved;
  }
  return prefix.length > 0 ? prefix : undefined;
}

/** Single-line, bounded rendering of a declaration for the report. */
function skippedText(node, sourceFile) {
  const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
  return text.length > SKIPPED_TEXT_LIMIT ? `${text.slice(0, SKIPPED_TEXT_LIMIT - 1)}…` : text;
}

// --------------------------------------------------------------------------
// Extraction
// --------------------------------------------------------------------------

function isOwnNamespace(value) {
  return INVENTORY_NAMESPACES.some(namespace => value.startsWith(namespace));
}

function isIdPropertyName(name) {
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'id';
}

/**
 * Is this `id:` property the `id` of an object literal handed to a prompt-fragment
 * declaration call (`addBuiltInPromptFragment({ id, … })`)?
 *
 * The double-count fix (TASK-018 S4). `diagram-author-prompt-fragment-contribution.ts`
 * writes `addBuiltInPromptFragment({ id: DIAGRAM_AUTHOR_FRAGMENT_ID, … isCommand: true,
 * commandName: 'afe-diagram-author' })`. The id `ai-focused-editor.diagram-author` is
 * the PROMPT-FRAGMENT id (used as `{{prompt:ai-focused-editor.diagram-author}}`), NOT a
 * Theia command id — the runtime slash command it exposes is the DIFFERENT string
 * `afe-diagram-author`, and no `registerCommand` ever declares
 * `ai-focused-editor.diagram-author`. `classifyCommandAncestry` already refuses to call
 * it a command (it returns `unclassified`, because `addBuiltInPromptFragment` is not a
 * {@link COMMAND_DECLARATION_CALLEES}). It reached `commands[]` only because
 * {@link collectCommand} harvests EVERY own-namespace `id:` string literal regardless of
 * ancestry. Left in place it would live in BOTH `commands[]` and `promptFragments[]`,
 * making one page's `covers` claim satisfy two coverage universes at once. So a fragment
 * declaration's own `id:` literal is excluded here — the id lives ONLY in
 * `promptFragments[]` (single-universe accounting, §6 F-D2.1-1).
 */
function isFragmentDeclarationArgumentId(node) {
  const objectLiteral = node.parent;
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
    return false;
  }
  const parent = objectLiteral.parent;
  return (
    !!parent &&
    ts.isCallExpression(parent) &&
    parent.arguments.some(argument => argument === objectLiteral) &&
    FRAGMENT_DECLARATION_CALLEES.has(calleeName(parent) ?? '')
  );
}

function collectCommand(node, file, store, out) {
  // A prompt-fragment declaration's `id:` is not a command — it belongs to
  // `promptFragments[]` alone (double-count fix, §6 F-D2.1-1).
  if (isFragmentDeclarationArgumentId(node)) {
    return;
  }
  const value = resolveExpressionToString(node.initializer, file, store);

  if (value !== undefined) {
    // A resolvable const belongs in `commands`, NOT in `skipped` (§C.6): the
    // report's skipped section must list real blind spots, not noise.
    if (isOwnNamespace(value)) {
      out.commands.push({
        id: value,
        file: file.relativePath,
        line: lineOf(node, file.sourceFile),
        kind: classifyCommandAncestry(node, file.sourceFile)
      });
    }
    return;
  }

  // Not statically a string. Report it ONLY where a command declaration
  // structurally belongs (§C.6 condition в) — the structural test replaces the
  // earlier substring filter, which matched nothing at all on this tree
  // (`id: commandId` carries no namespace text) and left the section empty
  // while looking like it worked.
  if (classifyCommandAncestry(node, file.sourceFile) !== 'command') {
    return;
  }

  const effective = effectiveInitializer(node.initializer, file, store);
  const entry = {
    why: classifySkipReason(effective),
    file: file.relativePath,
    line: lineOf(node, file.sourceFile),
    text: skippedText(node, file.sourceFile)
  };
  if (entry.why === 'template-literal-id' || entry.why === 'concatenated-id') {
    const prefix = leadingStaticPrefix(effective, store);
    if (prefix !== undefined) {
      entry.staticPrefix = prefix;
      if (isOwnNamespace(prefix)) {
        out.dynamicPrefixes.add(prefix);
      }
    }
  }
  out.skipped.push(entry);
}

/**
 * Preference keys of one `PreferenceSchema` (§C.3).
 *
 * An unextractable key FAILS the run rather than being dropped. A missing
 * preference is not merely absent from the coverage count: it makes the
 * `query=` gate both false-negative (a real key looks unknown) and
 * false-positive (a typo looks covered). A loud stop is cheaper than a quiet
 * hole in the very set the guarantee is measured against.
 */
function collectPreferences(declaration, file, store, out) {
  const initializer = declaration.initializer;
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    return;
  }
  const propertiesProperty = initializer.properties.find(
    property =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'properties'
  );
  if (!propertiesProperty || !ts.isObjectLiteralExpression(propertiesProperty.initializer)) {
    return;
  }
  const schema = ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;

  for (const property of propertiesProperty.initializer.properties) {
    const line = lineOf(property, file.sourceFile);
    if (!ts.isPropertyAssignment(property)) {
      // A spread would hide an unknown number of keys behind one node.
      throw new InventoryError(
        `docs-inventory: unextractable preference key at ${file.relativePath}:${line} — ` +
          'each property must be a plain assignment with a statically known key'
      );
    }

    const key = preferenceKeyOf(property.name, file, store);
    if (key === undefined) {
      throw new InventoryError(
        `docs-inventory: unresolvable preference key at ${file.relativePath}:${line} — ` +
          'use a string literal, or a const resolvable in this file or through one import'
      );
    }
    out.preferences.push({ key, file: file.relativePath, line, schema });
  }
}

/**
 * The key a property name denotes, or `undefined` when it is not statically
 * known.
 *
 * §C.3 enumerates a string literal and a computed identifier. A BARE
 * IDENTIFIER name (`{ someKey: … }`) is admitted here as a third form even
 * though the spec's list stops at two: its text IS the key, statically and
 * unambiguously, so no hole can hide behind it — and the decision §C.3 states
 * is scoped to an "unresolvable computed key", which this is not. Failing on a
 * name we can read perfectly would be a false alarm, not a guarantee.
 */
function preferenceKeyOf(name, file, store) {
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return resolveExpressionToString(name.expression, file, store);
  }
  return undefined;
}

/**
 * Foreign command ids this codebase CALLS (§C.8).
 *
 * Purpose is deliberately narrow: give the staleness detector a subject for
 * `external` + `usedBy:"code"` allowlist entries. It feeds neither the coverage
 * function (§C.7) nor the `command=`/`query=` gates (§C.5) — widening it would
 * let a directive point at any id mentioned anywhere in the code, which is the
 * `command=` gate with the teeth removed.
 */
function collectCodeReference(node, file, store, out) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !COMMAND_LOOKUP_CALLEES.has(callee.name.text)) {
    return;
  }
  const first = node.arguments[0];
  if (!first) {
    return;
  }
  const value = resolveExpressionToString(first, file, store);
  if (value === undefined || isOwnNamespace(value)) {
    return;
  }
  out.codeReferencedIds.add(value);
}

/** A property's initializer as a string literal (one hop), or `undefined`. */
function literalPropertyString(objectLiteral, propertyName, file, store) {
  const property = objectLiteral.properties.find(
    member =>
      ts.isPropertyAssignment(member) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === propertyName
  );
  if (!property || !ts.isPropertyAssignment(property)) {
    return undefined;
  }
  return resolveExpressionToString(property.initializer, file, store);
}

/**
 * A built-in prompt-fragment declaration (§3 WP-U3-2).
 *
 * The STATIC site — `addBuiltInPromptFragment({ id: FRAGMENT_ID, name, ... })` —
 * yields a `promptFragments[]` entry (diagram-author). `name`/`description` are
 * OMITTED when they are `nls.localize(...)` calls rather than string literals
 * (the diagram-author case): a scaffold falls back to the id, by design.
 *
 * The DYNAMIC site — `addBuiltInPromptFragment(this.toPromptFragment(mode))`,
 * whose argument is a CALL EXPRESSION, not an object literal — cannot be read
 * statically (the id is built three hops away in a module-private helper). It is
 * made VISIBLE as a `skipped` entry and contributes the known per-project prefix
 * to `dynamicPrefixes[]`, so the committed `ai-focused-editor.project-mode.*`
 * dynamic exception has a live staleness subject (tech_spec §6 F-D2.1-2/3, Q1).
 * The prefix is TAKEN FROM the shared `PROJECT_AI_MODE_FRAGMENT_PREFIX` const,
 * not auto-derived from the call chain.
 */
function collectPromptFragment(node, file, store, out) {
  if (!FRAGMENT_DECLARATION_CALLEES.has(calleeName(node) ?? '')) {
    return;
  }
  const argument = node.arguments[0];
  if (!argument) {
    return;
  }

  if (ts.isObjectLiteralExpression(argument)) {
    const idProperty = argument.properties.find(
      property => ts.isPropertyAssignment(property) && isIdPropertyName(property.name)
    );
    if (!idProperty || !ts.isPropertyAssignment(idProperty)) {
      return;
    }
    const id = resolveExpressionToString(idProperty.initializer, file, store);
    if (id === undefined || !isOwnNamespace(id)) {
      return;
    }
    const entry = {
      kind: 'promptFragment',
      id,
      file: file.relativePath,
      line: lineOf(idProperty, file.sourceFile)
    };
    const name = literalPropertyString(argument, 'name', file, store);
    if (name !== undefined) {
      entry.name = name;
    }
    const description = literalPropertyString(argument, 'description', file, store);
    if (description !== undefined) {
      entry.description = description;
    }
    out.promptFragments.push(entry);
    return;
  }

  // Dynamic site — visibility + the hand-authored project-mode prefix.
  out.skipped.push({
    why: 'call-expression-id',
    file: file.relativePath,
    line: lineOf(node, file.sourceFile),
    text: skippedText(node, file.sourceFile),
    staticPrefix: PROJECT_AI_MODE_FRAGMENT_PREFIX
  });
  out.dynamicPrefixes.add(PROJECT_AI_MODE_FRAGMENT_PREFIX);
}

/**
 * Agent-eligible AI modes from `base-modes.yaml` (§3 WP-U3-3).
 *
 * `agent: true` is the filter (`gv-opponent`, `gv-essay` today). The chat
 * `@agent` id is `MODE_AGENT_ID_PREFIX + mode.id`, from the SAME shared const
 * the browser runtime registers with (R1), so the two can never drift.
 */
async function collectAgents(repoRoot, out) {
  const absolutePath = join(repoRoot, BASE_MODES_RELATIVE_PATH);
  const relativePath = toInventoryRelativePath(repoRoot, absolutePath);
  // Obligatory: a missing base-modes.yaml already fails the fingerprint walk.
  const parsed = parseYaml(await fs.readFile(absolutePath, 'utf8'));
  const modes = Array.isArray(parsed?.modes) ? parsed.modes : [];
  for (const mode of modes) {
    if (mode?.agent !== true || typeof mode.id !== 'string') {
      continue;
    }
    out.agents.push({
      kind: 'agent',
      id: `${MODE_AGENT_ID_PREFIX}${mode.id}`,
      label: typeof mode.label === 'string' ? mode.label : mode.id,
      description: typeof mode.description === 'string' ? mode.description : '',
      file: relativePath,
      modeId: mode.id
    });
  }
}

/**
 * Bundled agent-skills from `.claude/skills/**\/SKILL.md` (§3 WP-U3-4).
 *
 * `name`/`description` come from the manifest frontmatter; the synthetic id is
 * `skill:<dir>` (e.g. `skill:docs-workflow`). The skills tree is optional, so an
 * empty root simply yields no entries.
 */
async function collectSkills(repoRoot, out) {
  for (const absolutePath of await listSkillFiles(repoRoot)) {
    const relativePath = toInventoryRelativePath(repoRoot, absolutePath);
    const split = splitFrontmatter(await fs.readFile(absolutePath, 'utf8'));
    const front = (split ? parseYaml(split.yamlText) : undefined) ?? {};
    const dir = basename(dirname(absolutePath));
    out.skills.push({
      kind: 'skill',
      id: `skill:${dir}`,
      name: typeof front.name === 'string' ? front.name : dir,
      description: typeof front.description === 'string' ? front.description : '',
      file: relativePath
    });
  }
}

function isPreferenceSchemaDeclaration(node) {
  return (
    ts.isVariableDeclaration(node) &&
    !!node.type &&
    ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === 'PreferenceSchema'
  );
}

function collectFromFile(file, store, out) {
  const visit = node => {
    if (ts.isPropertyAssignment(node) && isIdPropertyName(node.name)) {
      collectCommand(node, file, store, out);
    } else if (isPreferenceSchemaDeclaration(node)) {
      collectPreferences(node, file, store, out);
    } else if (ts.isCallExpression(node)) {
      collectCodeReference(node, file, store, out);
      collectPromptFragment(node, file, store, out);
    }
    ts.forEachChild(node, visit);
  };
  visit(file.sourceFile);
}

/** Byte-wise, locale-independent — the artifact must be identical on every machine. */
function byText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Package names of the declared roots, so the field cannot drift from the walk. */
function inventoryPackages() {
  const names = [];
  for (const root of INVENTORY_SOURCE_ROOTS) {
    const match = /^packages\/([^/]+)\//.exec(root);
    if (match && !names.includes(match[1])) {
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * The full inventory of the tree at `repoRoot` (§B.4).
 *
 * Exported so tests can assert the shape directly; the CLI below adds argument
 * handling and the file write.
 */
export async function extractInventory(repoRoot) {
  const sources = await listInventorySources(repoRoot);
  const store = createSourceStore(repoRoot);
  const files = [];
  for (const absolutePath of sources) {
    files.push(store.add(absolutePath, await fs.readFile(absolutePath, 'utf8')));
  }

  const out = {
    commands: [],
    preferences: [],
    skipped: [],
    dynamicPrefixes: new Set(),
    codeReferencedIds: new Set(),
    promptFragments: [],
    agents: [],
    skills: []
  };
  for (const file of files) {
    collectFromFile(file, store, out);
  }
  await collectAgents(repoRoot, out);
  await collectSkills(repoRoot, out);

  out.commands.sort(
    (left, right) => byText(left.id, right.id) || byText(left.file, right.file) || left.line - right.line
  );
  out.preferences.sort(
    (left, right) => byText(left.key, right.key) || byText(left.file, right.file) || left.line - right.line
  );
  out.skipped.sort((left, right) => byText(left.file, right.file) || left.line - right.line);
  out.promptFragments.sort(
    (left, right) => byText(left.id, right.id) || byText(left.file, right.file) || left.line - right.line
  );
  out.agents.sort((left, right) => byText(left.id, right.id));
  out.skills.sort((left, right) => byText(left.id, right.id));

  return {
    version: 2,
    sourceFingerprint: `sha256:${await computeSourceFingerprint(repoRoot)}`,
    packages: inventoryPackages(),
    namespaces: [...INVENTORY_NAMESPACES],
    commands: out.commands,
    preferences: out.preferences,
    skipped: out.skipped,
    dynamicPrefixes: [...out.dynamicPrefixes].sort(byText),
    codeReferencedIds: [...out.codeReferencedIds].sort(byText),
    promptFragments: out.promptFragments,
    agents: out.agents,
    skills: out.skills,
    // Kept in the schema for a future auto-resolved dynamic-entity subject; the
    // project-mode prefix currently lives in `dynamicPrefixes[]` (§6 F-D2.1-3).
    entityDynamicPrefixes: []
  };
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
 * The repository root, explicitly (§1.0) — `--repo-root=<abs>` or the script's
 * own location, then VERIFIED by the `workspaces` field.
 *
 * Deliberately not "walk up to the first `.git`": that breaks in a git worktree
 * and in a CI container without `.git`, and its failure mode is writing the
 * artifact somewhere else in silence.
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
    throw new InventoryError(
      `docs-inventory: cannot locate repository root (tried "${candidate}") — pass --repo-root`
    );
  }
  return candidate;
}

function resolveOutputPath(argv, repoRoot) {
  const explicit = argumentValue(argv, 'out');
  if (!explicit) {
    return join(repoRoot, INVENTORY_OUTPUT_RELATIVE_PATH);
  }
  return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
}

async function main(argv) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repoRoot = await resolveRepositoryRoot(argv, scriptDirectory);
  const inventory = await extractInventory(repoRoot);
  const outputPath = resolveOutputPath(argv, repoRoot);
  await fs.writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `docs-inventory: ${inventory.commands.length} command id(s), ` +
      `${inventory.preferences.length} preference key(s), ` +
      `${inventory.skipped.length} skipped → ${toInventoryRelativePath(repoRoot, outputPath)}\n`
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof InventoryError ? error.message : `docs-inventory: ${error?.stack ?? error}`}\n`);
    process.exit(2);
  });
}
