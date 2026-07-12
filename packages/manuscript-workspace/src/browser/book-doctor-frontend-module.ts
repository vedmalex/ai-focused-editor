import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { ObsidianPluginBackendService, ObsidianPluginBackendServicePath } from '../common';
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
 * the doctor contribution here — plus the backend proxy for the Obsidian-plugin
 * installer (its own service path, so it is bound alongside the doctor).
 */
export default new ContainerModule(bind => {
  bind(ObsidianPluginBackendService).toDynamicValue(ctx =>
    ServiceConnectionProvider.createProxy(ctx.container, ObsidianPluginBackendServicePath)
  ).inSingletonScope();
  bind(BookDoctorContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(BookDoctorContribution);
  bind(MenuContribution).toService(BookDoctorContribution);
  bind(TabBarToolbarContribution).toService(BookDoctorContribution);
});
