import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { BookBuildWizardContribution } from './book-build-wizard-contribution';

/**
 * Standalone frontend module for the "Build Book..." wizard (a multi-step
 * QuickInput that builds/publishes the manuscript without leaving the view).
 *
 * Registered as its own `theiaExtensions` frontend entry so it stays isolated
 * from `manuscript-workspace-frontend-module.ts`. The services it injects
 * (`BookBuildService`, `ManuscriptWorkspaceService`, `FileService`, …) are
 * already bound at container scope by the main frontend module and core, so we
 * only bind the wizard contribution here.
 */
export default new ContainerModule(bind => {
  bind(BookBuildWizardContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(BookBuildWizardContribution);
  bind(MenuContribution).toService(BookBuildWizardContribution);
  bind(TabBarToolbarContribution).toService(BookBuildWizardContribution);
});
