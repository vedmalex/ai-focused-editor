import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import {
  StatusBar,
  StatusBarAlignment
} from '@theia/core/lib/browser/status-bar/status-bar';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import { AI_CONNECT_WATCHED_PREFERENCES } from './ai-connect-preferences';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { ModelConfigCommands } from './model-config-view-contribution';
import { AiRotationCommands } from './ai-rotation-contribution';

const STATUS_BAR_ID = 'ai-focused-editor.ai-profile-status';
const AI_PROFILE_PREFERENCES = AI_CONNECT_WATCHED_PREFERENCES;

@injectable()
export class AiProfileStatusBarContribution implements FrontendApplicationContribution {
  @inject(StatusBar)
  protected readonly statusBar!: StatusBar;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  protected readonly toDispose = new DisposableCollection();

  onStart(): void {
    void this.updateStatus();
    this.toDispose.push(this.preferenceService.onPreferenceChanged(change => {
      if (AI_PROFILE_PREFERENCES.has(change.preferenceName)) {
        void this.updateStatus();
      }
    }));
  }

  onStop(): void {
    this.toDispose.dispose();
  }

  protected async updateStatus(): Promise<void> {
    const status = await this.aiProfilePreferences.getStatus();
    const summary = status.summary;
    const pinIcon = summary.pinnedEndpoint ? '$(pin) ' : '';

    // The primary label reads `alias · endpoint`.
    let text: string;
    if (status.notConfigured) {
      text = nls.localize('ai-focused-editor/ai-config/sb-not-configured', '$(warning) AI: not configured');
    } else if (!status.configured) {
      text = nls.localize('ai-focused-editor/ai-config/sb-configure', '$(warning) AI: configure');
    } else {
      const endpoint = summary.activeEndpointLabel || summary.activeEndpoint;
      text = `$(symbol-misc) ${pinIcon}AI: ${summary.activeAliasLabel}${endpoint ? ` · ${endpoint}` : ''}`;
    }

    const apiKeyValue = summary.hasApiKey
      ? nls.localize('ai-focused-editor/ai-config/value-configured', 'configured')
      : nls.localize('ai-focused-editor/ai-config/value-missing', 'missing');
    const tooltip = status.configured
      ? [
          nls.localize('ai-focused-editor/ai-config/tt-connection-alias', 'AI Focused Editor connection (alias mode)'),
          nls.localize('ai-focused-editor/ai-config/tt-alias', 'Alias: {0}', summary.activeAliasLabel),
          nls.localize('ai-focused-editor/ai-config/tt-endpoint', 'Endpoint: {0}', summary.activeEndpointLabel || summary.activeEndpoint),
          summary.pinnedEndpoint ? nls.localize('ai-focused-editor/ai-config/tt-pinned-endpoint', 'Pinned endpoint: {0}', summary.pinnedEndpoint) : undefined,
          summary.chainLength > 1 ? nls.localize('ai-focused-editor/ai-config/tt-failover-endpoints', 'Failover chain: {0} available endpoint(s)', summary.chainLength) : undefined,
          nls.localize('ai-focused-editor/ai-config/tt-provider', 'Provider: {0}', summary.provider),
          nls.localize('ai-focused-editor/ai-config/tt-model', 'Model: {0}', summary.model),
          nls.localize('ai-focused-editor/ai-config/tt-transport', 'Transport: {0}', summary.transportKind || 'api'),
          nls.localize('ai-focused-editor/ai-config/tt-api-key', 'API key: {0}', apiKeyValue),
          summary.skipped.length > 0
            ? nls.localize('ai-focused-editor/ai-config/tt-skipped', 'Skipped: {0}', summary.skipped.map(entry => `${entry.endpointId} (${entry.reason})`).join(', '))
            : undefined,
          nls.localize('ai-focused-editor/ai-config/tt-click-switch', 'Click to switch the active alias.')
        ].filter((line): line is string => Boolean(line)).join('\n')
      : status.notConfigured
        ? nls.localize('ai-focused-editor/ai-config/tt-not-configured', 'No AI connection configured yet.\nAdd an endpoint and an alias in AI Model Config.\nClick to open AI Model Config.')
        : nls.localize('ai-focused-editor/ai-config/tt-incomplete', 'AI Focused Editor connection is incomplete.\nMissing: {0}\nClick to open AI Model Config.', status.missing.join(', '));

    await this.statusBar.setElement(STATUS_BAR_ID, {
      text,
      alignment: StatusBarAlignment.RIGHT,
      priority: 120,
      // Mid-writing flow: a configured connection switches the alias in one
      // click; an unconfigured one still leads into the full Model Config.
      command: status.configured ? AiRotationCommands.SWITCH_ALIAS.id : ModelConfigCommands.OPEN.id,
      tooltip
    });
  }
}
