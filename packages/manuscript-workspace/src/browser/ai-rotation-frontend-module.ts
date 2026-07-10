import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { AiRotationContribution } from './ai-rotation-contribution';

/**
 * Standalone frontend module for the live AI-rotation commands
 * (`Switch AI Alias...` / `Switch AI Endpoint...`). Registered as its own
 * `theiaExtensions` frontend entry so it stays isolated from
 * `manuscript-workspace-frontend-module.ts`.
 *
 * `AiProfilePreferenceService` is already bound at container scope by the main
 * frontend module; re-binding it here as a self-singleton in the same container
 * would collide, so we only bind the rotation contribution and rely on the
 * shared instance for the injected service.
 */
export default new ContainerModule(bind => {
  bind(AiRotationContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(AiRotationContribution);
  bind(MenuContribution).toService(AiRotationContribution);
});
