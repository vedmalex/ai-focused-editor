import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  INVENTORY_SOURCE_EXCLUDES,
  INVENTORY_SOURCE_ROOTS,
  computeSourceFingerprint,
  listInventorySources,
  toInventoryRelativePath
} from './source-scan';

/**
 * Fixture trees live in the OS temp directory, never in the working tree: a
 * test that leaves an artefact behind shows up in `git status`, misleads the
 * next reader and invites an accidental commit.
 */
const TEST_ROOT = join(tmpdir(), 'source-scan-test');

/** The three package roots the traversal declares, as bare directory paths. */
const PACKAGE_SOURCE_DIRS = [
  'packages/manuscript-workspace/src',
  'packages/ai-connect-theia/src',
  'packages/document-preview-theia/src'
];

async function write(repoRoot: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = join(repoRoot, relativePath);
  await fs.mkdir(join(absolutePath, '..'), { recursive: true });
  await fs.writeFile(absolutePath, contents, 'utf8');
}

/** Repository-relative path of the obligatory entity source (§3 WP-U3-0, R2). */
const BASE_MODES_PATH = 'packages/manuscript-workspace/src/node/ai/base-modes.yaml';

/**
 * A fixture repo holding all three declared roots (two of them empty) plus the
 * obligatory `base-modes.yaml` entity source, without which
 * {@link computeSourceFingerprint} rejects (R2).
 */
async function makeRepo(name: string): Promise<string> {
  const repoRoot = join(TEST_ROOT, name);
  await fs.rm(repoRoot, { recursive: true, force: true });
  for (const dir of PACKAGE_SOURCE_DIRS) {
    await fs.mkdir(join(repoRoot, dir), { recursive: true });
  }
  await write(repoRoot, BASE_MODES_PATH, 'version: 1\nmodes: []\n');
  return repoRoot;
}

async function relativeSources(repoRoot: string): Promise<string[]> {
  const files = await listInventorySources(repoRoot);
  return files.map(file => toInventoryRelativePath(repoRoot, file));
}

beforeEach(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe('declared traversal', () => {
  test('roots are the three product packages — theia-git-fork is out by design', () => {
    expect(INVENTORY_SOURCE_ROOTS).toEqual([
      'packages/manuscript-workspace/src/**/*.ts',
      'packages/ai-connect-theia/src/**/*.ts',
      'packages/document-preview-theia/src/**/*.ts'
    ]);
    expect(INVENTORY_SOURCE_ROOTS.join(' ')).not.toContain('theia-git-fork');
  });

  test('excludes are the five of §C.1', () => {
    expect(INVENTORY_SOURCE_EXCLUDES).toEqual([
      '**/*.test.ts',
      '**/*.d.ts',
      '**/*.generated.ts',
      'node_modules',
      'lib'
    ]);
  });
});

describe('listInventorySources', () => {
  test('collects .ts files from every declared root, at any depth', async () => {
    const repoRoot = await makeRepo('collect');
    await write(repoRoot, 'packages/manuscript-workspace/src/top.ts', 'a');
    await write(repoRoot, 'packages/manuscript-workspace/src/deep/nested/inner.ts', 'b');
    await write(repoRoot, 'packages/ai-connect-theia/src/connect.ts', 'c');
    await write(repoRoot, 'packages/document-preview-theia/src/preview.ts', 'd');

    expect(await relativeSources(repoRoot)).toEqual([
      'packages/ai-connect-theia/src/connect.ts',
      'packages/document-preview-theia/src/preview.ts',
      'packages/manuscript-workspace/src/deep/nested/inner.ts',
      'packages/manuscript-workspace/src/top.ts'
    ]);
  });

  test('returns absolute paths', async () => {
    const repoRoot = await makeRepo('absolute');
    await write(repoRoot, 'packages/manuscript-workspace/src/top.ts', 'a');
    expect(await listInventorySources(repoRoot)).toEqual([
      join(repoRoot, 'packages/manuscript-workspace/src/top.ts')
    ]);
  });

  test('neg: every declared exclusion actually excludes', async () => {
    const repoRoot = await makeRepo('excludes');
    await write(repoRoot, 'packages/manuscript-workspace/src/kept.ts', 'a');
    await write(repoRoot, 'packages/manuscript-workspace/src/kept.test.ts', 'b');
    await write(repoRoot, 'packages/manuscript-workspace/src/deep/also.test.ts', 'c');
    await write(repoRoot, 'packages/manuscript-workspace/src/types.d.ts', 'd');
    await write(repoRoot, 'packages/manuscript-workspace/src/browser/docs/x.generated.ts', 'e');
    await write(repoRoot, 'packages/manuscript-workspace/src/node_modules/dep/index.ts', 'f');
    await write(repoRoot, 'packages/manuscript-workspace/src/lib/compiled.ts', 'g');

    expect(await relativeSources(repoRoot)).toEqual(['packages/manuscript-workspace/src/kept.ts']);
  });

  test('neg: non-.ts files are not inventory sources', async () => {
    const repoRoot = await makeRepo('extensions');
    await write(repoRoot, 'packages/manuscript-workspace/src/kept.ts', 'a');
    await write(repoRoot, 'packages/manuscript-workspace/src/styles.css', 'b');
    await write(repoRoot, 'packages/manuscript-workspace/src/data.json', 'c');
    await write(repoRoot, 'packages/manuscript-workspace/src/widget.tsx', 'd');

    expect(await relativeSources(repoRoot)).toEqual(['packages/manuscript-workspace/src/kept.ts']);
  });

  test('neg: sources outside the declared roots are not collected', async () => {
    const repoRoot = await makeRepo('outside');
    await write(repoRoot, 'packages/manuscript-workspace/src/kept.ts', 'a');
    await write(repoRoot, 'packages/theia-git-fork/src/fork.ts', 'b');
    await write(repoRoot, 'packages/manuscript-workspace/scripts/tool.ts', 'c');
    await write(repoRoot, 'scripts/root-level.ts', 'd');

    expect(await relativeSources(repoRoot)).toEqual(['packages/manuscript-workspace/src/kept.ts']);
  });

  test('neg: a missing declared root REJECTS instead of silently shrinking the walk', async () => {
    const repoRoot = await makeRepo('missing-root');
    await fs.rm(join(repoRoot, 'packages/ai-connect-theia'), { recursive: true, force: true });
    await write(repoRoot, 'packages/manuscript-workspace/src/kept.ts', 'a');

    expect(listInventorySources(repoRoot)).rejects.toThrow(/packages\/ai-connect-theia\/src/);
  });

  test('the order is byte-wise and locale-independent', async () => {
    const repoRoot = await makeRepo('order');
    // Names chosen so a locale-aware collation orders them differently from a
    // byte-wise one (uppercase and `_` sort BEFORE lowercase by codepoint, but
    // `localeCompare` interleaves them). No case-only pairs: the developer
    // filesystem here is case-insensitive and they would collide as one file.
    for (const name of ['Zebra.ts', 'apple.ts', '_under.ts', 'Beta.ts', 'zulu.ts']) {
      await write(repoRoot, `packages/manuscript-workspace/src/${name}`, 'x');
    }
    const collected = await relativeSources(repoRoot);
    expect(collected.map(path => path.split('/').pop())).toEqual([
      'Beta.ts',
      'Zebra.ts',
      '_under.ts',
      'apple.ts',
      'zulu.ts'
    ]);
    expect([...collected].sort((left, right) => left.localeCompare(right))).not.toEqual(collected);
  });
});

describe('computeSourceFingerprint', () => {
  test('is stable across two runs over an untouched tree', async () => {
    const repoRoot = await makeRepo('stable');
    await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 1;');
    await write(repoRoot, 'packages/ai-connect-theia/src/b.ts', 'const b = 2;');

    const first = await computeSourceFingerprint(repoRoot);
    const second = await computeSourceFingerprint(repoRoot);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test('survives a touched mtime — the detector hashes content, not timestamps', async () => {
    const repoRoot = await makeRepo('mtime');
    const relativePath = 'packages/manuscript-workspace/src/a.ts';
    await write(repoRoot, relativePath, 'const a = 1;');
    const before = await computeSourceFingerprint(repoRoot);

    const future = new Date(Date.now() + 120_000);
    await fs.utimes(join(repoRoot, relativePath), future, future);

    expect(await computeSourceFingerprint(repoRoot)).toBe(before);
  });

  test('neg: changes when a file body changes', async () => {
    const repoRoot = await makeRepo('content');
    await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 1;');
    const before = await computeSourceFingerprint(repoRoot);

    await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 2;');
    expect(await computeSourceFingerprint(repoRoot)).not.toBe(before);
  });

  test('neg: changes when a file is added or removed', async () => {
    const repoRoot = await makeRepo('membership');
    await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 1;');
    const before = await computeSourceFingerprint(repoRoot);

    await write(repoRoot, 'packages/manuscript-workspace/src/b.ts', 'const b = 2;');
    const withExtra = await computeSourceFingerprint(repoRoot);
    expect(withExtra).not.toBe(before);

    await fs.rm(join(repoRoot, 'packages/manuscript-workspace/src/b.ts'));
    expect(await computeSourceFingerprint(repoRoot)).toBe(before);
  });

  test('neg: changes when a file is renamed but its content is not', async () => {
    const repoRoot = await makeRepo('rename');
    await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 1;');
    const before = await computeSourceFingerprint(repoRoot);

    await fs.rename(
      join(repoRoot, 'packages/manuscript-workspace/src/a.ts'),
      join(repoRoot, 'packages/manuscript-workspace/src/renamed.ts')
    );
    expect(await computeSourceFingerprint(repoRoot)).not.toBe(before);
  });

  test('ignores excluded files — a new test file does not invalidate the inventory', async () => {
    const repoRoot = await makeRepo('excluded-fingerprint');
    await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 1;');
    const before = await computeSourceFingerprint(repoRoot);

    await write(repoRoot, 'packages/manuscript-workspace/src/a.test.ts', 'test noise');
    expect(await computeSourceFingerprint(repoRoot)).toBe(before);
  });

  test('does not depend on where the repository is checked out', async () => {
    const first = await makeRepo('checkout-a');
    const second = await makeRepo('checkout-b-with-a-longer-name');
    for (const repoRoot of [first, second]) {
      await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 1;');
      await write(repoRoot, 'packages/ai-connect-theia/src/b.ts', 'const b = 2;');
    }
    expect(await computeSourceFingerprint(first)).toBe(await computeSourceFingerprint(second));
  });
});

describe('entity source extras in the fingerprint (§3 WP-U3-0, R2)', () => {
  test('neg: editing base-modes.yaml moves the fingerprint — agents[] cannot go stale silently', async () => {
    const repoRoot = await makeRepo('extras-base-modes');
    await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 1;');
    const before = await computeSourceFingerprint(repoRoot);

    await write(repoRoot, BASE_MODES_PATH, 'version: 1\nmodes:\n  - id: gv-x\n    label: X\n    agent: true\n    systemPrompt: hi\n');
    expect(await computeSourceFingerprint(repoRoot)).not.toBe(before);
  });

  test('neg: adding a SKILL.md moves the fingerprint — skills[] cannot go stale silently', async () => {
    const repoRoot = await makeRepo('extras-skill-add');
    await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 1;');
    const before = await computeSourceFingerprint(repoRoot);

    await write(repoRoot, '.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: d\n---\nbody\n');
    const withSkill = await computeSourceFingerprint(repoRoot);
    expect(withSkill).not.toBe(before);

    await write(repoRoot, '.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: changed\n---\nbody\n');
    expect(await computeSourceFingerprint(repoRoot)).not.toBe(withSkill);
  });

  test('an empty skills root is allowed — only base-modes.yaml is obligatory', async () => {
    const repoRoot = await makeRepo('extras-no-skills');
    await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 1;');
    expect(await computeSourceFingerprint(repoRoot)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('neg: a missing base-modes.yaml rejects rather than dropping the agents source', async () => {
    const repoRoot = await makeRepo('extras-missing-base-modes');
    await write(repoRoot, 'packages/manuscript-workspace/src/a.ts', 'const a = 1;');
    await fs.rm(join(repoRoot, BASE_MODES_PATH));
    expect(computeSourceFingerprint(repoRoot)).rejects.toThrow(/base-modes\.yaml/);
  });
});

describe('toInventoryRelativePath', () => {
  test('strips the repo root and yields POSIX separators', () => {
    expect(toInventoryRelativePath('/repo', '/repo/packages/x/src/a.ts')).toBe('packages/x/src/a.ts');
    expect(toInventoryRelativePath('/repo/', '/repo/packages/x/src/a.ts')).toBe('packages/x/src/a.ts');
  });

  test('leaves a path outside the repo root alone rather than inventing "../"', () => {
    expect(toInventoryRelativePath('/repo', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts');
  });
});

describe('the real repository', () => {
  // …/packages/manuscript-workspace/src/node/docs → the repository root.
  const REPO_ROOT = join(import.meta.dir, '../../../../..');

  test('walks the checked-out tree and honours its own excludes', async () => {
    const files = await listInventorySources(REPO_ROOT);
    const relative = files.map(file => toInventoryRelativePath(REPO_ROOT, file));

    expect(relative.length).toBeGreaterThan(100);
    expect(relative.every(path => path.endsWith('.ts'))).toBe(true);
    expect(relative.some(path => path.endsWith('.test.ts'))).toBe(false);
    expect(relative.some(path => path.includes('theia-git-fork'))).toBe(false);
    expect(relative).toContain('packages/manuscript-workspace/src/common/docs/directive-core.ts');
    expect(relative).not.toContain('packages/manuscript-workspace/src/common/docs/directive-core.test.ts');
    expect([...relative].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))).toEqual(relative);
  });
});
