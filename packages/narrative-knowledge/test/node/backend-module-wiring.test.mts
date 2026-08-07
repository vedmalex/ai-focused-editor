/**
 * The backend module really ASSEMBLES (TASK-022 WP-5).
 *
 * WHY THIS FILE EXISTS. Every other test in this package builds its subject
 * with `new`, or hands the service its collaborators by field assignment. That
 * is the right shape for testing behaviour — but it means the inversify
 * container is never assembled, and a binding can be wrong in a way NOTHING in
 * `verify` observes. It happened: `NarrativeMemoryConfigResolver` was bound
 * with `toSelf()`, its one OPTIONAL constructor parameter was recorded by
 * `emitDecoratorMetadata` as a design type of `Object`, and inversify tried to
 * resolve `Object`:
 *
 *   Error: No matching bindings found for serviceIdentifier: Object
 *   Trying to resolve bindings for "NarrativeMemoryConfigResolver"
 *
 * The throw came at backend startup and took the WHOLE module down — no RPC
 * handler, no localization, no index — and `bun run verify` stayed EXIT 0
 * through all of it. It was found by starting the real application, which
 * `verify` does not do (that is `verify:full`).
 *
 * So this file loads the ACTUAL `ContainerModule` the application loads and
 * resolves what a boot resolves. It cannot replace a smoke run — it has no
 * Theia application around it — but it closes the specific class of defect that
 * one found: a binding that only fails when something asks for it.
 *
 * ONE-BY-ONE, NOT `container.load(...)` AND HOPE. A module that binds fine and
 * resolves badly is exactly the case here, so each identifier is GOT, not just
 * bound.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import 'reflect-metadata';
import { PACKAGE_ROOT } from './harness.mts';
import { NarrativeKnowledgeService } from '../../lib/common/index.js';
import { NodeNarrativeKnowledgeService } from '../../lib/node/node-narrative-knowledge-service.js';
import { NarrativeMemoryConfigResolver } from '../../lib/node/narrative-memory-config-resolver.js';
import { NarrativeKnowledgeCliContribution } from '../../lib/node/narrative-knowledge-cli-contribution.js';
import { NarrativeIndexStoreRegistry } from '../../lib/node/narrative-index-store-registry.js';
import { NarrativeMemoryRuLocalizationContribution } from '../../lib/node/i18n/narrative-memory-ru-localization-contribution.js';
import backendModule from '../../lib/node/narrative-knowledge-backend-module.js';

/**
 * `Container` FROM THE SAME INVERSIFY THE BUILT MODULE USED.
 *
 * An ordinary `import { Container } from '@theia/core/shared/inversify'` here
 * loads a SECOND copy of the library, and inversify's `Container.load` then
 * fails with `currentModule.registry is not a function` — a `ContainerModule`
 * built by one copy is not recognised by the other. Resolving through the
 * built module's own directory pins both to one instance, which is also what
 * the running application has.
 */
const requireFromLib = createRequire(join(PACKAGE_ROOT, 'lib', 'node', 'index.cjs'));
const { Container } = requireFromLib('@theia/core/shared/inversify') as {
  Container: new () => {
    load(module: unknown): void;
    bind(identifier: unknown): { toConstantValue(value: unknown): void };
    get<T>(identifier: T): T extends new (...args: never[]) => infer I ? I : unknown;
    isBound(identifier: unknown): boolean;
  };
};

const { FileSystemWatcherService } = requireFromLib(
  '@theia/filesystem/lib/common/filesystem-watcher-protocol'
) as { FileSystemWatcherService: unknown };
const { FileSystemWatcherServiceDispatcher } = requireFromLib(
  '@theia/filesystem/lib/node/filesystem-watcher-dispatcher'
) as { FileSystemWatcherServiceDispatcher: unknown };

/**
 * A container holding the package's module, plus the two Theia identifiers the
 * module's watcher factory reaches for.
 *
 * STUBBED RATHER THAN OMITTED. The service binding CLOSES OVER
 * `FileSystemWatcherService` and `FileSystemWatcherServiceDispatcher`, and a
 * container without them cannot resolve the service at all — which would make
 * the case below pass or fail for the wrong reason. Constant values are enough:
 * nothing here calls the factory, and what is under test is whether the
 * container can BUILD the service, not what the watcher does.
 */
function loadModule() {
  const container = new Container();
  container.bind(FileSystemWatcherService).toConstantValue({} as never);
  container.bind(FileSystemWatcherServiceDispatcher).toConstantValue({} as never);
  // THE DOUBLE `.default` IS NOT PARANOIA. The package builds to CommonJS, so
  // `export default new ContainerModule(...)` becomes `exports.default = ...`;
  // importing that from ESM hands back the whole `module.exports` object as the
  // default binding, and passing THAT to `container.load` fails with
  // `currentModule.registry is not a function` — an error that reads like two
  // copies of inversify and is not.
  const module = (backendModule as { default?: unknown }).default ?? backendModule;
  container.load(module);
  return container;
}

test('the config resolver RESOLVES through the container, not merely binds', () => {
  // THE REGRESSION. `toSelf()` binds without complaint and throws on `get`.
  const container = loadModule();
  const resolver = container.get(NarrativeMemoryConfigResolver);
  assert.ok(resolver instanceof NarrativeMemoryConfigResolver);
  // And it is a singleton, so the CLI flags land in the instance everything
  // else reads — the reason the binding is `inSingletonScope` at all.
  assert.equal(container.get(NarrativeMemoryConfigResolver), resolver);
});

test('the CLI contribution resolves — it is what injects the resolver at boot', () => {
  // The actual throw site: `CliContribution`s are collected during backend
  // startup, and this one has an `@inject(NarrativeMemoryConfigResolver)`.
  const container = loadModule();
  const cli = container.get(NarrativeKnowledgeCliContribution);
  assert.ok(cli instanceof NarrativeKnowledgeCliContribution);
});

test('the store registry resolves and shares the singleton resolver', () => {
  const container = loadModule();
  const registry = container.get(NarrativeIndexStoreRegistry);
  assert.ok(registry instanceof NarrativeIndexStoreRegistry);
  assert.equal(container.get(NarrativeIndexStoreRegistry), registry);
});

test('the ru localization contribution resolves and really registers the bundle', () => {
  // WP-1 wrote the bundle; WP-5 binds it. A `LocalizationContribution` that
  // resolves but registers nothing is a translation nobody sees, and every
  // phrase silently falls back to its English default — the exact shape ISS-258
  // shipped into a Russian-first product with every test green.
  const container = loadModule();
  const contribution = container.get(NarrativeMemoryRuLocalizationContribution);
  assert.ok(contribution instanceof NarrativeMemoryRuLocalizationContribution);

  const registered: { language: unknown; bundle: unknown }[] = [];
  const registry = {
    registerLocalizationFromRequire(language: unknown, bundle: unknown): void {
      registered.push({ language, bundle });
    }
  };
  return contribution.registerLocalizations(registry as never).then(() => {
    assert.equal(registered.length, 1);
    const language = registered[0].language as { languageId: string; languagePack: boolean };
    assert.equal(language.languageId, 'ru');
    // `languagePack: true` is what makes the frontend APPLY the translations.
    // Without it the registration succeeds and changes nothing.
    assert.equal(language.languagePack, true);
    const bundle = registered[0].bundle as Record<string, Record<string, Record<string, string>>>;
    assert.equal(
      typeof bundle['ai-focused-editor']['narrative-memory']['index-failure-internal'],
      'string'
    );
  });
});

test('THE RPC SERVICE ITSELF RESOLVES — the one the connection handler hands to every frontend', () => {
  // THE SECOND REGRESSION WP-5 FOUND, and the more damaging one. The service was
  // bound with `toDynamicValue(ctx => ctx.container.resolve(NodeNarrativeKnowledgeService))`
  // — naming, inside its own factory, the identifier being bound. `resolve`
  // goes back through that same binding, and inversify reports the recursion as
  //
  //   "You are attempting to construct Symbol(NarrativeKnowledgeService) in a
  //    synchronous way but it has asynchronous dependencies"
  //
  // which names neither the cause nor the file. `ConnectionHandler`'s factory
  // performs exactly this `get` when a frontend connects, so the RPC target
  // came back broken and every call from the browser died with
  // `TypeError: this.target[method] is not a function`.
  const container = loadModule();
  const service = container.get(NarrativeKnowledgeService) as {
    getIndexStatus: unknown;
    getRebuildAvailability: unknown;
    createWatcher: unknown;
  };
  assert.equal(typeof service.getIndexStatus, 'function');
  // WP-5's addition, over the same wire.
  assert.equal(typeof service.getRebuildAvailability, 'function');

  // ONE INSTANCE, AND IT HAS ITS WATCHER. `onActivation` attaches the factory
  // to whichever `get` builds the singleton first — including the `onStop`
  // binding, which would otherwise be a way to obtain a watcher-less service by
  // asking in an unlucky order.
  assert.equal(typeof service.createWatcher, 'function');
  assert.equal(container.get(NodeNarrativeKnowledgeService), service);
});

test('every identifier this package owns is bound — a silently dropped binding is a silently dead feature', () => {
  const container = loadModule();
  for (const identifier of [
    NarrativeMemoryConfigResolver,
    NarrativeKnowledgeCliContribution,
    NarrativeIndexStoreRegistry,
    NarrativeMemoryRuLocalizationContribution
  ]) {
    assert.equal(container.isBound(identifier), true, `${String(identifier)} is not bound`);
  }
});
