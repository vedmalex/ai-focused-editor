import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common/command';
import { PreferenceContribution } from '@theia/core/lib/common/preferences';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { bindToolProvider } from '@theia/ai-core/lib/common/tool-invocation-registry';
import {
  NarrativeIndexChangeWatcher,
  NarrativeKnowledgeService,
  NarrativeKnowledgeServicePath
} from '../common';
import { BrowserNarrativeIndexChangeWatcher } from './narrative-index-change-watcher';
import { NarrativeKnowledgeRoundTripProbe } from './narrative-knowledge-round-trip-probe';
import { NarrativeMemoryContribution } from './narrative-memory-contribution';
import { NarrativeMemoryPreferenceContribution } from './narrative-memory-preferences';
import {
  NarrativeDocumentContextTool,
  NarrativeEntityAppearancesTool,
  NarrativeEntityRelationsTool,
  NarrativeFindEntitiesTool,
  NarrativeFindMentionsTool
} from './narrative-memory-tools-contribution';

/**
 * Frontend module (TASK-022 WP-0, completed for the user-facing surfaces by
 * WP-5).
 *
 * REGISTRATION STUBS — what binds here, and in which WP:
 *
 *   WP-5  CommandContribution        — Rebuild Index, Show Index Status  [DONE]
 *   WP-5  StatusBarContribution      — index state indicator             [DONE]
 *   WP-5  PreferenceContribution     — the `narrativeMemory.*` keys      [DONE]
 *   WP-5  (diagnostics publisher)    — broken references as markers      [DONE]
 *   WP-6  ToolProvider               — read-only AI tools over the index [DONE]
 *
 * The status bar, the commands and the diagnostics publisher are ONE class
 * rather than three. They are not three concerns: all three are functions of
 * the same two answers (`getIndexStatus` and `getRebuildAvailability`), they
 * must change together — the plan's table has one row per state with a column
 * for each surface, not three independent tables — and splitting them would
 * mean three independent pollers asking the backend the same question three
 * times and, worse, being able to disagree with each other about the answer.
 * What IS split out is everything that decides anything: the presentation rule
 * lives in `src/common`, where it is testable under `bun`.
 */
export default new ContainerModule(bind => {
  // UR-043. Bound BEFORE the proxy below, and resolved from `ctx.container`
  // there rather than injected as a constructor parameter of some third
  // class: `BrowserNarrativeIndexChangeWatcher` has no dependency on the
  // proxy itself, so there is no cycle, and `createProxy`'s `target`
  // parameter is positional — it has to be an already-built object, not
  // something DI hands the proxy factory later.
  bind(BrowserNarrativeIndexChangeWatcher).toSelf().inSingletonScope();
  bind(NarrativeIndexChangeWatcher).toService(BrowserNarrativeIndexChangeWatcher);

  bind(NarrativeKnowledgeService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(
      ctx.container,
      NarrativeKnowledgeServicePath,
      ctx.container.get(BrowserNarrativeIndexChangeWatcher)
    )
  ).inSingletonScope();

  bind(NarrativeKnowledgeRoundTripProbe).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(NarrativeKnowledgeRoundTripProbe);

  bind(PreferenceContribution).toConstantValue(NarrativeMemoryPreferenceContribution);

  bind(NarrativeMemoryContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(NarrativeMemoryContribution);
  bind(CommandContribution).toService(NarrativeMemoryContribution);

  // WP-6. `bindToolProvider` is the helper `@theia/ai-core` ships for the pair
  // `bind(X).toSelf().inSingletonScope(); bind(ToolProvider).toService(X)`, and
  // it is what every existing tool in this repository is registered with (grep
  // `bindToolProvider` — there are six older call sites). The contribution slot
  // itself is bound by ai-core's FRONTEND module only, which is why these live
  // here and not in the backend module.
  bindToolProvider(NarrativeFindEntitiesTool, bind);
  bindToolProvider(NarrativeFindMentionsTool, bind);
  bindToolProvider(NarrativeEntityRelationsTool, bind);
  bindToolProvider(NarrativeDocumentContextTool, bind);
  bindToolProvider(NarrativeEntityAppearancesTool, bind);
});
