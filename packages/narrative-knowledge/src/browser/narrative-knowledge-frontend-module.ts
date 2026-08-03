import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import {
  NarrativeKnowledgeService,
  NarrativeKnowledgeServicePath
} from '../common';
import { NarrativeKnowledgeRoundTripProbe } from './narrative-knowledge-round-trip-probe';

/**
 * Frontend module (TASK-022 WP-0).
 *
 * Binds the RPC proxy for {@link NarrativeKnowledgeService} and the round-trip
 * probe. Everything else this package will contribute is listed below as an
 * explicit, dated stub rather than left to be discovered: an unlisted
 * contribution point is one a later WP has to rediscover from the plan.
 *
 * REGISTRATION STUBS — what binds here, and in which WP:
 *
 *   WP-5  CommandContribution        — Rebuild Index, Show Index Status
 *   WP-5  StatusBarContribution      — index state indicator
 *   WP-5  PreferenceContribution     — the `narrativeMemory.*` keys (AD-5)
 *   WP-5  (diagnostics publisher)    — broken references as markers
 *   WP-6  ToolProvider               — read-only AI tools over the index
 *
 * None of them is bound yet, on purpose: an empty binding is indistinguishable
 * from a working one at runtime, and this package's gates are meant to fail
 * loudly rather than pass by vacuity.
 */
export default new ContainerModule(bind => {
  bind(NarrativeKnowledgeService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, NarrativeKnowledgeServicePath)
  ).inSingletonScope();

  bind(NarrativeKnowledgeRoundTripProbe).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(NarrativeKnowledgeRoundTripProbe);
});
