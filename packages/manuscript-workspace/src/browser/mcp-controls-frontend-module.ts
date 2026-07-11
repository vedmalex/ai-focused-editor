import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { McpControlsContribution } from './mcp-controls-contribution';

/**
 * Standalone frontend module for the author-facing MCP controls command
 * (`MCP Servers...`). Registered as its own `theiaExtensions` frontend entry so
 * it stays isolated from `manuscript-workspace-frontend-module.ts` (which
 * parallel workflows also edit). `QuickInputService`, `MessageService`, and
 * `CommandRegistry` are bound at container scope by @theia/core, and
 * `MCPFrontendService` is bound by @theia/ai-mcp's own frontend module, so we
 * only bind the contribution itself.
 */
export default new ContainerModule(bind => {
  bind(McpControlsContribution).toSelf().inSingletonScope();
  bind(CommandContribution).toService(McpControlsContribution);
  bind(MenuContribution).toService(McpControlsContribution);
});
