import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { AuthorMaterialsCreateContribution } from './author-materials-create-contribution';

/**
 * Standalone frontend module for the per-section "New <artifact>" creation
 * commands of the manuscript navigator. Registered as an additional
 * `theiaExtensions` frontend entry so it stays isolated from
 * `manuscript-workspace-frontend-module.ts`. The contribution only adds commands
 * and menu actions (no widgets/services), so it binds a single class as both a
 * CommandContribution and a MenuContribution.
 */
export default new ContainerModule(bind => {
  bind(AuthorMaterialsCreateContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AuthorMaterialsCreateContribution);
  bind(MenuContribution).toService(AuthorMaterialsCreateContribution);
});
