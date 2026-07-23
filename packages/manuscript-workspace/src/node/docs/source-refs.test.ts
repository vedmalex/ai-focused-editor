import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { hashSourceRef, refKey, SourceRefError } from './source-refs';

/**
 * Fixture trees live in the OS temp directory, never in the working tree: a test
 * that leaves an artefact behind shows up in `git status` and invites a commit.
 */
const TEST_ROOT = join(tmpdir(), 'source-refs-test');

let counter = 0;

async function makeRoot(): Promise<string> {
  const root = join(TEST_ROOT, `case-${counter++}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = join(root, relativePath);
  await fs.mkdir(join(absolutePath, '..'), { recursive: true });
  await fs.writeFile(absolutePath, contents, 'utf8');
}

beforeEach(async () => {
  await fs.mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe('refKey', () => {
  test('renders each granularity distinctly', () => {
    expect(refKey({ path: 'a/b.ts' })).toBe('a/b.ts');
    expect(refKey({ path: 'a/b.ts', symbol: 'Foo' })).toBe('a/b.ts#Foo');
    expect(refKey({ path: 'a/modes.yaml', mode: 'gv-x' })).toBe('a/modes.yaml@gv-x');
  });
});

describe('hashSourceRef — file granularity {path}', () => {
  test('hashes the whole file and moves when any byte changes', async () => {
    const root = await makeRoot();
    await write(root, 'src/a.ts', 'const a = 1;\n');
    const before = await hashSourceRef(root, { path: 'src/a.ts' });
    expect(before).toMatch(/^sha256:[0-9a-f]{64}$/);

    await write(root, 'src/a.ts', 'const a = 2;\n');
    expect(await hashSourceRef(root, { path: 'src/a.ts' })).not.toBe(before);
  });

  test('neg: a missing file rejects with a stale-ref diagnostic', async () => {
    const root = await makeRoot();
    await expect(hashSourceRef(root, { path: 'src/gone.ts' })).rejects.toBeInstanceOf(SourceRefError);
  });
});

describe('hashSourceRef — symbol granularity {path, symbol}', () => {
  const twoSymbols = (bodyA: string, bodyB: string): string =>
    `export function alpha(): number {\n  return ${bodyA};\n}\n\nexport function beta(): number {\n  return ${bodyB};\n}\n`;

  test('hashes only the named declaration — editing it drifts', async () => {
    const root = await makeRoot();
    await write(root, 'src/m.ts', twoSymbols('1', '2'));
    const before = await hashSourceRef(root, { path: 'src/m.ts', symbol: 'alpha' });

    await write(root, 'src/m.ts', twoSymbols('42', '2'));
    expect(await hashSourceRef(root, { path: 'src/m.ts', symbol: 'alpha' })).not.toBe(before);
  });

  test('editing a DIFFERENT symbol in the same file does NOT drift the pinned one', async () => {
    const root = await makeRoot();
    await write(root, 'src/m.ts', twoSymbols('1', '2'));
    const before = await hashSourceRef(root, { path: 'src/m.ts', symbol: 'alpha' });

    await write(root, 'src/m.ts', twoSymbols('1', '999'));
    expect(await hashSourceRef(root, { path: 'src/m.ts', symbol: 'alpha' })).toBe(before);
  });

  test('resolves a const, class and interface declaration by name', async () => {
    const root = await makeRoot();
    await write(
      root,
      'src/kinds.ts',
      'export const K = 1;\nexport class C { m(): void {} }\nexport interface I { x: number; }\n'
    );
    for (const symbol of ['K', 'C', 'I']) {
      expect(await hashSourceRef(root, { path: 'src/kinds.ts', symbol })).toMatch(
        /^sha256:[0-9a-f]{64}$/
      );
    }
  });

  test('neg: a symbol not present rejects', async () => {
    const root = await makeRoot();
    await write(root, 'src/m.ts', 'export const only = 1;\n');
    await expect(
      hashSourceRef(root, { path: 'src/m.ts', symbol: 'missing' })
    ).rejects.toBeInstanceOf(SourceRefError);
  });
});

describe('hashSourceRef — mode granularity {path, mode}', () => {
  const modesYaml = (opts: {
    label?: string;
    description?: string;
    systemPrompt?: string;
    icon?: string;
  }): string =>
    `version: 1\nmodes:\n  - id: gv-x\n    label: ${opts.label ?? 'X'}\n    description: ${opts.description ?? 'D'}\n    icon: ${opts.icon ?? 'law'}\n    agent: true\n    systemPrompt: ${opts.systemPrompt ?? 'sp'}\n`;

  test('drifts when label, description or systemPrompt change (the signature)', async () => {
    const root = await makeRoot();
    await write(root, 'ai/modes.yaml', modesYaml({}));
    const before = await hashSourceRef(root, { path: 'ai/modes.yaml', mode: 'gv-x' });
    expect(before).toMatch(/^sha256:[0-9a-f]{64}$/);

    await write(root, 'ai/modes.yaml', modesYaml({ label: 'Renamed' }));
    const afterLabel = await hashSourceRef(root, { path: 'ai/modes.yaml', mode: 'gv-x' });
    expect(afterLabel).not.toBe(before);

    await write(root, 'ai/modes.yaml', modesYaml({ systemPrompt: 'changed' }));
    expect(await hashSourceRef(root, { path: 'ai/modes.yaml', mode: 'gv-x' })).not.toBe(before);
  });

  test('does NOT drift when a non-signature field changes (icon)', async () => {
    const root = await makeRoot();
    await write(root, 'ai/modes.yaml', modesYaml({}));
    const before = await hashSourceRef(root, { path: 'ai/modes.yaml', mode: 'gv-x' });

    await write(root, 'ai/modes.yaml', modesYaml({ icon: 'telescope' }));
    expect(await hashSourceRef(root, { path: 'ai/modes.yaml', mode: 'gv-x' })).toBe(before);
  });

  test('neg: a mode id not present rejects', async () => {
    const root = await makeRoot();
    await write(root, 'ai/modes.yaml', modesYaml({}));
    await expect(
      hashSourceRef(root, { path: 'ai/modes.yaml', mode: 'nope' })
    ).rejects.toBeInstanceOf(SourceRefError);
  });
});
