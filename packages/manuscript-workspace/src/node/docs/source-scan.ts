/**
 * The SINGLE definition of the inventory source traversal (tech_spec §1.5, WP-A).
 *
 * Two build steps must walk EXACTLY the same file set: the extractor
 * (`extract-feature-inventory`, §C.1) which reads the ids out of them, and the
 * generator (`generate-docs-content`) which re-hashes them to prove the
 * inventory is not stale. If the two ever disagree, the build is either
 * permanently dead (fingerprints never match) or, worse, quietly wrong (they
 * match while covering different files, so the staleness detector is a
 * false negative). Two glob lists would be the same "two sources of one truth"
 * defect WP-A removes from the directive grammar — so the roots, the excludes,
 * the sort order and the fingerprint rule are declared once, here, and both
 * scripts import them.
 *
 * WHY `src/node/` AND NOT `src/common/docs/` next to `directive-core.ts`: this
 * module uses `fs`/`crypto`, and by Theia convention `src/common/**` is also
 * imported by the browser layer. An fs module in `common/` is an invitation
 * for a future accidental browser import and a broken frontend build.
 * `directive-core.ts` belongs in `common/` precisely because the runtime
 * renderer imports it; this module is needed by two build scripts and by
 * nobody at runtime.
 */

import { createHash } from 'crypto';
import type { BinaryLike } from 'crypto';
import { promises as fs } from 'fs';
import { join, sep } from 'path';

/**
 * Traversal roots, relative to the repository root (§C.1).
 *
 * `theia-git-fork` is deliberately ABSENT: it is a vendored fork of Theia, not
 * our product surface. That boundary is what makes the §4.4 exception route
 * necessary for the `tools/git` page — the cost is named rather than hidden by
 * quietly widening the walk.
 */
export const INVENTORY_SOURCE_ROOTS: readonly string[] = [
  'packages/manuscript-workspace/src/**/*.ts',
  'packages/ai-connect-theia/src/**/*.ts',
  'packages/document-preview-theia/src/**/*.ts'
];

/**
 * Traversal exclusions (§C.1). `**` + `*.test.ts` mirrors the package
 * `tsconfig.json` `exclude`, so the inventory and the compiler see the same
 * production surface; generated and declaration files carry no authored ids.
 */
export const INVENTORY_SOURCE_EXCLUDES: readonly string[] = [
  '**/*.test.ts',
  '**/*.d.ts',
  '**/*.generated.ts',
  'node_modules',
  'lib'
];

/**
 * Repository-relative POSIX path of `absolutePath`. Both consumers report
 * positions as `<file>:<line>:<col>` and the fingerprint hashes the path, so
 * the normalisation has to live here too — a second `relative()` + `replace()`
 * somewhere else is the same divergence risk as a second glob list.
 */
export function toInventoryRelativePath(repoRoot: string, absolutePath: string): string {
  const normalizedRoot = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep;
  const relative = absolutePath.startsWith(normalizedRoot)
    ? absolutePath.slice(normalizedRoot.length)
    : absolutePath;
  return relative.split(sep).join('/');
}

/**
 * Compile a glob into an anchored RegExp over a POSIX relative path.
 * Supported — and only these, because only these appear above: `**` (any
 * number of path segments), `*` (any run within one segment), literals.
 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` swallows the separator too, so `**/*.ts` also matches `a.ts`.
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]+/)*';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
        continue;
      }
      source += '[^/]*';
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** A bare name like `node_modules` means "prune any directory so named". */
function isDirectoryNameExclude(pattern: string): boolean {
  return !pattern.includes('/') && !pattern.includes('*');
}

const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(
  INVENTORY_SOURCE_EXCLUDES.filter(isDirectoryNameExclude)
);

const EXCLUDED_FILE_PATTERNS: readonly RegExp[] = INVENTORY_SOURCE_EXCLUDES.filter(
  pattern => !isDirectoryNameExclude(pattern)
).map(globToRegExp);

const ROOT_PATTERNS: readonly RegExp[] = INVENTORY_SOURCE_ROOTS.map(globToRegExp);

/**
 * ENTITY source extras (TASK-018 tech_spec §3 WP-U3-0, R2).
 *
 * The `.ts` traversal above powers `commands[]`/`preferences[]`, but the three
 * new entity inventories are declared OUTSIDE it: `agents[]` come from the
 * bundled `base-modes.yaml`, and `skills[]` come from `.claude/skills/**\/SKILL.md`.
 * If those files stayed out of the fingerprint, editing `base-modes.yaml` would
 * NOT invalidate the inventory, and `agents[]` would silently go stale while the
 * freshness gate reported "up to date" — the exact false-negative WP-A removed
 * for the `.ts` set. So {@link computeSourceFingerprint} hashes
 * `listInventorySources ∪ listEntitySources`.
 */
export const BASE_MODES_RELATIVE_PATH =
  'packages/manuscript-workspace/src/node/ai/base-modes.yaml';

/** Repository-relative root of the bundled agent-skills tree (`SKILL.md` per skill). */
export const SKILLS_ROOT_RELATIVE_PATH = '.claude/skills';

/** The per-skill manifest file name walked under {@link SKILLS_ROOT_RELATIVE_PATH}. */
export const SKILL_FILE_NAME = 'SKILL.md';

/** `sha256` hex of `data`, the one hashing primitive both fingerprint paths reuse. */
function sha256Hex(data: BinaryLike): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Longest leading run of literal segments of a glob — the directory to walk. */
function globBaseDirectory(pattern: string): string {
  const segments = pattern.split('/');
  const literal: string[] = [];
  for (const segment of segments) {
    if (segment.includes('*')) {
      break;
    }
    literal.push(segment);
  }
  // Drop the file segment when the whole pattern is literal.
  return literal.length === segments.length ? literal.slice(0, -1).join('/') : literal.join('/');
}

/**
 * Byte-wise path order. Deliberately NOT `localeCompare`: the fingerprint must
 * be identical on every machine, and locale-aware collation is not.
 */
function byPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectFiles(absoluteDirectory: string, repoRoot: string, into: string[]): Promise<void> {
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }
    const absolutePath = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolutePath, repoRoot, into);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relativePath = toInventoryRelativePath(repoRoot, absolutePath);
    if (EXCLUDED_FILE_PATTERNS.some(pattern => pattern.test(relativePath))) {
      continue;
    }
    if (ROOT_PATTERNS.some(pattern => pattern.test(relativePath))) {
      into.push(relativePath);
    }
  }
}

/**
 * The inventory source files, as ABSOLUTE paths sorted by their
 * repository-relative path. The only traversal in this codebase.
 *
 * A declared root that does not exist REJECTS rather than yielding an empty
 * list: a renamed package would otherwise silently shrink the inventory, and
 * every id it holds would become "covered" by simply disappearing. Both
 * consumers fail the same way, so the two can never drift apart even here.
 */
export async function listInventorySources(repoRoot: string): Promise<string[]> {
  const relativePaths: string[] = [];
  for (const root of INVENTORY_SOURCE_ROOTS) {
    const baseDirectory = globBaseDirectory(root);
    const absoluteBase = join(repoRoot, baseDirectory);
    const stat = await fs.stat(absoluteBase).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new Error(`inventory source root is missing: ${baseDirectory} (from "${root}")`);
    }
    await collectFiles(absoluteBase, repoRoot, relativePaths);
  }
  relativePaths.sort(byPath);
  return relativePaths.map(relativePath => join(repoRoot, relativePath));
}

/**
 * Every `SKILL.md` under {@link SKILLS_ROOT_RELATIVE_PATH}, as ABSOLUTE paths
 * sorted by their repository-relative path (§3 WP-U3-0).
 *
 * A MISSING skills root yields an empty list rather than throwing: the skills
 * inventory is optional (a repo may ship none), unlike `base-modes.yaml`.
 */
export async function listSkillFiles(repoRoot: string): Promise<string[]> {
  const root = join(repoRoot, SKILLS_ROOT_RELATIVE_PATH);
  const found: string[] = [];
  async function walk(absoluteDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
        found.push(absolutePath);
      }
    }
  }
  await walk(root);
  found.sort((left, right) =>
    byPath(toInventoryRelativePath(repoRoot, left), toInventoryRelativePath(repoRoot, right))
  );
  return found;
}

/**
 * The entity source extras (§3 WP-U3-0, R2): `base-modes.yaml` plus every
 * `SKILL.md`, as ABSOLUTE paths.
 *
 * `base-modes.yaml` is OBLIGATORY and rejects when absent — exactly as a missing
 * `.ts` root does — because it is the sole source of `agents[]`, and a silently
 * dropped file would make every agent id look "covered" by disappearing. The
 * skills tree is optional (see {@link listSkillFiles}).
 */
export async function listEntitySources(repoRoot: string): Promise<string[]> {
  const baseModes = join(repoRoot, BASE_MODES_RELATIVE_PATH);
  const stat = await fs.stat(baseModes).catch(() => undefined);
  if (!stat?.isFile()) {
    throw new Error(
      `entity source is missing: ${BASE_MODES_RELATIVE_PATH} ` +
        '(base AI modes are required for the agents inventory)'
    );
  }
  return [baseModes, ...(await listSkillFiles(repoRoot))];
}

/**
 * `sha256` over `<relpath>\0<sha256(contents)>\n` per file (§1.5 step 3), over
 * `listInventorySources ∪ listEntitySources` sorted by repository-relative path.
 *
 * The union (R2) is why the extras have to be sorted in with the `.ts` files
 * rather than appended: the digest must be identical whichever consumer computes
 * it, and a stable byte order is the only way two independent walks agree.
 *
 * CONTENT, not mtime: `git checkout`/`git stash` move mtimes without touching
 * content (false failures, which people quickly learn to work around) and a
 * mtime-preserving edit would report "fresh" while being stale. File bytes are
 * hashed, not decoded text, so an encoding change is a change.
 */
export async function computeSourceFingerprint(repoRoot: string): Promise<string> {
  const files = [...(await listInventorySources(repoRoot)), ...(await listEntitySources(repoRoot))];
  files.sort((left, right) =>
    byPath(toInventoryRelativePath(repoRoot, left), toInventoryRelativePath(repoRoot, right))
  );
  const digest = createHash('sha256');
  for (const absolutePath of files) {
    const contents = await fs.readFile(absolutePath);
    digest.update(`${toInventoryRelativePath(repoRoot, absolutePath)}\0${sha256Hex(contents)}\n`);
  }
  return digest.digest('hex');
}

/**
 * Per-file `sha256` hex of every inventory source, keyed by repository-relative
 * path (§3 WP-U4-1). The file-level granularity subject for `{path}` source
 * refs; reuses the same {@link sha256Hex} primitive as the fingerprint so a
 * `{path}` drift check and the freshness fingerprint can never disagree on what
 * "the bytes of this file" means.
 */
export async function computeSourceHashes(repoRoot: string): Promise<Map<string, string>> {
  const files = await listInventorySources(repoRoot);
  const map = new Map<string, string>();
  for (const absolutePath of files) {
    const contents = await fs.readFile(absolutePath);
    map.set(toInventoryRelativePath(repoRoot, absolutePath), sha256Hex(contents));
  }
  return map;
}
