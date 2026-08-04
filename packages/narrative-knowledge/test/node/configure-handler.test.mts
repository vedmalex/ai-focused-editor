/**
 * `configure(patch)` ON THE REAL LADDER (TASK-022 WP-4b, tech_spec ОВ-9б teeth
 * 1, 2 and 6).
 *
 * WHY THESE THREE ARE HERE AND THE OTHER THREE ARE IN THE CONTRACT CORE. Teeth
 * 3, 4 and 5 are about the arithmetic above rung 1 — idempotence, the
 * absent-versus-`undefined` distinction, refusal instead of clamping — and that
 * arithmetic is identical whatever is underneath, so it runs in BOTH lanes
 * against both config stores. These three are about the ladder ITSELF and about
 * a real database file:
 *
 *   - tooth 1 asks who WINS at every rung when `configure` is the top one. A
 *     double with a single spread cannot answer that, because it has no rungs.
 *   - tooth 2's second half asks whether a refusal is real ON THE FILESYSTEM.
 *     `config-ladder.test.mts` already proves it for the raw `setRuntimeOverrides`
 *     storage; what was never covered is the same refusal coming back through
 *     `configure` as a `ConfigureResult`, which is the surface WP-5 actually
 *     calls.
 *   - tooth 6 asks whether a patch that arrives BEFORE the first store is opened
 *     decides which file gets opened. There is no store to ask; there is only a
 *     file that does or does not exist.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  NARRATIVE_MEMORY_ENV,
  NarrativeMemoryConfigResolver
} from '../../lib/node/narrative-memory-config-resolver.js';
import { readCliOptions } from '../../lib/node/narrative-knowledge-cli-contribution.js';
import {
  NarrativeIndexStoreRegistry,
  canonicalWorkspaceKey
} from '../../lib/node/narrative-index-store-registry.js';
import {
  DEFAULT_NARRATIVE_MEMORY_CONFIG,
  NarrativeMemoryConfigurator
} from '../../lib/common/index.js';
import { disposeAll, makeWorkspace } from './harness.mts';

const ROOT = '/tmp/does-not-need-to-exist';

const FILE_VALUE = 5001;
const ENV_VALUE = 5002;
const CLI_VALUE = 5003;
const PATCH_VALUE = 5004;

function resolverWith(options: { env?: Record<string, string | undefined>; file?: unknown }) {
  return new NarrativeMemoryConfigResolver({
    env: options.env ?? {},
    readConfigFile: () => (options.file === undefined ? undefined : JSON.stringify(options.file))
  });
}

test('ОВ-9б tooth 1: with `configure` as rung 1, the winner is asserted at EVERY rung', () => {
  // ONE CASE ON THE TOP IS NOT ENOUGH, and that is the whole shape of this
  // tooth: a completely broken ladder — every lower rung ignored — still gives
  // the right answer when the top one is set. So all five sources carry
  // DISTINGUISHABLE values, and they come off one at a time.
  const resolver = resolverWith({
    env: { [NARRATIVE_MEMORY_ENV.debounceMs]: String(ENV_VALUE) },
    file: { debounceMs: FILE_VALUE }
  });
  resolver.setCliOptions({ debounceMs: CLI_VALUE });
  const configurator = new NarrativeMemoryConfigurator(resolver);

  const applied = configurator.configure({ debounceMs: PATCH_VALUE }, ROOT);
  assert.equal(applied.effective.debounceMs, PATCH_VALUE, 'rung 1 (the configure patch) did not win');
  assert.deepEqual(applied.applied, ['debounceMs']);

  // Rung 1 comes off THROUGH THE PRODUCT PATH — an explicit `undefined`, which
  // is the only way a user can put a setting back. Rebuilding the resolver
  // instead would test the ladder without testing the reset.
  const reset = configurator.configure({ debounceMs: undefined }, ROOT);
  assert.equal(reset.effective.debounceMs, CLI_VALUE, 'rung 2 (CLI flag) did not take over after the reset');

  // Rung 2 comes off through the CLI contribution's own setter.
  resolver.setCliOptions({});
  assert.equal(resolver.resolve(ROOT).debounceMs, ENV_VALUE, 'rung 3 (environment) did not take over');

  // Rungs 3 and 4 are constructor-injected, so removing them means a new
  // resolver. Stated rather than hidden: this half is the same construction
  // `config-ladder.test.mts` uses, and it is the honest limit of the setup.
  assert.equal(resolverWith({ file: { debounceMs: FILE_VALUE } }).resolve(ROOT).debounceMs, FILE_VALUE,
    'rung 4 (the per-workspace file) did not win over the defaults');
  assert.equal(resolverWith({}).resolve(ROOT).debounceMs, DEFAULT_NARRATIVE_MEMORY_CONFIG.debounceMs,
    'rung 5 (the defaults) is not the floor');
});

test('ОВ-9б tooth 2: `configure` reports `locked-by-cli`, and the LOCK IS REAL ON DISK', () => {
  const workspace = makeWorkspace('configure-cli-lock');
  const root = canonicalWorkspaceKey(workspace.root);
  const resolver = new NarrativeMemoryConfigResolver({ env: {}, readConfigFile: () => undefined });
  resolver.setCliOptions(readCliOptions({ 'narrative-index-db': 'locked/by-cli.db' }));
  const configurator = new NarrativeMemoryConfigurator(resolver);

  const answer = configurator.configure({ databasePath: 'from-settings.db' }, root);
  assert.deepEqual(answer.rejected, [{ key: 'databasePath', reason: 'locked-by-cli' }]);
  assert.deepEqual(answer.deferred, [], 'a locked key is refused, not merely postponed');

  // ASSERTED ON THE FILESYSTEM, not on the field in the answer: an
  // implementation could report the rejection and still open the other file.
  const registry = new NarrativeIndexStoreRegistry({ resolver, heartbeatIntervalMs: 0 });
  registry.acquire(root);
  assert.equal(existsSync(join(root, 'locked/by-cli.db')), true, 'the CLI path holds no database');
  assert.equal(existsSync(join(root, 'from-settings.db')), false, 'the rejected path was opened anyway');
  registry.closeAll();
});

test('ОВ-9б tooth 2 (REJECTING): without the flag the SAME patch is accepted and deferred', () => {
  // Without this, "always reject `databasePath`" would pass the case above.
  const resolver = new NarrativeMemoryConfigResolver({ env: {}, readConfigFile: () => undefined });
  const answer = new NarrativeMemoryConfigurator(resolver).configure({ databasePath: 'chosen.db' }, ROOT);
  assert.deepEqual(answer.rejected, []);
  assert.deepEqual(answer.deferred, [{ key: 'databasePath', until: 'next-backend-start' }]);
  assert.equal(resolver.resolve(ROOT).databasePath, 'chosen.db');
});

test('ОВ-9б tooth 6: a patch that arrives BEFORE the first store open decides which file is opened', () => {
  // THE WINDOW R-11 WAS BUILT AROUND. The first store open happens on the first
  // RPC call carrying a `rootUri`, not at boot — so a `configure` really can
  // arrive first, and the value has to be waiting for it. Reported as
  // `deferred` (the open file cannot be re-aimed) and STORED all the same,
  // which is the distinction this case exists to pin: an implementation that
  // treated "deferred" as "discarded" opens the default file here.
  const workspace = makeWorkspace('configure-before-open');
  const root = canonicalWorkspaceKey(workspace.root);
  const resolver = new NarrativeMemoryConfigResolver({ env: {}, readConfigFile: () => undefined });
  const configurator = new NarrativeMemoryConfigurator(resolver);

  const answer = configurator.configure({ databasePath: '.theia/chosen-before-open.db' }, root);
  assert.deepEqual(answer.deferred, [{ key: 'databasePath', until: 'next-backend-start' }]);

  const registry = new NarrativeIndexStoreRegistry({ resolver, heartbeatIntervalMs: 0 });
  assert.equal(registry.isOpen(root), false, 'nothing was open when the patch arrived');
  registry.acquire(root);

  assert.equal(
    existsSync(join(root, '.theia/chosen-before-open.db')),
    true,
    'the store opened the file the pre-open patch named'
  );
  assert.equal(
    existsSync(join(root, DEFAULT_NARRATIVE_MEMORY_CONFIG.databasePath)),
    false,
    'and not the default one'
  );
  registry.closeAll();
});

test('ОВ-9б tooth 6 (REJECTING): with no patch, the SAME setup opens the DEFAULT file', () => {
  // Without this the case above passes against an implementation that always
  // opened `.theia/chosen-before-open.db`, or against a fixture whose "default"
  // never existed in the first place.
  const workspace = makeWorkspace('configure-no-patch');
  const root = canonicalWorkspaceKey(workspace.root);
  const resolver = new NarrativeMemoryConfigResolver({ env: {}, readConfigFile: () => undefined });
  const registry = new NarrativeIndexStoreRegistry({ resolver, heartbeatIntervalMs: 0 });
  registry.acquire(root);
  assert.equal(existsSync(join(root, DEFAULT_NARRATIVE_MEMORY_CONFIG.databasePath)), true);
  assert.equal(existsSync(join(root, '.theia/chosen-before-open.db')), false);
  registry.closeAll();
});

after(() => disposeAll());
