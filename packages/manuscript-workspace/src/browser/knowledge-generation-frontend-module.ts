import {
  CommandContribution,
  MenuContribution
} from '@theia/core/lib/common';
import { ContainerModule } from '@theia/core/shared/inversify';
import { KnowledgeGenerationContribution } from './knowledge-generation-contribution';

/**
 * Standalone frontend module for FR-011 knowledge generation (spec §5.3, §6):
 * chapter summaries, scene plans, and author questions.
 *
 * Registered as an additional `theiaExtensions` frontend entry so it stays
 * isolated from `manuscript-workspace-frontend-module.ts` while the two evolve
 * in parallel.
 */
export default new ContainerModule(bind => {
  bind(KnowledgeGenerationContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(KnowledgeGenerationContribution);
  bind(MenuContribution).toService(KnowledgeGenerationContribution);
});
