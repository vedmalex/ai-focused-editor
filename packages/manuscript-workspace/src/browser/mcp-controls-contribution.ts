import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
  MessageService
} from '@theia/core/lib/common';
import { nls } from '@theia/core/lib/common/nls';
import { QuickInputService, QuickPickItem, QuickPickSeparator } from '@theia/core/lib/browser';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import {
  MCPFrontendService,
  MCPServerDescription,
  MCPServerStatus
} from '@theia/ai-mcp/lib/common/mcp-server-manager';
import { AiFocusedEditorMenus } from './ai-focused-editor-menu';

/**
 * Public command id exposed by `@theia/ai-mcp`'s
 * `MCPConfigurationCommandContribution` (`ADD_MCP_SERVER_COMMAND`). It opens the
 * "Add MCP Server" dialog. We reference it by string so we do not depend on the
 * dialog implementation, and we guard on `getCommand` so the row disappears
 * gracefully if a future ai-mcp drops it.
 */
const ADD_MCP_SERVER_COMMAND_ID = 'aiConfiguration.mcp.addServer';

/**
 * `CommonCommands.OPEN_PREFERENCES` (`@theia/core`). Accepts an optional query
 * string argument which the preferences view feeds to `setSearchTerm`, so we
 * can open Settings pre-filtered to the MCP section.
 */
const OPEN_PREFERENCES_COMMAND_ID = 'preferences:open';

/**
 * Fallback settings command (`PreferencesCommands.OPEN_USER_PREFERENCES`) used
 * when `preferences:open` is unavailable. Opens User Settings without a filter.
 */
const OPEN_USER_PREFERENCES_COMMAND_ID = 'workbench.action.openGlobalSettings';

/**
 * Search term that narrows the Settings UI to the MCP feature group. Matches the
 * `ai-features.mcp.*` preference namespace declared by `@theia/ai-mcp`
 * (`ai-features.mcp.mcpServers`, `ai-features.mcp.useWorkspaceAsRoot`).
 */
const MCP_PREFERENCE_QUERY = 'ai-features.mcp';

export const MCP_MANAGE_SERVERS_COMMAND: Command = Command.toLocalizedCommand(
  {
    id: 'ai-focused-editor.mcp.manageServers',
    label: 'MCP Servers...',
    category: 'AI Focused Editor'
  },
  'ai-focused-editor/mcp/command',
  'ai-focused-editor/workspace/category'
);

/** Sentinel ids for the two non-server action rows in the QuickPick. */
const ADD_SERVER_ROW = '__mcp-add-server__';
const OPEN_SETTINGS_ROW = '__mcp-open-settings__';

/** A QuickPick row carrying the server name (or an action sentinel) it stands for. */
interface McpQuickPickItem extends QuickPickItem {
  serverName?: string;
  action?: typeof ADD_SERVER_ROW | typeof OPEN_SETTINGS_ROW;
  running?: boolean;
}

/**
 * Author-facing MCP controls: a single command that lists the configured MCP
 * servers and lets the user toggle each one on/off, plus shortcuts to add a
 * server and to open the MCP settings. This is a minimal stand-in for the
 * management widget shipped in `@theia/ai-ide` (not installed here) — it drives
 * the injectable {@link MCPFrontendService} from `@theia/ai-mcp` directly.
 *
 * Autostart is display-only: a server's `autostart` flag only takes effect after
 * an application restart (it is applied by ai-mcp's frontend contribution on
 * startup), so it is edited via the Add-server dialog / MCP settings, not
 * toggled live from this QuickPick.
 */
@injectable()
export class McpControlsContribution implements CommandContribution, MenuContribution {
  @inject(QuickInputService)
  protected readonly quickInput!: QuickInputService;

  @inject(MessageService)
  protected readonly messages!: MessageService;

  @inject(CommandRegistry)
  protected readonly commands!: CommandRegistry;

  /**
   * Bound by `@theia/ai-mcp`'s frontend module. `@optional()` keeps our
   * contribution loadable (and degrades to a friendly notice) in a build that
   * somehow omits ai-mcp, rather than breaking the whole DI graph.
   */
  @inject(MCPFrontendService) @optional()
  protected readonly mcp?: MCPFrontendService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(MCP_MANAGE_SERVERS_COMMAND, {
      execute: () => this.manageServers()
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(AiFocusedEditorMenus.AI_MODES, {
      commandId: MCP_MANAGE_SERVERS_COMMAND.id,
      order: '8_mcp-servers'
    });
  }

  protected async manageServers(): Promise<void> {
    if (!this.mcp) {
      await this.messages.warn(
        nls.localize('ai-focused-editor/mcp/unavailable', 'MCP support is not available in this build.')
      );
      return;
    }

    let serverNames: string[];
    try {
      serverNames = await this.mcp.getServerNames();
    } catch (error) {
      await this.messages.error(
        nls.localize(
          'ai-focused-editor/mcp/list-failed',
          'Could not read the list of MCP servers: {0}',
          describeError(error)
        )
      );
      return;
    }

    const serverRows = await Promise.all(serverNames.map(name => this.describeServerRow(name)));
    const items: Array<McpQuickPickItem | QuickPickSeparator> = [];

    if (serverRows.length > 0) {
      items.push({
        type: 'separator',
        label: nls.localize('ai-focused-editor/mcp/section-servers', 'Configured servers')
      });
      items.push(...serverRows);
    } else {
      items.push({
        label: nls.localize('ai-focused-editor/mcp/no-servers', 'No MCP servers are configured yet.'),
        detail: nls.localize(
          'ai-focused-editor/mcp/no-servers-detail',
          'Use "Add server..." below to configure your first MCP server.'
        ),
        iconClasses: ['codicon', 'codicon-info'],
        alwaysShow: true
      });
    }

    items.push({
      type: 'separator',
      label: nls.localize('ai-focused-editor/mcp/section-actions', 'Actions')
    });
    items.push({
      action: ADD_SERVER_ROW,
      label: nls.localize('ai-focused-editor/mcp/add-server', 'Add server...'),
      iconClasses: ['codicon', 'codicon-add'],
      alwaysShow: true
    });
    items.push({
      action: OPEN_SETTINGS_ROW,
      label: nls.localize('ai-focused-editor/mcp/open-settings', 'Open MCP settings...'),
      iconClasses: ['codicon', 'codicon-settings-gear'],
      alwaysShow: true
    });

    const picked = await this.quickInput.showQuickPick(items as McpQuickPickItem[], {
      title: nls.localize('ai-focused-editor/mcp/title', 'MCP Servers'),
      placeholder: nls.localize(
        'ai-focused-editor/mcp/placeholder',
        'Pick a server to start or stop it, or choose an action'
      )
    });
    if (!picked) {
      return;
    }
    if (picked.action === ADD_SERVER_ROW) {
      await this.addServer();
      return;
    }
    if (picked.action === OPEN_SETTINGS_ROW) {
      await this.openSettings();
      return;
    }
    if (picked.serverName) {
      await this.toggleServer(picked.serverName, picked.running === true);
    }
  }

  /** Builds one QuickPick row reflecting a server's live start-state and autostart flag. */
  protected async describeServerRow(name: string): Promise<McpQuickPickItem> {
    let running = false;
    let description: MCPServerDescription | undefined;
    try {
      [running, description] = await Promise.all([
        this.mcp!.isServerStarted(name),
        this.mcp!.getServerDescription(name)
      ]);
    } catch {
      // Leave running=false / description=undefined; the row still lets the user try to start it.
    }

    const stateLabel = running
      ? nls.localize('ai-focused-editor/mcp/state-running', 'running')
      : nls.localize('ai-focused-editor/mcp/state-stopped', 'stopped');
    const autostartLabel = description?.autostart
      ? nls.localize('ai-focused-editor/mcp/autostart-on', 'autostart on')
      : nls.localize('ai-focused-editor/mcp/autostart-off', 'autostart off');

    const parts = [stateLabel, autostartLabel];
    const statusDetail = this.statusDetail(description);
    if (statusDetail) {
      parts.push(statusDetail);
    }

    return {
      serverName: name,
      running,
      label: name,
      // Icon hints the action a click performs: play = start, stop = stop.
      iconClasses: ['codicon', running ? 'codicon-debug-stop' : 'codicon-play'],
      description: parts.join(' · '),
      detail: running
        ? nls.localize('ai-focused-editor/mcp/click-to-stop', 'Click to stop this server.')
        : nls.localize('ai-focused-editor/mcp/click-to-start', 'Click to start this server.')
    };
  }

  /** Surfaces a non-trivial lifecycle status (errored / auth required) or a stored error. */
  protected statusDetail(description: MCPServerDescription | undefined): string | undefined {
    if (!description) {
      return undefined;
    }
    if (description.status === MCPServerStatus.Errored) {
      return description.error
        ? nls.localize('ai-focused-editor/mcp/status-errored-detail', 'error: {0}', description.error)
        : nls.localize('ai-focused-editor/mcp/status-errored', 'error');
    }
    if (description.status === MCPServerStatus.AuthenticationRequired) {
      return nls.localize('ai-focused-editor/mcp/status-auth-required', 'sign-in required');
    }
    return undefined;
  }

  protected async toggleServer(name: string, running: boolean): Promise<void> {
    if (running) {
      await this.stopServer(name);
    } else {
      await this.startServer(name);
    }
  }

  protected async startServer(name: string): Promise<void> {
    const progress = await this.messages.showProgress({
      text: nls.localize('ai-focused-editor/mcp/starting-progress', 'Starting MCP server "{0}"...', name)
    });
    try {
      // Interactive start: permits the OAuth flow to open a browser tab for a
      // direct user action (non-interactive startServer cannot).
      await this.mcp!.startServerInteractive(name);
    } catch (error) {
      progress.cancel();
      await this.messages.error(
        nls.localize('ai-focused-editor/mcp/start-failed', 'Could not start MCP server "{0}": {1}', name, describeError(error))
      );
      return;
    }
    progress.cancel();

    const started = await this.safeIsStarted(name);
    if (!started) {
      // A pre-flight check (e.g. workspace trust / OAuth pending) declined to
      // start; ai-mcp already surfaced its own diagnostic, so stay quiet here.
      return;
    }
    const toolCount = await this.safeToolCount(name);
    if (typeof toolCount === 'number') {
      await this.messages.info(
        nls.localize(
          'ai-focused-editor/mcp/started-with-tools',
          'MCP server "{0}" started ({1} tools available).',
          name,
          toolCount
        )
      );
    } else {
      await this.messages.info(
        nls.localize('ai-focused-editor/mcp/started', 'MCP server "{0}" started.', name)
      );
    }
  }

  protected async stopServer(name: string): Promise<void> {
    const progress = await this.messages.showProgress({
      text: nls.localize('ai-focused-editor/mcp/stopping-progress', 'Stopping MCP server "{0}"...', name)
    });
    try {
      await this.mcp!.stopServer(name);
    } catch (error) {
      progress.cancel();
      await this.messages.error(
        nls.localize('ai-focused-editor/mcp/stop-failed', 'Could not stop MCP server "{0}": {1}', name, describeError(error))
      );
      return;
    }
    progress.cancel();
    await this.messages.info(
      nls.localize('ai-focused-editor/mcp/stopped', 'MCP server "{0}" stopped.', name)
    );
  }

  protected async safeIsStarted(name: string): Promise<boolean> {
    try {
      return await this.mcp!.isServerStarted(name);
    } catch {
      return false;
    }
  }

  protected async safeToolCount(name: string): Promise<number | undefined> {
    try {
      const tools = await this.mcp!.getTools(name);
      return tools?.tools?.length;
    } catch {
      return undefined;
    }
  }

  protected async addServer(): Promise<void> {
    if (!this.commands.getCommand(ADD_MCP_SERVER_COMMAND_ID)) {
      await this.messages.warn(
        nls.localize(
          'ai-focused-editor/mcp/add-unavailable',
          'The "Add MCP Server" dialog is not available. Add servers through MCP settings instead.'
        )
      );
      await this.openSettings();
      return;
    }
    await this.commands.executeCommand(ADD_MCP_SERVER_COMMAND_ID);
  }

  protected async openSettings(): Promise<void> {
    if (this.commands.getCommand(OPEN_PREFERENCES_COMMAND_ID)) {
      await this.commands.executeCommand(OPEN_PREFERENCES_COMMAND_ID, MCP_PREFERENCE_QUERY);
      return;
    }
    if (this.commands.getCommand(OPEN_USER_PREFERENCES_COMMAND_ID)) {
      await this.commands.executeCommand(OPEN_USER_PREFERENCES_COMMAND_ID);
      return;
    }
    await this.messages.warn(
      nls.localize('ai-focused-editor/mcp/settings-unavailable', 'The Settings view is not available.')
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
