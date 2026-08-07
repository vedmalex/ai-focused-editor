/**
 * The source ladder for the backend's configuration (TASK-022 WP-3, tech_spec
 * ОВ-9а, plus the `databasePath` half of ОВ-9б tooth 2).
 *
 * ONE CASE PER RUNG, NOT ONE CASE ON THE TOP. A test that only checks the
 * strongest source passes against a COMPLETELY BROKEN ladder — every lower rung
 * could be ignored and the top one would still win. So this sets all five at
 * once with distinguishable values and removes them one at a time from the top,
 * asserting the new winner at each step.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NARRATIVE_MEMORY_CONFIG_FILE,
  NARRATIVE_MEMORY_ENV,
  NarrativeMemoryConfigResolver
} from '../../lib/node/narrative-memory-config-resolver.js';
import { readCliOptions } from '../../lib/node/narrative-knowledge-cli-contribution.js';
import { NarrativeIndexStoreRegistry } from '../../lib/node/narrative-index-store-registry.js';
import { DEFAULT_NARRATIVE_MEMORY_CONFIG } from '../../lib/common/index.js';
import { disposeAll, makeWorkspace } from './harness.mts';

const ROOT = '/tmp/does-not-need-to-exist';

const FILE_VALUE = 4001;
const ENV_VALUE = 4002;
const CLI_VALUE = 4003;
const PATCH_VALUE = 4004;

function resolverWith(options: { env?: Record<string, string | undefined>; file?: unknown }) {
  return new NarrativeMemoryConfigResolver({
    env: options.env ?? {},
    readConfigFile: () => (options.file === undefined ? undefined : JSON.stringify(options.file))
  });
}

test('ОВ-9а: the ladder, checked at EVERY rung by removing sources from the top', () => {
  // Rung 1 (runtime patch) beats everything.
  const all = resolverWith({
    env: { [NARRATIVE_MEMORY_ENV.debounceMs]: String(ENV_VALUE) },
    file: { debounceMs: FILE_VALUE }
  });
  all.setCliOptions({ debounceMs: CLI_VALUE });
  all.setRuntimeOverrides({ debounceMs: PATCH_VALUE });
  assert.equal(all.resolve(ROOT).debounceMs, PATCH_VALUE, 'rung 1 (frontend patch) did not win');

  // Remove rung 1 -> rung 2 (CLI flag).
  const fromCli = resolverWith({
    env: { [NARRATIVE_MEMORY_ENV.debounceMs]: String(ENV_VALUE) },
    file: { debounceMs: FILE_VALUE }
  });
  fromCli.setCliOptions({ debounceMs: CLI_VALUE });
  assert.equal(fromCli.resolve(ROOT).debounceMs, CLI_VALUE, 'rung 2 (CLI flag) did not win over env and file');

  // Remove rung 2 -> rung 3 (environment).
  const fromEnv = resolverWith({
    env: { [NARRATIVE_MEMORY_ENV.debounceMs]: String(ENV_VALUE) },
    file: { debounceMs: FILE_VALUE }
  });
  assert.equal(fromEnv.resolve(ROOT).debounceMs, ENV_VALUE, 'rung 3 (environment) did not win over the file');

  // Remove rung 3 -> rung 4 (the per-workspace file).
  const fromFile = resolverWith({ file: { debounceMs: FILE_VALUE } });
  assert.equal(fromFile.resolve(ROOT).debounceMs, FILE_VALUE, 'rung 4 (workspace file) did not win over defaults');

  // Remove rung 4 -> rung 5 (the defaults WP-1 owns).
  const bare = resolverWith({});
  assert.equal(
    bare.resolve(ROOT).debounceMs,
    DEFAULT_NARRATIVE_MEMORY_CONFIG.debounceMs,
    'rung 5 (defaults) is not the floor'
  );
});

test('ОВ-9а: CLI outranks environment — the reason is a real leak path in this repository', () => {
  // A flag is per-launch and explicit; an environment variable leaks into every
  // child process, and `node-book-build-task-runner.ts:43` hands
  // `env: process.env` wholesale to the book-build child. A variable exported
  // for the editor would ride along into that build; a flag would not.
  const resolver = resolverWith({
    env: {
      [NARRATIVE_MEMORY_ENV.databasePath]: 'from-env.db',
      [NARRATIVE_MEMORY_ENV.fallbackTtlMs]: '111111'
    }
  });
  resolver.setCliOptions({ databasePath: 'from-cli.db', fallbackTtlMs: 222222 });
  const config = resolver.resolve(ROOT);
  assert.equal(config.databasePath, 'from-cli.db');
  assert.equal(config.fallbackTtlMs, 222222);
});

test('ОВ-9а: a malformed value on a rung is IGNORED, not coerced into NaN', () => {
  const resolver = resolverWith({ env: { [NARRATIVE_MEMORY_ENV.debounceMs]: 'four hundred' } });
  assert.equal(resolver.resolve(ROOT).debounceMs, DEFAULT_NARRATIVE_MEMORY_CONFIG.debounceMs);
  const broken = new NarrativeMemoryConfigResolver({ env: {}, readConfigFile: () => '{ not json' });
  assert.equal(broken.resolve(ROOT).debounceMs, DEFAULT_NARRATIVE_MEMORY_CONFIG.debounceMs);
});

test('ОВ-9а: resolution is memoized per root and per root ONLY', () => {
  // Rung 4 is per-workspace by definition, and the backend serves several
  // workspaces at once — a per-process memo would leak one manuscript's
  // settings into another's.
  const seen: string[] = [];
  const resolver = new NarrativeMemoryConfigResolver({
    env: {},
    readConfigFile: rootPath => {
      seen.push(rootPath);
      return JSON.stringify({ debounceMs: rootPath.endsWith('big') ? 5000 : 100 });
    }
  });
  assert.equal(resolver.resolve('/w/big').debounceMs, 5000);
  assert.equal(resolver.resolve('/w/small').debounceMs, 100);
  assert.equal(resolver.resolve('/w/big').debounceMs, 5000);
  assert.deepEqual(seen, ['/w/big', '/w/small'], 'the file was re-read for a root already resolved');
});

test('ОВ-9б tooth 2: --narrative-index-db LOCKS the key, and the lock is visible ON THE FILESYSTEM', () => {
  const workspace = makeWorkspace('cli-lock');
  const resolver = new NarrativeMemoryConfigResolver({ env: {}, readConfigFile: () => undefined });
  resolver.setCliOptions(readCliOptions({ 'narrative-index-db': 'locked/by-cli.db' }));

  const result = resolver.setRuntimeOverrides({ databasePath: 'from-settings.db' });
  assert.deepEqual(result.rejected, [{ key: 'databasePath', reason: 'locked-by-cli' }]);

  // ASSERTED ON THE FILESYSTEM, not on the field in the answer: an
  // implementation could report a rejection and still open the other file.
  const registry = new NarrativeIndexStoreRegistry({ resolver, heartbeatIntervalMs: 0 });
  registry.acquire(workspace.root);
  assert.equal(existsSync(join(workspace.root, 'locked/by-cli.db')), true, 'the CLI path holds no database');
  assert.equal(
    existsSync(join(workspace.root, 'from-settings.db')),
    false,
    'the rejected settings path was opened anyway'
  );
  registry.closeAll();
});

test('ОВ-9б: without the CLI flag the same patch IS applied — "always reject" must fail here', () => {
  const resolver = new NarrativeMemoryConfigResolver({ env: {}, readConfigFile: () => undefined });
  const result = resolver.setRuntimeOverrides({ databasePath: 'from-settings.db' });
  assert.deepEqual(result.rejected, []);
  assert.equal(resolver.resolve(ROOT).databasePath, 'from-settings.db');
});

test('ОВ-9а: the per-workspace file is read from the path the spec names, on a real disk', () => {
  // The other cases inject the file's CONTENT; this one proves the LOCATION,
  // which no injected reader can.
  const workspace = makeWorkspace('config-file');
  mkdirSync(join(workspace.root, '.theia'), { recursive: true });
  writeFileSync(
    join(workspace.root, NARRATIVE_MEMORY_CONFIG_FILE),
    JSON.stringify({ debounceMs: 4321, maxOpenWorkspaces: 7, diagnosticsEnabled: false })
  );
  const resolver = new NarrativeMemoryConfigResolver({ env: {} });
  const config = resolver.resolve(workspace.root);
  assert.equal(config.debounceMs, 4321);
  assert.equal(config.maxOpenWorkspaces, 7);
  assert.equal(config.diagnosticsEnabled, false);
});

after(() => disposeAll());
