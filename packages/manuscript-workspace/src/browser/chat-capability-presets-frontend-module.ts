import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { ChatCapabilityPresetsContribution } from './chat-capability-presets-contribution';

/**
 * Standalone frontend module for the author-facing chat-capability presets
 * command (`Chat Capabilities Preset...`). Registered as its own
 * `theiaExtensions` frontend entry so it stays isolated from
 * `manuscript-workspace-frontend-module.ts` (which a parallel workflow also
 * edits). `AISettingsService`, `QuickInputService`, `MessageService`, and
 * `CommandService` are all bound at container scope by the AI/core modules, so
 * we only bind the contribution itself.
 */
export default new ContainerModule(bind => {
  bind(ChatCapabilityPresetsContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(ChatCapabilityPresetsContribution);
  bind(MenuContribution).toService(ChatCapabilityPresetsContribution);
});
