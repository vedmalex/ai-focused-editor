import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common';
import { AiRotationContribution } from './ai-rotation-contribution';

/**
 * Standalone frontend module for the live AI-rotation commands
 * (`Switch AI Alias...` / `Switch AI Endpoint...`). Registered as its own
 * `theiaExtensions` frontend entry so it stays isolated from the main
 * connection module.
 *
 * `AiProfilePreferenceService` is bound by the main ai-connect frontend module
 * at container scope; this module only binds the rotation commands and relies
 * on the shared instance. Menu placement is the host application's job.
 */
export default new ContainerModule(bind => {
  bind(AiRotationContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AiRotationContribution);
});
