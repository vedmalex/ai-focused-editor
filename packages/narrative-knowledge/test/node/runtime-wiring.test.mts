/**
 * The run itself, and the pinned engine surface (TASK-022 WP-3, plan R-3,
 * tech_spec ОВ-7).
 *
 * A test mode that is not woven into `verify` will never run, and is therefore
 * indistinguishable from one that does not exist — there is no CI in this
 * repository, so the local `bun run verify` is the only gate there is. The
 * first two tests here are about the WIRING rather than about the store, and
 * they belong in the node lane because that is where a claim about the node
 * lane can be checked against the node lane actually running.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PACKAGE_ROOT, REPO_ROOT } from './harness.mts';

// --------------------------------------------------------------------------
// The run is real
// --------------------------------------------------------------------------

test('globalThis.gc is available — --expose-gc really reached this process', () => {
  // MEASURED, NOT ASSUMED. With Node's DEFAULT test isolation the runner spawns
  // a child per file and does NOT forward `--expose-gc`; `globalThis.gc` comes
  // back `undefined` and this assertion fails. That is why the runner script
  // passes `--experimental-test-isolation=none`, and why this test exists at
  // all: without it the flag could be silently ineffective for the whole life
  // of the epic, and the budget checks that need it would quietly measure
  // nothing.
  assert.equal(typeof globalThis.gc, 'function', 'globalThis.gc is not exposed in this process');
});

test('the node run is wired into the root `test` script, with --expose-gc', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const scripts = manifest.scripts;

  assert.ok(
    scripts.test.includes('test:narrative-index'),
    `the root \`test\` script does not call the node run: ${scripts.test}`
  );
  assert.ok(
    scripts.verify.includes('bun run test'),
    `\`verify\` does not run \`test\`: ${scripts.verify}`
  );
  // `verify` must BUILD before it TESTS: these tests import the built output,
  // and so does every cross-package import in this repository.
  assert.ok(
    scripts.verify.indexOf('build:packages') < scripts.verify.indexOf('bun run test'),
    `\`verify\` tests before it builds: ${scripts.verify}`
  );

  const runner = readFileSync(join(REPO_ROOT, 'scripts/narrative-index-node-run.mjs'), 'utf8');
  assert.ok(runner.includes("'--expose-gc'"), 'the runner does not pass --expose-gc');
  assert.ok(
    runner.includes("'--disable-warning=ExperimentalWarning'"),
    'the runner does not silence the node:sqlite ExperimentalWarning for the test run'
  );

  // And the `bun` lane must NOT try to run these files: `bun` cannot resolve
  // `node:sqlite`, so a missing exclusion turns the whole main test run red.
  assert.ok(
    scripts['test:packages'].includes('narrative-knowledge/test/node/**'),
    `\`test:packages\` does not exclude the node-only directory: ${scripts['test:packages']}`
  );
});

test('the ExperimentalWarning is silenced ONLY in the test run, never in the product', () => {
  // The alternatives were rejected on purpose: `--no-warnings` on the product
  // backend, or attaching a `process.on('warning')` filter, would suppress
  // EVERY experimental warning in the process — including future ones from
  // Theia that will be saying something worth hearing. Gagging a diagnostic
  // channel to hide one known line is the class of behaviour this epic exists
  // to remove, so the product keeps the warning and prints one structural
  // `engine` record beside it instead.
  for (const relative of [
    'src/node/sqlite-narrative-index-store.ts',
    'src/node/narrative-knowledge-backend-module.ts',
    'src/node/narrative-index-store-registry.ts'
  ]) {
    const source = readFileSync(join(PACKAGE_ROOT, relative), 'utf8');
    assert.equal(
      /process\.on\(\s*['"]warning['"]/.test(source),
      false,
      `${relative} attaches a global warning listener`
    );
    assert.equal(
      /removeAllListeners\(\s*['"]warning['"]/.test(source),
      false,
      `${relative} removes the warning listeners`
    );
    assert.equal(source.includes('--no-warnings'), false, `${relative} disables warnings in the product`);
  }
});

// --------------------------------------------------------------------------
// ОВ-7 — the pinned API subset, stated BY COMPLEMENT
// --------------------------------------------------------------------------

/** Everything the adapter is allowed to touch on either class. */
const ALLOWED_MEMBERS = new Set(['exec', 'prepare', 'close', 'run', 'get', 'all', 'iterate']);

/**
 * Every member name the LIVE prototypes carry, minus the allow-list.
 *
 * READ FROM THE RUNTIME, NEVER FROM A HAND-KEPT ARRAY. That is the whole
 * correction ISS-313 made: a scan for a list of FORBIDDEN names misses anything
 * that is on neither list, and the earlier edition missed
 * `enableLoadExtension`/`loadExtension` exactly that way. Deriving the forbidden
 * set as "the prototypes minus the allow-list" means a member a future Node adds
 * is forbidden the day it appears, with nobody having to remember.
 *
 * IT IS STILL NOT SUFFICIENT ON ITS OWN, AND THIS RUN PROVED IT. ОВ-7 names
 * `DatabaseSync.backup` among the forbidden members — but `backup` IS NOT ON
 * THE Node 24.9.0 PROTOTYPE (measured: `open, close, prepare, exec, function,
 * createTagStore, location, aggregate, createSession, applyChangeset,
 * enableLoadExtension, loadExtension`). A set derived only from THIS runtime
 * therefore cannot see a member that exists on some OTHER Node — and Electron
 * carries a different one. So the database handle gets a SECOND check below
 * that is a true complement: every member touched on it must be in the
 * allow-list, whatever any prototype happens to say.
 */
function forbiddenMembers(): string[] {
  const statement = new DatabaseSync(':memory:').prepare('SELECT 1');
  const names = new Set([
    ...Object.getOwnPropertyNames(DatabaseSync.prototype),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(statement))
  ]);
  names.delete('constructor');
  return [...names].filter(name => !ALLOWED_MEMBERS.has(name));
}

/**
 * Every member the adapter touches ON A DATABASE HANDLE.
 *
 * This is the complement check proper: it does not ask what the prototype
 * offers, it asks what the source USES, and reports anything outside the
 * allow-list — including a member no Node in this room has. The handle is
 * always spelled `this.db` or `db` in this adapter, which the test below pins
 * so the scan cannot silently stop matching.
 */
function databaseMembersUsed(source: string): string[] {
  const code = stripComments(source);
  const used = new Set<string>();
  for (const match of code.matchAll(/\bdb\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    used.add(match[1]);
  }
  return [...used].filter(name => !ALLOWED_MEMBERS.has(name)).sort();
}

/** Blank out comments, so a member NAMED IN PROSE is not read as a call. The
 *  module docs discuss the forbidden members on purpose — that is how the rule
 *  stays understandable — and counting those mentions would make the check fail
 *  on its own documentation. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function membersUsedOutsideAllowList(source: string): string[] {
  const code = stripComments(source);
  return forbiddenMembers().filter(name => new RegExp(`\\.\\s*${name}\\b`).test(code));
}

const ADAPTER_SOURCE = join(PACKAGE_ROOT, 'src/node/sqlite-narrative-index-store.ts');

test('ОВ-7: the adapter touches no node:sqlite member outside the pinned allow-list', () => {
  const source = readFileSync(ADAPTER_SOURCE, 'utf8');
  assert.deepEqual(
    membersUsedOutsideAllowList(source),
    [],
    'the adapter uses a node:sqlite prototype member outside the pinned subset'
  );
  assert.deepEqual(
    databaseMembersUsed(source),
    [],
    'the adapter touches a member on the database handle that is not in the pinned subset'
  );
  // The scan is only as good as its ability to FIND the handle. If the adapter
  // is ever refactored to name it something else, this pins the moment.
  assert.ok(source.includes('this.db.'), 'the database handle is no longer spelled `this.db`');
  console.log(
    `[narrative-index] pinned API check: ${forbiddenMembers().length} forbidden prototype members ` +
      `on node ${process.version}, plus a complement scan of every member used on the db handle`
  );
});

test('ОВ-7 rejecting case 1: introducing db.backup( reddens the check', () => {
  // AND NOTE WHICH CHECK CATCHES IT. `backup` is NOT on this Node's prototype,
  // so the prototype-derived scan is blind to it — only the complement scan of
  // the handle sees it. That is precisely why both exist.
  const source = readFileSync(ADAPTER_SOURCE, 'utf8');
  const perturbed = source.replace('this.db.close();', 'this.db.backup();\n    this.db.close();');
  assert.notEqual(perturbed, source, 'the perturbation did not change the source');
  assert.deepEqual(membersUsedOutsideAllowList(perturbed), [], 'this Node unexpectedly has `backup`');
  assert.deepEqual(databaseMembersUsed(perturbed), ['backup']);
});

test('ОВ-7 rejecting case 2: introducing db.enableLoadExtension( reddens BOTH checks', () => {
  // THE ONE THE OLD FORMULATION LET THROUGH. `enableLoadExtension` and
  // `loadExtension` exist on the verified Node 24 prototype and appeared on
  // neither the ALLOWED nor the FORBIDDEN list, so a scan for forbidden names
  // passed them green. Stating the rule by complement is what fixed it, and
  // without this case the fix is unverifiable.
  const source = readFileSync(ADAPTER_SOURCE, 'utf8');
  const perturbed = source.replace(
    'this.db.close();',
    'this.db.enableLoadExtension(true);\n    this.db.close();'
  );
  assert.notEqual(perturbed, source, 'the perturbation did not change the source');
  assert.deepEqual(membersUsedOutsideAllowList(perturbed), ['enableLoadExtension']);
  assert.deepEqual(databaseMembersUsed(perturbed), ['enableLoadExtension']);
});

test('ОВ-7 rejecting case 3: a member on NO list at all is still caught', () => {
  // The failure mode ISS-313 describes, taken to its limit: a name that is on
  // neither the allow-list nor any prototype anywhere. An enumeration cannot
  // catch this by construction; a complement does.
  const source = readFileSync(ADAPTER_SOURCE, 'utf8');
  const perturbed = source.replace(
    'this.db.close();',
    'this.db.someMemberInventedByANodeThatDoesNotExistYet();\n    this.db.close();'
  );
  assert.notEqual(perturbed, source, 'the perturbation did not change the source');
  assert.deepEqual(databaseMembersUsed(perturbed), ['someMemberInventedByANodeThatDoesNotExistYet']);
});

test('ОВ-7: the constructor option `timeout` is not used — busy_timeout is a PRAGMA', () => {
  const source = stripComments(readFileSync(ADAPTER_SOURCE, 'utf8'));
  assert.equal(/timeout\s*:/.test(source), false, 'the adapter passes a `timeout` constructor option');
  const schema = readFileSync(join(PACKAGE_ROOT, 'src/node/narrative-index-schema.ts'), 'utf8');
  assert.ok(schema.includes('PRAGMA busy_timeout = 5000'), 'busy_timeout is not set as a pragma');
});
