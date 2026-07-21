import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NodeConnectionRegistryFileService } from './node-connection-registry-file-service';

const service = new NodeConnectionRegistryFileService();

describe('resolveLayerPath', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  test('user layer honors an XDG_CONFIG_HOME override', async () => {
    process.env.XDG_CONFIG_HOME = '/xdg-root';
    expect(await service.resolveLayerPath('user')).toBe('/xdg-root/ai-connect/connections.json');
  });

  test('user layer falls back to ~/.config when XDG is unset', async () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(await service.resolveLayerPath('user')).toBe(
      path.join(os.homedir(), '.config', 'ai-connect', 'connections.json')
    );
  });

  test('project layer anchors on the provided cwd', async () => {
    expect(await service.resolveLayerPath('project', { cwd: '/work/root' })).toBe(
      '/work/root/.config/ai-connect/connections.json'
    );
  });

  test('project layer without a cwd is a clear error', async () => {
    await expect(service.resolveLayerPath('project')).rejects.toThrow(/workspace root/);
  });

  test('a custom path layer resolves against the cwd', async () => {
    expect(await service.resolveLayerPath({ path: 'rel/connections.json' }, { cwd: '/work' })).toBe(
      '/work/rel/connections.json'
    );
    expect(await service.resolveLayerPath({ path: '/abs/connections.json' }, { cwd: '/work' })).toBe(
      '/abs/connections.json'
    );
  });
});

describe('loadFromLayer', () => {
  test('a missing registry file converts AiConnectError into found:false', async () => {
    const missing = path.join(os.tmpdir(), `no-such-registry-${Date.now()}`, 'connections.json');
    const result = await service.loadFromLayer({ path: missing });
    expect(result.found).toBe(false);
    expect(result.registry).toEqual({ version: 2, endpoints: [] });
    expect(result.path).toBe(missing);
    expect(result.issues).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  test('a corrupt v2 registry (no endpoints array) rejects instead of reporting found:false', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'corrupt-registry-'));
    const filePath = path.join(dir, 'connections.json');
    await fs.writeFile(filePath, JSON.stringify({ version: 2 }), 'utf8');
    try {
      // A corrupt-but-parseable v2 file (validation_error WITHOUT searchedPaths)
      // must propagate, NOT be swallowed into found:false. A plain rejects.toThrow()
      // is the toothed assertion: with the old wide discriminator loadFromLayer
      // would resolve found:false (no throw) and this test would fail.
      await expect(service.loadFromLayer({ path: filePath })).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a syntactically invalid JSON file rejects with a SyntaxError', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bad-json-registry-'));
    const filePath = path.join(dir, 'connections.json');
    await fs.writeFile(filePath, '{ not valid json', 'utf8');
    try {
      await expect(service.loadFromLayer({ path: filePath })).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
