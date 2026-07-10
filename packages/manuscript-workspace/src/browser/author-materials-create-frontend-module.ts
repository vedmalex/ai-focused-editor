import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { AuthorMaterialsCreateContribution } from './author-materials-create-contribution';

/**
 * Standalone frontend module for the per-section "New <artifact>" creation
 * commands of the manuscript navigator. Registered as an additional
 * `theiaExtensions` frontend entry so it stays isolated from
 * `manuscript-workspace-frontend-module.ts`. The contribution adds commands and
 * menu actions plus a FrontendApplicationContribution that mirrors the tree
 * selection into the `afeManuscriptSection` context key used by the menu `when`
 * clauses, so it binds one singleton under all three contribution symbols.
 */
export default new ContainerModule(bind => {
  bind(AuthorMaterialsCreateContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AuthorMaterialsCreateContribution);
  bind(MenuContribution).toService(AuthorMaterialsCreateContribution);
  bind(FrontendApplicationContribution).toService(AuthorMaterialsCreateContribution);
});
