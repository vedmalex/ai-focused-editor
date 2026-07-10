import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { BookDoctorContribution } from './book-doctor-contribution';

/**
 * Standalone frontend module for the "Book Doctor" (inspect the manuscript
 * workspace, report what is missing/inconsistent, and create the missing
 * scaffold folders, seed files, and manifest-referenced chapter files).
 *
 * Registered as its own `theiaExtensions` frontend entry so it stays isolated
 * from `manuscript-workspace-frontend-module.ts`. The services it injects
 * (`ManuscriptWorkspaceService`, `FileService`, `WidgetManager`, …) are already
 * bound at container scope by the main frontend module and core, so we only bind
 * the doctor contribution here.
 */
export default new ContainerModule(bind => {
  bind(BookDoctorContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(BookDoctorContribution);
  bind(MenuContribution).toService(BookDoctorContribution);
  bind(TabBarToolbarContribution).toService(BookDoctorContribution);
});
