import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NodeGitStatusService } from './node-git-status-service';
import type { SemanticHistoryEntry } from '../common';

const TEST_ROOT = '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/git-history-test';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = gitAvailable();
const service = new NodeGitStatusService();

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
}

async function writeFile(cwd: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = join(cwd, relativePath);
  await fs.mkdir(dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents, 'utf8');
}

/** Builds a linear history: add x, modify x, add place, rename place, add manifest. */
async function buildRepo(rootPath: string): Promise<void> {
  await fs.rm(rootPath, { recursive: true, force: true });
  await fs.mkdir(rootPath, { recursive: true });
  git(rootPath, ['init', '-q']);
  git(rootPath, ['config', 'user.name', 'Test Author']);
  git(rootPath, ['config', 'user.email', 'test@example.com']);
  git(rootPath, ['config', 'commit.gpgsign', 'false']);

  await writeFile(rootPath, 'entities/characters/x.yaml', 'id: x\nname: X\n');
  git(rootPath, ['add', '-A']);
  git(rootPath, ['commit', '-q', '-m', 'add character x']);

  await writeFile(rootPath, 'entities/characters/x.yaml', 'id: x\nname: X\nrole: lead\n');
  git(rootPath, ['add', '-A']);
  git(rootPath, ['commit', '-q', '-m', 'modify character x']);

  await writeFile(rootPath, 'entities/locations/old-place.yaml', 'id: old-place\nname: Old Place\ndetail: harbor town\n');
  git(rootPath, ['add', '-A']);
  git(rootPath, ['commit', '-q', '-m', 'add location old-place']);

  git(rootPath, ['mv', 'entities/locations/old-place.yaml', 'entities/locations/new-place.yaml']);
  git(rootPath, ['commit', '-q', '-m', 'rename location to new-place']);

  await writeFile(rootPath, 'manifest.yaml', 'title: Test Book\n');
  git(rootPath, ['add', '-A']);
  git(rootPath, ['commit', '-q', '-m', 'add manifest']);
}

describe.skipIf(!GIT_AVAILABLE)('NodeGitStatusService.getSemanticHistory', () => {
  const repoPath = join(TEST_ROOT, 'repo');
  let entries: SemanticHistoryEntry[] = [];

  beforeAll(async () => {
    await buildRepo(repoPath);
    const result = await service.getSemanticHistory(repoPath);
    expect(result.isRepository).toBe(true);
    entries = result.entries;
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
  });

  test('returns all matching commits, newest first', () => {
    expect(entries.map(e => e.subject)).toEqual([
      'add manifest',
      'rename location to new-place',
      'add location old-place',
      'modify character x',
      'add character x'
    ]);
  });

  test('populates commit metadata (hashes, ISO date, author)', () => {
    const head = entries[0];
    expect(head.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(head.shortCommit.length).toBeGreaterThan(0);
    expect(head.commit.startsWith(head.shortCommit)).toBe(true);
    expect(head.author).toBe('Test Author');
    expect(Number.isNaN(new Date(head.date).getTime())).toBe(false);
  });

  test('derives entityKind/entityId for entity files and normalises status letters', () => {
    const modify = entries.find(e => e.subject === 'modify character x')!;
    expect(modify.changes).toHaveLength(1);
    expect(modify.changes[0]).toEqual({
      path: 'entities/characters/x.yaml',
      status: 'M',
      entityKind: 'character',
      entityId: 'x'
    });

    const add = entries.find(e => e.subject === 'add character x')!;
    expect(add.changes[0].status).toBe('A');
    expect(add.changes[0].entityKind).toBe('character');
    expect(add.changes[0].entityId).toBe('x');
  });

  test('resolves renames to the new path with status R', () => {
    const rename = entries.find(e => e.subject === 'rename location to new-place')!;
    expect(rename.changes).toHaveLength(1);
    expect(rename.changes[0]).toEqual({
      path: 'entities/locations/new-place.yaml',
      status: 'R',
      entityKind: 'location',
      entityId: 'new-place'
    });
  });

  test('leaves non-entity domain files without entity metadata', () => {
    const manifest = entries.find(e => e.subject === 'add manifest')!;
    expect(manifest.changes).toHaveLength(1);
    expect(manifest.changes[0].path).toBe('manifest.yaml');
    expect(manifest.changes[0].status).toBe('A');
    expect(manifest.changes[0].entityKind).toBeUndefined();
    expect(manifest.changes[0].entityId).toBeUndefined();
  });

  test('honours the limit (newest commits only)', async () => {
    const result = await service.getSemanticHistory(repoPath, 2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(e => e.subject)).toEqual([
      'add manifest',
      'rename location to new-place'
    ]);
  });

  test('reports a non-git directory as not a repository', async () => {
    const plainPath = join(TEST_ROOT, 'plain');
    await fs.rm(plainPath, { recursive: true, force: true });
    await fs.mkdir(plainPath, { recursive: true });
    const result = await service.getSemanticHistory(plainPath);
    expect(result.isRepository).toBe(false);
    expect(result.entries).toEqual([]);
  });

  test('reports missing rootUri as not a repository', async () => {
    const result = await service.getSemanticHistory(undefined);
    expect(result.isRepository).toBe(false);
    expect(result.entries).toEqual([]);
  });
});
