import { readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

// Shared round-trip assertion for the narrative-knowledge RPC service
// (TASK-022 WP-0).
//
// WP-0's readiness requires the round-trip proven in BOTH targets. Both smoke
// runners therefore need the same assertion, and it is defined ONCE here for
// the reason this repository keeps rediscovering: two copies of one check
// drift, and the drift is only noticed when the weaker copy is the one that
// ran.
//
// The evidence is a value `NarrativeKnowledgeRoundTripProbe` records on a
// window global at frontend start. The global's NAME is a contract between
// this file and the probe — see
// `packages/narrative-knowledge/src/browser/narrative-knowledge-round-trip-probe.ts`.
//
// WHY A GLOBAL AND NOT THE CONSOLE LINE the probe also prints: in the electron
// target no console listener can exist before the window does, so a line
// emitted during frontend start is unobservable. The first version of this
// check read the console, passed in the browser and reported "never wired" in
// electron for a target that was wired correctly. A recorded value has no such
// race.

export const NARRATIVE_KNOWLEDGE_PROBE_GLOBAL = '__afeNarrativeKnowledgeRoundTrip';

// ---------------------------------------------------------------------------
// TASK-022 ISS-365 — both smoke runners must drive an ISOLATED COPY of the
// fixture manuscript, never `examples/sample-book` itself.
// ---------------------------------------------------------------------------
//
// Both smokes used to point Theia straight at `examples/sample-book`, a
// directory INSIDE this repository. Three consequences, all observed:
//   - `bun run verify` cannot pass while the author has the sample book open
//     in a real editor: `rebuild()` rejects with `foreign-writer` because a
//     live writer already owns the narrative-knowledge database lock (see
//     `rebuildRoundTripReaderScript`'s availability check below);
//   - every run leaves `examples/sample-book/.theia/narrative-index.db`
//     (`-shm`/`-wal`) behind, dirtying the working tree;
//   - `assertNarrativeKnowledgeWatcherSelfUpdates` edits
//     `content/chapter-01.md` IN THE REPOSITORY (restored in its own
//     `finally`, but a mid-run crash would leave that edit in the author's
//     tree).
//
// The fix is a throwaway copy per run, created with `fs.mkdtemp` and removed
// afterward. `.theia/` is excluded from the copy ON PURPOSE: right now it
// holds a live writer-lock row from whatever editor has the real
// `examples/sample-book` open, and copying it would reproduce the exact
// `foreign-writer` failure this closes instead of fixing it.
//
// THE REALPATH CALL IS NOT OPTIONAL. On macOS, `mkdtemp` returns a path under
// `/var/folders/...`, itself a symlink to `/private/var/...`. The
// narrative-knowledge maintainer stores `workspace_root` in its `meta` table
// from the URI Theia hands it, and the parcel file watcher resolves the paths
// it observes through its own (dereferenced) view of the filesystem; if the
// two disagree about which side of the symlink is canonical, the watcher's
// own edits stop matching the maintainer's expected root and
// `assertNarrativeKnowledgeWatcherSelfUpdates` goes red for an environment
// reason that has nothing to do with the product. Resolving once, here, at
// creation, keeps both sides on the same path for the rest of the run.

function isExcludedFromSampleWorkspaceCopy(source, sourceRoot) {
  const rel = relative(sourceRoot, source);
  return rel === '.theia' || rel.startsWith(`.theia${sep}`);
}

/**
 * Create a disposable, isolated copy of the fixture manuscript for one smoke
 * run. Returns the realpath-resolved temp directory (`workspaceDir`, for
 * cleanup) and the exact path to hand to Theia/Electron as the workspace
 * root (`sampleRoot`).
 *
 * `.theia/` is deliberately excluded from the copy — see the section comment
 * above.
 */
export async function createIsolatedSampleWorkspace(sourceSampleRoot) {
  const rawWorkspaceDir = await mkdtemp(join(tmpdir(), 'afe-sample-book-'));
  // Dereference NOW — see the section comment above, this is load-bearing,
  // not defensive.
  const workspaceDir = await realpath(rawWorkspaceDir);
  const sampleRoot = join(workspaceDir, 'sample-book');
  await cp(sourceSampleRoot, sampleRoot, {
    recursive: true,
    filter: source => !isExcludedFromSampleWorkspaceCopy(source, sourceSampleRoot)
  });
  return { workspaceDir, sampleRoot };
}

/**
 * Remove a workspace created by {@link createIsolatedSampleWorkspace}.
 *
 * Best-effort: a cleanup failure is logged, never thrown — the whole point of
 * calling this from a `finally` is to not obscure the smoke run's real
 * result with a teardown problem.
 */
export async function removeIsolatedSampleWorkspace(workspaceDir) {
  if (!workspaceDir) {
    return;
  }
  try {
    await rm(workspaceDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`WARN could not remove temporary smoke workspace ${workspaceDir}: ${String(error)}`);
  }
}

/**
 * Poll `readProbeResult` until the probe has recorded an outcome, then assert
 * that outcome is a successful round-trip carrying a well-formed `IndexState`.
 *
 * `readProbeResult` is supplied by the caller because the two runners evaluate
 * in the renderer differently (`page.evaluate` vs `window.evaluate`); the
 * JUDGEMENT about what counts as a passing round-trip lives here, once.
 *
 * Three failures, three different messages, on purpose:
 *   - nothing recorded -> the frontend module is not wired into this target;
 *   - `ok: false`      -> the binding exists but the backend did not answer,
 *                         so the RPC path or the backend module is wrong;
 *   - malformed status -> it answered with something that is not an IndexState.
 */
export async function assertNarrativeKnowledgeRoundTrip(readProbeResult, target, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  while (Date.now() < deadline) {
    result = await readProbeResult();
    if (result) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (!result) {
    throw new Error(
      `[${target}] narrative-knowledge round-trip probe never recorded an outcome. ` +
      'The frontend module is most likely not wired into this target.'
    );
  }
  if (!result.ok) {
    throw new Error(`[${target}] narrative-knowledge round-trip FAILED: ${result.error}`);
  }

  const status = result.status;
  if (typeof status?.state !== 'string' || typeof status?.generation !== 'number') {
    throw new Error(
      `[${target}] narrative-knowledge round-trip returned something that is not an IndexState: ` +
      JSON.stringify(status)
    );
  }

  console.log(`PASS [${target}] narrative-knowledge RPC round-trip: ${JSON.stringify(status)}`);
}

/** Renderer-side reader, shared by both runners so the global is named once. */
export function probeReaderScript(globalName = NARRATIVE_KNOWLEDGE_PROBE_GLOBAL) {
  return `window[${JSON.stringify(globalName)}] ?? null`;
}

// ---------------------------------------------------------------------------
// TASK-022 ISS-354 AC-6 — the round-trip must prove a BUILT, POPULATED index,
// not just that the RPC channel answers with the right shape.
// ---------------------------------------------------------------------------
//
// The start-up probe above only ever observes `absent`/`not-built`: nothing
// in either smoke run ever asked for a rebuild, so "feature works" was proven
// only under bare `node` (the package's own tests), never through either
// runtime target. This closes that gap by driving the SAME RPC service the
// UI's "Rebuild Index" command drives, through the Theia DI container that is
// already reachable from both runners (`toolRegistryReaderScript` above does
// the same container walk for a different binding).
//
// examples/sample-book IS the fixture manuscript: it already ships a
// `manifest.yaml`, chapters and entity cards (see `examples/sample-book/`),
// so no second fixture is needed — both smokes already point their target at
// it.

/**
 * Renderer-side reader: resolve the open workspace root, ask whether a
 * rebuild is even allowed right now, read the state BEFORE, then rebuild and
 * return both the before-state and the resulting envelope.
 *
 * THE AVAILABILITY CHECK IS NOT OPTIONAL. `rebuild()` REJECTS outright when a
 * live foreign writer owns the database (protocol: `NarrativeKnowledgeService
 * .rebuild`), and `verify:full` runs the browser smoke and the electron smoke
 * back to back against the SAME workspace directory. Without this check a
 * leftover lock turns into an opaque RPC rejection that reads as a product
 * failure instead of the environment issue it is.
 *
 * THE BEFORE-STATE IS READ TOO, on purpose: `examples/sample-book/.theia/` is
 * gitignored, not deleted between runs, so a leftover database can already
 * report `ready` before this script ever calls `rebuild()`. A check that only
 * asserted the AFTER state would be green even if the rebuild call were
 * silently skipped. Comparing `generation` before vs after is the part that
 * actually proves THIS call did the work — see
 * {@link assertNarrativeKnowledgeRebuildReady}.
 */
export function rebuildRoundTripReaderScript() {
  return `(async () => {
    const container = window.theia && window.theia.container;
    if (!container) { return { ok: false, error: 'the Theia container is not available' }; }
    const findKey = (label) => {
      for (const [candidate] of container._bindingDictionary._map.entries()) {
        const candidateLabel = candidate && (candidate.description || candidate.name);
        if (candidateLabel === label) { return candidate; }
      }
      return undefined;
    };
    try {
      const workspaceServiceKey = findKey('WorkspaceService');
      if (!workspaceServiceKey) { return { ok: false, error: 'WorkspaceService is not bound in this container' }; }
      const workspaceService = container.get(workspaceServiceKey);
      await workspaceService.ready;
      const roots = workspaceService.tryGetRoots();
      const root = (roots && roots[0]) || (await workspaceService.roots)[0];
      const rootUri = root && root.resource ? root.resource.toString() : undefined;
      if (!rootUri) { return { ok: false, error: 'no workspace root is open' }; }

      const serviceKey = findKey('NarrativeKnowledgeService');
      if (!serviceKey) { return { ok: false, error: 'NarrativeKnowledgeService is not bound in this container' }; }
      const service = container.get(serviceKey);

      const availability = await service.getRebuildAvailability(rootUri);
      if (!availability.available) {
        return { ok: false, rootUri, error: \`rebuild refused (reason: \${availability.reason})\` };
      }

      const before = await service.getIndexStatus(rootUri);
      const envelope = await service.rebuild(rootUri);
      return { ok: true, rootUri, before, envelope };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  })()`;
}

/**
 * Assert that a real rebuild ran and produced a populated, `ready` index.
 *
 * Three requirements, all necessary because any one alone can be gamed by a
 * no-op:
 *   - `state === 'ready'`             — the RPC call completed and committed;
 *   - `generation` STRICTLY ADVANCED  — this call, not a stale leftover
 *                                       database, is what produced the state
 *                                       (see the reader script's doc comment);
 *   - the report's `documentsIndexed` and `entities` are BOTH `> 0` — the
 *     fixture manuscript's files were actually read and extracted, not just
 *     that the RPC round-tripped an empty result.
 */
export async function assertNarrativeKnowledgeRebuildReady(triggerRebuild, target) {
  const result = await triggerRebuild();
  if (!result || !result.ok) {
    throw new Error(
      `[${target}] narrative-knowledge rebuild could not run: ${result ? result.error : 'nothing returned'}`
    );
  }

  const { rootUri, before, envelope } = result;
  const state = envelope?.state;
  const report = envelope?.data;
  const beforeGeneration = typeof before?.generation === 'number' ? before.generation : -1;

  if (!state || state.state !== 'ready') {
    throw new Error(
      `[${target}] narrative-knowledge rebuild of ${rootUri} did not reach 'ready': ${JSON.stringify(state)}`
    );
  }
  if (!(state.generation > beforeGeneration)) {
    throw new Error(
      `[${target}] narrative-knowledge rebuild generation did not advance ` +
      `(before=${beforeGeneration}, after=${state.generation}) — the rebuild call may not have actually run`
    );
  }
  if (!report || typeof report.documentsIndexed !== 'number' || report.documentsIndexed <= 0) {
    throw new Error(
      `[${target}] narrative-knowledge rebuild of ${rootUri} indexed no documents: ${JSON.stringify(report)}`
    );
  }
  if (typeof report.entities !== 'number' || report.entities <= 0) {
    throw new Error(
      `[${target}] narrative-knowledge rebuild of ${rootUri} extracted no entities: ${JSON.stringify(report)}`
    );
  }

  console.log(
    `PASS [${target}] narrative-knowledge rebuild reached ready: generation ${beforeGeneration}->${state.generation}, ` +
    `documents=${report.documentsIndexed} entities=${report.entities} mentions=${report.mentions}`
  );
}

// ---------------------------------------------------------------------------
// TASK-022 #46 follow-up — the `applyDiagnostics()` three-envelope precondition
// is really satisfiable in a live application, not just typed.
// ---------------------------------------------------------------------------
//
// `narrative-memory-contribution.ts`'s `applyDiagnostics()` (added in 7b89325)
// only publishes Problems markers when THREE envelopes —
// `getMentions({brokenOnly:true})`, `getRelations({brokenOnly:true})`, and
// `getDuplicateEntities()` — all report `state === 'ready'` AND the SAME
// `generation`. If they don't, the pass is silently abandoned: no markers, no
// error, nothing on screen. That file says of itself that no `bun` lane can
// instantiate it at all, and `getDuplicateEntities` had never crossed the real
// RPC boundary before this — the 14 unit tests added alongside it exercise only
// the pure marker builders, never the service. So the precondition that gates
// every diagnostic this package publishes — including the mentions category
// that worked before 7b89325 — had NEVER been observed against a live backend.
//
// This closes that gap by driving the same three calls through the same DI
// container walk `rebuildRoundTripReaderScript` already uses for
// `NarrativeKnowledgeService`, AFTER the rebuild above has reached `ready` (so
// the index is populated and the three reads have something real to agree on).

/**
 * Renderer-side reader: resolve the workspace root and `NarrativeKnowledgeService`
 * exactly as {@link rebuildRoundTripReaderScript} does, then call the same three
 * read methods `applyDiagnostics()` calls before it will publish anything.
 */
export function diagnosticsEnvelopesReaderScript() {
  return `(async () => {
    const container = window.theia && window.theia.container;
    if (!container) { return { ok: false, error: 'the Theia container is not available' }; }
    const findKey = (label) => {
      for (const [candidate] of container._bindingDictionary._map.entries()) {
        const candidateLabel = candidate && (candidate.description || candidate.name);
        if (candidateLabel === label) { return candidate; }
      }
      return undefined;
    };
    try {
      const workspaceServiceKey = findKey('WorkspaceService');
      if (!workspaceServiceKey) { return { ok: false, error: 'WorkspaceService is not bound in this container' }; }
      const workspaceService = container.get(workspaceServiceKey);
      await workspaceService.ready;
      const roots = workspaceService.tryGetRoots();
      const root = (roots && roots[0]) || (await workspaceService.roots)[0];
      const rootUri = root && root.resource ? root.resource.toString() : undefined;
      if (!rootUri) { return { ok: false, error: 'no workspace root is open' }; }

      const serviceKey = findKey('NarrativeKnowledgeService');
      if (!serviceKey) { return { ok: false, error: 'NarrativeKnowledgeService is not bound in this container' }; }
      const service = container.get(serviceKey);

      const [mentions, relations, duplicates] = await Promise.all([
        service.getMentions(rootUri, { brokenOnly: true }),
        service.getRelations(rootUri, { brokenOnly: true }),
        service.getDuplicateEntities(rootUri)
      ]);
      return { ok: true, rootUri, mentions, relations, duplicates };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  })()`;
}

/**
 * Assert the EXACT precondition `applyDiagnostics()` requires before it will
 * publish any diagnostics: all three envelopes `ready`, and `relations` and
 * `duplicates` reporting the SAME `generation` as `mentions` — the same anchor
 * comparison the product code itself makes.
 *
 * THIS IS A CHECK, NOT A TUNED-TO-PASS ASSERTION. If the three envelopes
 * disagree in a live run, that is a real product defect (every diagnostic this
 * package publishes silently stops appearing), and this function reports it by
 * NAMING which envelope failed and what `generation` each one carried — not by
 * relaxing the condition until it goes green.
 */
export async function assertNarrativeKnowledgeDiagnosticsEnvelopesAgree(readEnvelopes, target) {
  const result = await readEnvelopes();
  if (!result || !result.ok) {
    throw new Error(
      `[${target}] could not read the narrative-knowledge diagnostics envelopes: ` +
      `${result ? result.error : 'nothing returned'}`
    );
  }

  const { mentions, relations, duplicates } = result;
  const named = [
    ['getMentions({brokenOnly:true})', mentions],
    ['getRelations({brokenOnly:true})', relations],
    ['getDuplicateEntities', duplicates]
  ];
  const summary = named
    .map(([name, env]) => `${name}: state=${env?.state?.state} generation=${env?.state?.generation}`)
    .join(' | ');

  const notReady = named.filter(([, env]) => env?.state?.state !== 'ready');
  if (notReady.length > 0) {
    throw new Error(
      `[${target}] narrative-knowledge applyDiagnostics() precondition FAILED — not all three envelopes are ` +
      `'ready': ${notReady.map(([name]) => name).join(', ')}. Envelopes: ${summary}. ` +
      'applyDiagnostics() would silently abandon this pass and publish NOTHING.'
    );
  }

  // Mirrors applyDiagnostics()'s own comparison: mentions is the anchor, and
  // relations/duplicates are checked against ITS generation.
  const anchorGeneration = mentions.state.generation;
  const mismatched = named.filter(([, env]) => env.state.generation !== anchorGeneration);
  if (mismatched.length > 0) {
    throw new Error(
      `[${target}] narrative-knowledge applyDiagnostics() precondition FAILED — generations disagree ` +
      `(anchor is getMentions({brokenOnly:true}) at generation ${anchorGeneration}): ` +
      `${mismatched.map(([name, env]) => `${name}=${env.state.generation}`).join(', ')}. Envelopes: ${summary}. ` +
      'applyDiagnostics() would silently abandon this pass and publish NOTHING, including the mentions category ' +
      "that worked before 7b89325."
    );
  }

  console.log(`PASS [${target}] narrative-knowledge diagnostics envelopes agree: ${summary}`);
}

// ---------------------------------------------------------------------------
// TASK-022 WP-6 — the four read-only AI tools are really REGISTERED
// ---------------------------------------------------------------------------

/**
 * The ids `NarrativeMemoryTool`'s four subclasses declare.
 *
 * Restated here as literals rather than imported: these runners are plain
 * `.mjs` under `node`, and importing the package's TypeScript source would
 * need a build step this script deliberately does not have. The drift guard is
 * `narrative-memory-tools.test.ts`, which asserts the same four ids from the
 * source of truth, plus the failure mode of a stale copy here: a renamed tool
 * makes this check RED rather than silently green, because the id it looks for
 * is no longer registered.
 */
export const NARRATIVE_TOOL_IDS = [
  'narrative_find_entities',
  'narrative_find_mentions',
  'narrative_entity_relations',
  'narrative_document_context'
];

/**
 * Renderer-side reader for the tool registry.
 *
 * SELF-CONTAINED, unlike the `__afeSmokeGetBindingByKeyName` helper one runner
 * installs: this has to evaluate identically in both targets. The binding keys
 * `@theia/ai-core` uses are SYMBOLS (`Symbol('ToolInvocationRegistry')`), whose
 * label lives on `.description` and not on `.name` — so both are checked, and a
 * future Theia that binds a class here still resolves.
 */
export function toolRegistryReaderScript() {
  return `(() => {
    const container = window.theia && window.theia.container;
    if (!container) { return { ok: false, error: 'the Theia container is not available' }; }
    let key;
    for (const [candidate] of container._bindingDictionary._map.entries()) {
      const label = candidate && (candidate.description || candidate.name);
      if (label === 'ToolInvocationRegistry') { key = candidate; break; }
    }
    if (!key) { return { ok: false, error: 'ToolInvocationRegistry is not bound in this container' }; }
    try {
      const registry = container.get(key);
      return {
        ok: true,
        tools: registry.getAllFunctions().map(tool => ({
          id: tool.id,
          name: String(tool.name || ''),
          description: String(tool.description || '')
        }))
      };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`;
}

/**
 * Assert the four read-only narrative tools reached the invocation registry.
 *
 * WHY A SMOKE CHECK AND NOT A UNIT TEST. `bindToolProvider` runs inside a
 * `ContainerModule` that no `bun` lane can instantiate, and this repository has
 * already paid for that gap twice: two DI binding defects took the whole
 * backend module down — no RPC, no localization, no index — while four
 * consecutive work packages reported a green `verify`. A tool that is written,
 * typechecked, tested and NOT BOUND is invisible to every other lane, and
 * invisible in exactly the way that matters: the model simply never sees it.
 *
 * THE NAME IS CHECKED TOO, and that is not padding. `getTool()` localizes its
 * name and description through the catalog; if a key were missing from the
 * phrase catalog the fallback renders the bare leaf (`tool-find-entities-name`),
 * which is a string a user would eventually see in a tool list. Asserting the
 * rendered name does not START with `tool-` catches that without pinning the
 * wording.
 */
export async function assertNarrativeToolsRegistered(readToolRegistry, target) {
  const result = await readToolRegistry();
  if (!result || !result.ok) {
    throw new Error(
      `[${target}] could not read the tool registry: ${result ? result.error : 'nothing returned'}`
    );
  }
  const byId = new Map(result.tools.map(tool => [tool.id, tool]));
  const missing = NARRATIVE_TOOL_IDS.filter(id => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `[${target}] these narrative tools are NOT registered: ${missing.join(', ')}. ` +
      `The registry holds ${result.tools.length} tool(s): ${result.tools.map(tool => tool.id).join(', ')}`
    );
  }
  for (const id of NARRATIVE_TOOL_IDS) {
    const tool = byId.get(id);
    if (!tool.name || tool.name.startsWith('tool-')) {
      throw new Error(
        `[${target}] tool ${id} has an unlocalized name (${JSON.stringify(tool.name)}) — ` +
        'its phrase key is missing from the catalog'
      );
    }
    if (tool.description.length < 40) {
      throw new Error(
        `[${target}] tool ${id} has no usable description (${JSON.stringify(tool.description)})`
      );
    }
  }
  console.log(
    `PASS [${target}] narrative read-only AI tools registered: ${NARRATIVE_TOOL_IDS.join(', ')}`
  );
}

// ---------------------------------------------------------------------------
// TASK-022 ISS-359 — the index must update ITSELF from an on-disk edit, with
// NO call to `rebuild()`. This is the one check this file did not have before
// ISS-359: every assertion above either observes the START-UP probe (which
// only ever sees `absent`/`not-built`) or drives `rebuild()` EXPLICITLY, which
// is exactly the wrong shape to catch "the file watcher never starts" —
// `rebuild()` works whether or not any maintainer/watcher is alive at all.
// ---------------------------------------------------------------------------

/** The fixture file this tooth edits and restores. Content-only changes to a
 *  `content/*.md` chapter are INCREMENTAL (never a full-rebuild trigger — see
 *  `changeForcesRebuild`), so a generation move here can only be the watcher
 *  path, not an escalation this check would misread as success. */
const WATCHER_SELF_UPDATE_TARGET_RELPATH = 'content/chapter-01.md';

/**
 * Renderer-side reader: resolve the workspace root exactly as the other
 * readers in this file do, then read BOTH `getIndexStatus` and
 * `listDocuments` in one round trip — the two facts
 * {@link assertNarrativeKnowledgeWatcherSelfUpdates} needs on every poll.
 */
export function watcherStatusSnapshotReaderScript() {
  return `(async () => {
    const container = window.theia && window.theia.container;
    if (!container) { return { ok: false, error: 'the Theia container is not available' }; }
    const findKey = (label) => {
      for (const [candidate] of container._bindingDictionary._map.entries()) {
        const candidateLabel = candidate && (candidate.description || candidate.name);
        if (candidateLabel === label) { return candidate; }
      }
      return undefined;
    };
    try {
      const workspaceServiceKey = findKey('WorkspaceService');
      if (!workspaceServiceKey) { return { ok: false, error: 'WorkspaceService is not bound in this container' }; }
      const workspaceService = container.get(workspaceServiceKey);
      await workspaceService.ready;
      const roots = workspaceService.tryGetRoots();
      const root = (roots && roots[0]) || (await workspaceService.roots)[0];
      const rootUri = root && root.resource ? root.resource.toString() : undefined;
      if (!rootUri) { return { ok: false, error: 'no workspace root is open' }; }

      const serviceKey = findKey('NarrativeKnowledgeService');
      if (!serviceKey) { return { ok: false, error: 'NarrativeKnowledgeService is not bound in this container' }; }
      const service = container.get(serviceKey);

      const [state, documentsEnvelope] = await Promise.all([
        service.getIndexStatus(rootUri),
        service.listDocuments(rootUri)
      ]);
      return { ok: true, rootUri, state, documents: documentsEnvelope.data };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  })()`;
}

/**
 * Prove the index updates ITSELF from a real on-disk edit — no `rebuild()`
 * call anywhere in this function — within a bounded wait.
 *
 * WHY THIS IS THE RIGHT SHAPE TO CATCH ISS-359 AND THE OTHERS ARE NOT. Every
 * existing check either reads the start-up probe (never populated) or drives
 * `rebuild()` directly (`rebuildRoundTripReaderScript`), which exercises
 * `NodeNarrativeKnowledgeService.rebuild()` regardless of whether any
 * `NarrativeIndexMaintainer` was ever constructed — a maintainer that is never
 * built, never started and owns no watcher is INVISIBLE to that call. This
 * function instead edits a real fixture file ON DISK, through `node:fs`, and
 * waits for `getIndexStatus().generation` to move and for the edited
 * document's stored `sizeBytes`/`contentHash` to change — the only way either
 * can happen with no `rebuild()` in the call chain is a live watcher (or, at
 * worst, the fallback sweep) picking the edit up on its own.
 *
 * THE FIXTURE IS ALWAYS RESTORED, INCLUDING ON THE FAILURE/TIMEOUT PATH. A
 * smoke run must leave `examples/sample-book` byte-for-byte as it found it —
 * both smokes point AT THE SAME directory and a leftover edit would corrupt
 * whichever target runs next (and the repository's own working tree).
 *
 * LIVES HERE, ONCE, RATHER THAN IN EITHER RUNNER. Both `browser-smoke.mjs` and
 * `electron-smoke.mjs` call this with their own `readSnapshot`, and the
 * electron runner wraps each assertion in `try { ... } catch { fail(...) }`
 * rather than letting a failure abort the whole run — so the restore MUST
 * happen inside this shared function's own `finally`, never depend on a
 * runner's control flow noticing the throw.
 */
export async function assertNarrativeKnowledgeWatcherSelfUpdates(readSnapshot, target, timeoutMs = 30_000) {
  const baseline = await readSnapshot();
  if (!baseline || !baseline.ok) {
    throw new Error(
      `[${target}] could not read the narrative-knowledge watcher snapshot: ` +
      `${baseline ? baseline.error : 'nothing returned'}`
    );
  }
  const { rootUri, state: beforeState, documents: beforeDocuments } = baseline;
  const beforeDoc = (beforeDocuments || []).find(doc => doc.relPath === WATCHER_SELF_UPDATE_TARGET_RELPATH);
  if (!beforeDoc) {
    throw new Error(
      `[${target}] the fixture manuscript has no indexed document at ` +
      `${WATCHER_SELF_UPDATE_TARGET_RELPATH} — cannot prove a self-update against it. ` +
      'This check must run AFTER the index has reached ready (see assertNarrativeKnowledgeRebuildReady).'
    );
  }
  const beforeGeneration = typeof beforeState?.generation === 'number' ? beforeState.generation : -1;

  const filePath = join(fileURLToPath(rootUri), WATCHER_SELF_UPDATE_TARGET_RELPATH);
  const originalBytes = readFileSync(filePath, 'utf8');
  try {
    const marker = `\n<!-- ISS-359 watcher self-update tooth: ${Date.now()} -->\n`;
    writeFileSync(filePath, originalBytes + marker, 'utf8');

    const deadline = Date.now() + timeoutMs;
    let lastSeenGeneration = beforeGeneration;
    while (Date.now() < deadline) {
      const snapshot = await readSnapshot();
      if (snapshot && snapshot.ok) {
        const generation = typeof snapshot.state?.generation === 'number' ? snapshot.state.generation : -1;
        lastSeenGeneration = generation;
        const doc = (snapshot.documents || []).find(d => d.relPath === WATCHER_SELF_UPDATE_TARGET_RELPATH);
        const contentReallyChanged = doc !== undefined && (
          doc.sizeBytes !== beforeDoc.sizeBytes || doc.contentHash !== beforeDoc.contentHash
        );
        if (generation > beforeGeneration && contentReallyChanged) {
          console.log(
            `PASS [${target}] narrative-knowledge watcher self-update: generation ` +
            `${beforeGeneration}->${generation}, ${WATCHER_SELF_UPDATE_TARGET_RELPATH} sizeBytes ` +
            `${beforeDoc.sizeBytes}->${doc.sizeBytes} — NO rebuild() was called`
          );
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(
      `[${target}] narrative-knowledge index did NOT self-update after an on-disk edit to ` +
      `${WATCHER_SELF_UPDATE_TARGET_RELPATH} within ${timeoutMs}ms, and rebuild() was never called: ` +
      `generation stayed at ${lastSeenGeneration} (baseline ${beforeGeneration}). ` +
      'The file watcher/maintainer most likely never started for this workspace.'
    );
  } finally {
    // ALWAYS restore — including on the timeout/error path above — a smoke
    // fixture must leave the repository exactly as it found it.
    writeFileSync(filePath, originalBytes, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// TASK-022 UR-043: Narrative Map / Entity Cards must redraw THEMSELVES from
// the backend's `onIndexChanged` push — not only from the "Refresh" button,
// and not from a poll. Everything above proves the INDEX self-updates
// (`assertNarrativeKnowledgeWatcherSelfUpdates`) or answers correctly when
// ASKED (every other assertion in this file); none of them opens a live
// widget and watches its RENDERED TEXT change with no command executed after
// the on-disk edit. That is precisely the gap UR-043 names: the index caught
// up on its own well before this fix, the PANEL did not.
// ---------------------------------------------------------------------------

/** The fixture entity card this tooth edits and restores — chosen because
 *  `assertNarrativeKnowledgeRebuildReady`/the watcher tooth above already run
 *  against the same isolated workspace copy, so this file is guaranteed to
 *  exist and be indexed by the time this check runs. */
const ENTITY_CARD_PUSH_TARGET_RELPATH = 'entities/characters/arjuna.yaml';

/**
 * Renderer-side reader: the open `EntityCardsWidget`'s rendered text, read
 * straight off its DOM node (`widget.node.innerText`) — NOT off the RPC
 * service. Reading through the service would prove only that the INDEX
 * updated, exactly what {@link assertNarrativeKnowledgeWatcherSelfUpdates}
 * already proves; reading the WIDGET'S OWN rendered output is what makes this
 * check able to fail for a reason that one cannot: a live `onIndexChanged`
 * push with a widget that never subscribed, or subscribed and never disposed
 * correctly, still leaves the index itself perfectly ready and fresh.
 */
export function entityCardsWidgetTextReaderScript(widgetId = 'ai-focused-editor.entity-cards') {
  return `(async () => {
    const container = window.theia && window.theia.container;
    if (!container) { return { ok: false, error: 'the Theia container is not available' }; }
    const findKey = (label) => {
      for (const [candidate] of container._bindingDictionary._map.entries()) {
        const candidateLabel = candidate && (candidate.description || candidate.name);
        if (candidateLabel === label) { return candidate; }
      }
      return undefined;
    };
    try {
      const workspaceServiceKey = findKey('WorkspaceService');
      if (!workspaceServiceKey) { return { ok: false, error: 'WorkspaceService is not bound in this container' }; }
      const workspaceService = container.get(workspaceServiceKey);
      await workspaceService.ready;
      const roots = workspaceService.tryGetRoots();
      const root = (roots && roots[0]) || (await workspaceService.roots)[0];
      const rootUri = root && root.resource ? root.resource.toString() : undefined;
      if (!rootUri) { return { ok: false, error: 'no workspace root is open' }; }

      const widgetManagerKey = findKey('WidgetManager');
      if (!widgetManagerKey) { return { ok: false, error: 'WidgetManager is not bound in this container' }; }
      const widgetManager = container.get(widgetManagerKey);
      const widget = widgetManager.tryGetWidget(${JSON.stringify(widgetId)});
      if (!widget) { return { ok: false, error: 'the widget is not open (tryGetWidget returned nothing)' }; }
      return { ok: true, rootUri, text: widget.node.innerText };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  })()`;
}

/**
 * Prove a live, OPEN widget redraws ITSELF from a real on-disk card edit —
 * no `refresh()`/"Refresh" command, no `rebuild()`, anywhere in this
 * function — within a bounded wait (TASK-022 UR-043).
 *
 * THE BREAKING CASE THIS IS BUILT TO CATCH. Remove the `onIndexChanged` wiring
 * from `NarrativeIndexMaintainer`/`NodeNarrativeKnowledgeService`, or drop the
 * `client.onDidCloseConnection(() => subscription.dispose())` line in
 * `narrative-knowledge-backend-module.ts` so no connection is ever actually
 * subscribed, or delete `EntityCardsWidget`'s own
 * `this.toDispose.push(this.indexChangeWatcher.onDidIndexChange(...))` call —
 * any one of the three leaves the index itself perfectly `ready` and fresh
 * (every earlier assertion in this file stays green) while THIS check times
 * out, because the widget goes on showing the pre-edit name until a human
 * clicks "Refresh".
 *
 * WHY THE EDIT IS THE ENTITY'S `name:` FIELD, NOT A RENAME OF THE FILE ITSELF.
 * UR-043's own text bundles two symptoms under "переименование" — a stale
 * CARD and, SEPARATELY, a stale FILENAME in the manuscript tree — and is
 * explicit that the second may be a different cause not to be folded in
 * without proof. Editing `name:` in place isolates exactly the first: the
 * card's displayed name is a pure function of this field, so this check
 * cannot pass or fail for a filename-tree reason it was never built to test.
 *
 * THE FIXTURE IS ALWAYS RESTORED, INCLUDING ON THE FAILURE/TIMEOUT PATH — same
 * discipline as {@link assertNarrativeKnowledgeWatcherSelfUpdates} and for the
 * identical reason (this isolated workspace copy, ISS-365, is still shared
 * with whatever check runs after this one).
 */
export async function assertEntityCardsWidgetSelfUpdatesOnPush(readWidgetText, target, timeoutMs = 30_000) {
  const baseline = await readWidgetText();
  if (!baseline || !baseline.ok) {
    throw new Error(
      `[${target}] could not read the Entity Cards widget: ${baseline ? baseline.error : 'nothing returned'}`
    );
  }
  if (!baseline.text.includes('Arjuna')) {
    throw new Error(
      `[${target}] the open Entity Cards widget does not show "Arjuna" yet — this check must run AFTER ` +
      'the widget has loaded its first snapshot (see assertNarrativeKnowledgeRebuildReady/the widget\'s own ' +
      'initial refresh()).'
    );
  }

  const filePath = join(fileURLToPath(baseline.rootUri), ENTITY_CARD_PUSH_TARGET_RELPATH);
  const originalBytes = readFileSync(filePath, 'utf8');
  const pushMarker = `Arjuna (UR-043 push tooth ${Date.now()})`;
  try {
    if (!originalBytes.includes('name: Arjuna\n')) {
      throw new Error(
        `[${target}] ${ENTITY_CARD_PUSH_TARGET_RELPATH} does not contain the expected "name: Arjuna" line — ` +
        'the fixture card changed shape and this check needs updating alongside it.'
      );
    }
    writeFileSync(filePath, originalBytes.replace('name: Arjuna\n', `name: ${pushMarker}\n`), 'utf8');

    const deadline = Date.now() + timeoutMs;
    let lastSeenText = baseline.text;
    while (Date.now() < deadline) {
      const snapshot = await readWidgetText();
      if (snapshot && snapshot.ok) {
        lastSeenText = snapshot.text;
        if (snapshot.text.includes(pushMarker)) {
          console.log(
            `PASS [${target}] Entity Cards widget self-updated from a live push: on-disk card edit reached ` +
            'the open panel with no refresh() call and no Refresh command executed'
          );
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(
      `[${target}] the open Entity Cards widget did NOT show "${pushMarker}" after an on-disk edit to ` +
      `${ENTITY_CARD_PUSH_TARGET_RELPATH} within ${timeoutMs}ms, and no refresh()/Refresh command was ` +
      `invoked anywhere in this check. Last observed widget text did not contain the marker (length ` +
      `${lastSeenText.length}). The onIndexChanged push most likely never reached this widget.`
    );
  } finally {
    // ALWAYS restore — including on the timeout/error path above.
    writeFileSync(filePath, originalBytes, 'utf8');
  }
}
