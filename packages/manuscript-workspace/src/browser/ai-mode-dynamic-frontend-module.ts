import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { AiModeDynamicContribution } from './ai-mode-dynamic-contribution';

/**
 * Standalone frontend module for author-defined AI modes surfaced as dynamic
 * editor commands, context-menu entries, and chat agents.
 *
 * Registered as an additional `theiaExtensions` frontend entry so it can evolve
 * in parallel with `manuscript-workspace-frontend-module.ts` while sharing the
 * same DI container (it reuses `AiModeRegistry`, `ChatService`,
 * `CustomAgentFactory`, etc. bound by the core module and `@theia/ai-chat`).
 */
export default new ContainerModule(bind => {
  bind(AiModeDynamicContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(AiModeDynamicContribution);
});
