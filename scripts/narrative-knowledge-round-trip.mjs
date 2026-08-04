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
