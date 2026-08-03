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
