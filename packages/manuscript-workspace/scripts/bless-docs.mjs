#!/usr/bin/env bun
/**
 * Blessed-baseline writer (TASK-018 tech_spec §3 WP-U4-3, §5 S5).
 *
 * Reads every default-language guide page, hashes each `sourceRefs` declaration
 * it carries, and writes the committed baseline `docs/docs-source-refs.blessed.json`
 * (`{ version:1, pages:{ <pageId>:{ <refKey>:{ hash, blessedAt } } } }`). This is
 * the ONLY writer of that file — `generate-docs-content.mjs` compares against it
 * and never rewrites it, so the committed diff of the baseline is the livingness
 * trail of the documentation (§2.2).
 *
 * `docs:bless = docs:inventory && bun scripts/bless-docs.mjs`; the author runs it
 * deliberately, after re-reading the source a page describes and confirming the
 * page is still correct (Q4). It is NOT part of the automatic build.
 *
 * RUN WITH `bun` (§1.2): it imports the TypeScript source hashing helpers
 * directly, exactly as the two other docs scripts do.
 */

import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_DOCS_LANG } from '../src/common/docs/docs-contract.ts';
import { splitFrontmatter } from '../src/node/docs/frontmatter.ts';
import { hashSourceRef, refKey, parseSourceRefs } from '../src/node/docs/source-refs.ts';

const PACKAGE_RELATIVE_PATH = 'packages/manuscript-workspace';
const CONTENT_RELATIVE_PATH = `${PACKAGE_RELATIVE_PATH}/src/browser/docs/content`;
const BLESSED_RELATIVE_PATH = 'docs/docs-source-refs.blessed.json';

class ConfigError extends Error {}

function posixPath(value) {
  return value.split(sep).join('/');
}

function byText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

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

function argumentValue(argv, name) {
  const prefix = `--${name}=`;
  const match = argv.find(argument => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

/**
 * The `blessedAt` date. Explicit `--blessed-at=YYYY-MM-DD` or `MB3_BLESSED_AT`
 * wins (reproducible runs / tests); otherwise today's date. Using `new Date()`
 * here is fine — this is a manually-invoked script, not a deterministic build
 * step, and the date recorded is the day the author blessed the page.
 */
function resolveBlessedAt(argv) {
  const explicit = argumentValue(argv, 'blessed-at') ?? process.env.MB3_BLESSED_AT;
  const value = explicit ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ConfigError(`bless-docs: invalid blessedAt '${value}' (expected YYYY-MM-DD)`);
  }
  return value;
}

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
    throw new ConfigError(`bless-docs: cannot locate repository root (tried "${candidate}") — pass --repo-root`);
  }
  return candidate;
}

async function main(argv) {
  const repoRoot = await resolveRepositoryRoot(argv, dirname(fileURLToPath(import.meta.url)));
  const blessedAt = resolveBlessedAt(argv);

  const pages = {};
  let refCount = 0;
  // Only the default language declares source refs (the guide is written ru-first
  // and the drift gate reads the default set — §2.4); walk it explicitly.
  const languageRoot = join(repoRoot, CONTENT_RELATIVE_PATH, DEFAULT_DOCS_LANG);
  for (const absolutePath of await listMarkdownFiles(languageRoot)) {
    const id = posixPath(absolutePath.slice(languageRoot.length + 1)).replace(/\.md$/, '');
    const split = splitFrontmatter(await fs.readFile(absolutePath, 'utf8'));
    if (!split) {
      continue;
    }
    let front;
    try {
      front = parseYaml(split.yamlText) ?? {};
    } catch (error) {
      throw new ConfigError(`bless-docs: invalid frontmatter YAML in ${id}.md: ${error.message}`);
    }
    const parsed = parseSourceRefs(front?.sourceRefs);
    if (parsed.errors.length > 0) {
      throw new ConfigError(`bless-docs: ${parsed.errors.join('; ')} in ${id}.md`);
    }
    if (parsed.refs.length === 0) {
      continue;
    }
    const entries = {};
    for (const ref of parsed.refs) {
      const key = refKey(ref);
      entries[key] = { hash: await hashSourceRef(repoRoot, ref), blessedAt };
      refCount++;
    }
    pages[id] = sortObject(entries);
  }

  const baseline = { version: 1, pages: sortObject(pages) };
  const outputPath = join(repoRoot, BLESSED_RELATIVE_PATH);
  await fs.mkdir(dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `bless-docs: blessed ${refCount} source ref(s) across ${Object.keys(pages).length} page(s) → ${BLESSED_RELATIVE_PATH}\n`
  );
}

/** Deterministic key order so the committed baseline diffs cleanly. */
function sortObject(object) {
  const sorted = {};
  for (const key of Object.keys(object).sort(byText)) {
    sorted[key] = object[key];
  }
  return sorted;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof ConfigError ? error.message : `bless-docs: ${error?.stack ?? error}`}\n`);
    process.exit(error instanceof ConfigError ? 2 : 1);
  });
}
