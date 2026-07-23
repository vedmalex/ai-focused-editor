#!/usr/bin/env bun
/**
 * Entity-page scaffolder (TASK-018 tech_spec §3 WP-U3-6, §5 S5).
 *
 * For every UNCOVERED entity (a prompt fragment, agent or skill in the inventory
 * that no page covers and no allowlist entry excuses), writes a starter page at
 * `content/ru/<section>/<slug>.md` — UNLESS one already exists there (it never
 * overwrites). The page carries the auto-derivable parts (title, `## Что это`
 * from the entity description, `covers`, a `sourceRefs` draft) plus a MANDATORY
 * `## Зачем и когда` section stubbed with a `<!-- SCAFFOLD-TODO -->` marker. The
 * generator's strict gate refuses to ship a page that still carries that marker
 * or leaves the section empty (§3 WP-U3-6 enforce), so the author must fill it.
 *
 * `docs:scaffold = docs:inventory && bun scripts/scaffold-docs.mjs` — a manuscript
 * convenience, not part of the build. Coverage is judged with the SAME
 * `patternMatches` the generator uses (imported, not re-implemented), so the two
 * agree on what "covered" means.
 */

import { promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import { splitFrontmatter } from '../src/node/docs/frontmatter.ts';
import { patternMatches } from './generate-docs-content.mjs';

const PACKAGE_RELATIVE_PATH = 'packages/manuscript-workspace';
const INVENTORY_RELATIVE_PATH = `${PACKAGE_RELATIVE_PATH}/docs-inventory.generated.json`;
const CONTENT_RELATIVE_PATH = `${PACKAGE_RELATIVE_PATH}/src/browser/docs/content`;
const ALLOWLIST_RELATIVE_PATH = 'docs/coverage-exceptions.jsonc';
const DEFAULT_LANG = 'ru';
const ORDER_PLACEHOLDER = 999;
const SCAFFOLD_TODO_MARKER = '<!-- SCAFFOLD-TODO -->';

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
    throw new ConfigError(`scaffold-docs: cannot locate repository root (tried "${candidate}") — pass --repo-root`);
  }
  return candidate;
}

/** The set of entity ids already covered by a page's exact `covers` claim. */
async function collectCoveredEntities(repoRoot) {
  const covered = new Set();
  const languageRoot = join(repoRoot, CONTENT_RELATIVE_PATH, DEFAULT_LANG);
  for (const absolutePath of await listMarkdownFiles(languageRoot)) {
    const split = splitFrontmatter(await fs.readFile(absolutePath, 'utf8'));
    if (!split) {
      continue;
    }
    let front;
    try {
      front = parseYaml(split.yamlText) ?? {};
    } catch {
      continue;
    }
    for (const claim of Array.isArray(front.covers) ? front.covers : []) {
      if (typeof claim === 'string' && !claim.includes('*')) {
        covered.add(claim);
      } else if (claim && typeof claim === 'object' && typeof claim.pattern === 'string' && !claim.pattern.includes('*')) {
        covered.add(claim.pattern);
      }
    }
  }
  return covered;
}

/** Allowlist patterns that EXCUSE an entity (exempt/dynamic/deferred — never external/glob). */
async function loadExcusePatterns(repoRoot) {
  let text;
  try {
    text = await fs.readFile(join(repoRoot, ALLOWLIST_RELATIVE_PATH), 'utf8');
  } catch {
    return [];
  }
  const document = parseJsonc(text, [], { allowTrailingComma: true });
  const list = Array.isArray(document?.exceptions) ? document.exceptions : [];
  return list
    .filter(entry => ['exempt', 'dynamic', 'deferred'].includes(entry?.kind) && typeof entry.pattern === 'string')
    .map(entry => entry.pattern);
}

/** The scaffold destination and metadata for one entity, keyed by its family. */
function planFor(entity) {
  if (entity.kind === 'agent') {
    const slug = entity.modeId;
    return {
      slug: `ai/${slug}`,
      section: 'AI',
      title: (entity.label && entity.label.trim()) || slug,
      description: entity.description ?? '',
      sourceRefs: [{ path: entity.file, mode: entity.modeId }]
    };
  }
  if (entity.kind === 'skill') {
    const slug = entity.id.replace(/^skill:/, '');
    return {
      slug: `tools/${slug}`,
      section: 'Инструменты',
      title: (entity.name && entity.name.trim()) || slug,
      description: entity.description ?? '',
      sourceRefs: [{ path: entity.file }]
    };
  }
  // promptFragment
  const slug = entity.id.slice(entity.id.lastIndexOf('.') + 1);
  return {
    slug: `ai/${slug}`,
    section: 'AI',
    title: (entity.name && entity.name.trim()) || entity.id,
    description: entity.description ?? '',
    sourceRefs: [{ path: entity.file }]
  };
}

/** A frontmatter value rendered as a compact, deterministic YAML scalar/flow. */
function yamlScalar(value) {
  if (/^[\wа-яА-ЯёЁ.\- /]+$/.test(value) && !/^\s|\s$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function renderPage(entity, plan) {
  const lines = ['---'];
  lines.push(`title: ${yamlScalar(plan.title)}`);
  lines.push(`order: ${ORDER_PLACEHOLDER}`);
  lines.push(`section: ${yamlScalar(plan.section)}`);
  lines.push('covers:');
  lines.push(`  - ${entity.id}`);
  lines.push('sourceRefs:');
  for (const ref of plan.sourceRefs) {
    const parts = [`path: ${yamlScalar(ref.path)}`];
    if (ref.symbol) {
      parts.push(`symbol: ${yamlScalar(ref.symbol)}`);
    }
    if (ref.mode) {
      parts.push(`mode: ${yamlScalar(ref.mode)}`);
    }
    lines.push(`  - { ${parts.join(', ')} }`);
  }
  lines.push('---');
  lines.push('');
  lines.push('## Что это');
  lines.push('');
  lines.push(plan.description.trim().length > 0 ? plan.description.trim() : '');
  lines.push('');
  lines.push('## Зачем и когда');
  lines.push('');
  lines.push(SCAFFOLD_TODO_MARKER);
  lines.push('');
  return lines.join('\n');
}

async function main(argv) {
  const repoRoot = await resolveRepositoryRoot(argv, dirname(fileURLToPath(import.meta.url)));
  let inventory;
  try {
    inventory = JSON.parse(await fs.readFile(join(repoRoot, INVENTORY_RELATIVE_PATH), 'utf8'));
  } catch {
    throw new ConfigError('scaffold-docs: inventory missing — run "bun run docs:inventory" first');
  }

  const entities = [
    ...(inventory.promptFragments ?? []).map(fragment => ({ ...fragment, kind: 'promptFragment' })),
    ...(inventory.agents ?? []).map(agent => ({ ...agent, kind: 'agent' })),
    ...(inventory.skills ?? []).map(skill => ({ ...skill, kind: 'skill' }))
  ];
  const covered = await collectCoveredEntities(repoRoot);
  const excusePatterns = await loadExcusePatterns(repoRoot);

  const created = [];
  const skipped = [];
  for (const entity of entities) {
    if (covered.has(entity.id) || excusePatterns.some(pattern => patternMatches(pattern, entity.id))) {
      continue;
    }
    const plan = planFor(entity);
    const relativePath = `${CONTENT_RELATIVE_PATH}/${DEFAULT_LANG}/${plan.slug}.md`;
    const absolutePath = join(repoRoot, relativePath);
    try {
      await fs.access(absolutePath);
      skipped.push(relativePath); // already exists — never overwrite
      continue;
    } catch {
      // does not exist — create it
    }
    await fs.mkdir(dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, renderPage(entity, plan), 'utf8');
    created.push(relativePath);
  }

  for (const path of created) {
    process.stdout.write(`scaffold-docs: created ${posixPath(path)}\n`);
  }
  for (const path of skipped) {
    process.stdout.write(`scaffold-docs: exists, left as-is ${posixPath(path)}\n`);
  }
  process.stdout.write(
    `scaffold-docs: ${created.length} page(s) created, ${skipped.length} left as-is\n`
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : `scaffold-docs: ${error?.stack ?? error}`}\n`
    );
    process.exit(error instanceof ConfigError ? 2 : 1);
  });
}
