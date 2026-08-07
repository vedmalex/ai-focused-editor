import { inject, injectable } from '@theia/core/shared/inversify';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { NarrativeKnowledgeService, type IndexState } from '../common';

/**
 * Prefix of the line the probe prints, and the name of the global it records
 * its outcome under. Both are a CONTRACT with the runtime smoke scripts
 * (`scripts/narrative-knowledge-round-trip.mjs`), not debug strings: changing
 * either without changing that script turns the round-trip check into a silent
 * no-op.
 */
export const NARRATIVE_KNOWLEDGE_PROBE_PREFIX = '[narrative-knowledge] round-trip';
export const NARRATIVE_KNOWLEDGE_PROBE_GLOBAL = '__afeNarrativeKnowledgeRoundTrip';

/** What the probe records. `ok` false carries `error` instead of `status`. */
export interface NarrativeKnowledgeProbeResult {
  ok: boolean;
  status?: IndexState;
  error?: string;
}

/**
 * Round-trip probe (TASK-022 WP-0).
 *
 * WP-0's readiness requires the RPC path to be proven in BOTH targets. There
 * is no user-facing surface yet — commands, the status bar and diagnostics are
 * WP-5 — so the evidence has to be something a headless smoke run can observe.
 * This contribution calls `getIndexStatus()` once at frontend start.
 *
 * The outcome is RECORDED ON A GLOBAL, and only additionally printed. The
 * console line alone was not enough, and the electron target is what showed
 * it: Playwright cannot attach a console listener before the window exists, so
 * a line emitted during frontend start is simply gone by the time anything can
 * listen. An assertion that depends on catching an ephemeral event reports
 * "never happened" for an event that happened — the worst kind of red, because
 * it sends the reader to look at wiring that is fine. A recorded value has no
 * such window.
 *
 * A failure records too, and records DIFFERENTLY (`ok: false` + `error`): a
 * probe that stayed silent on an unreachable backend would be indistinguishable
 * from one that had not run yet.
 *
 * This is scaffolding with a stated lifetime: once WP-5 ships the status bar,
 * the smoke scripts can assert against real UI, and this probe should go.
 */
@injectable()
export class NarrativeKnowledgeRoundTripProbe implements FrontendApplicationContribution {
  @inject(NarrativeKnowledgeService)
  protected readonly service!: NarrativeKnowledgeService;

  async onStart(): Promise<void> {
    let result: NarrativeKnowledgeProbeResult;
    try {
      result = { ok: true, status: await this.service.getIndexStatus() };
      console.log(`${NARRATIVE_KNOWLEDGE_PROBE_PREFIX} ok: ${JSON.stringify(result.status)}`);
    } catch (error) {
      result = { ok: false, error: String(error) };
      console.log(`${NARRATIVE_KNOWLEDGE_PROBE_PREFIX} failed: ${result.error}`);
    }
    (globalThis as Record<string, unknown>)[NARRATIVE_KNOWLEDGE_PROBE_GLOBAL] = result;
  }
}
