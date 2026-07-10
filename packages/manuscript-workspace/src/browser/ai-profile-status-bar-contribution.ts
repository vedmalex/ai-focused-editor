import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import {
  StatusBar,
  StatusBarAlignment
} from '@theia/core/lib/browser/status-bar/status-bar';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AI_FOCUSED_EDITOR_AI_ACTIVE_ALIAS,
  AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE,
  AI_FOCUSED_EDITOR_AI_ALIASES,
  AI_FOCUSED_EDITOR_AI_API_KEYS,
  AI_FOCUSED_EDITOR_AI_ENDPOINTS,
  AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT,
  AI_FOCUSED_EDITOR_AI_PROFILES
} from './ai-focused-editor-preferences';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { ModelConfigCommands } from './model-config-view-contribution';

const STATUS_BAR_ID = 'ai-focused-editor.ai-profile-status';
const AI_PROFILE_PREFERENCES = new Set([
  AI_FOCUSED_EDITOR_AI_PROFILES,
  AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE,
  AI_FOCUSED_EDITOR_AI_API_KEYS,
  AI_FOCUSED_EDITOR_AI_ENDPOINTS,
  AI_FOCUSED_EDITOR_AI_ALIASES,
  AI_FOCUSED_EDITOR_AI_ACTIVE_ALIAS,
  AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT
]);

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
    const pinIcon = summary.aliasMode && summary.pinnedEndpoint ? '$(pin) ' : '';

    // In alias mode the primary label reads `alias · endpoint`; otherwise the
    // `profile · provider/model` label.
    let text: string;
    if (status.notConfigured) {
      text = nls.localize('ai-focused-editor/ai-config/sb-not-configured', '$(warning) AI: not configured');
    } else if (!status.configured) {
      text = nls.localize('ai-focused-editor/ai-config/sb-configure', '$(warning) AI: configure');
    } else if (summary.aliasMode) {
      const endpoint = summary.activeEndpointLabel || summary.activeEndpoint;
      text = `$(symbol-misc) ${pinIcon}AI: ${summary.activeAliasLabel}${endpoint ? ` · ${endpoint}` : ''}`;
    } else {
      const profileLabel = summary.activeProfileLabel;
      text = `$(symbol-misc) AI: ${profileLabel ? `${profileLabel} · ` : ''}${summary.provider}/${summary.model}`;
    }

    const apiKeyValue = summary.hasApiKey
      ? nls.localize('ai-focused-editor/ai-config/value-configured', 'configured')
      : nls.localize('ai-focused-editor/ai-config/value-missing', 'missing');
    const tooltip = status.configured
      ? (summary.aliasMode
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
                : undefined
            ].filter((line): line is string => Boolean(line)).join('\n')
          : [
              nls.localize('ai-focused-editor/ai-config/tt-profile', 'AI Focused Editor profile'),
              summary.activeProfileLabel ? nls.localize('ai-focused-editor/ai-config/tt-active-profile', 'Active profile: {0}', summary.activeProfileLabel) : undefined,
              summary.chainLength > 1 ? nls.localize('ai-focused-editor/ai-config/tt-failover-profiles', 'Failover chain: {0} profiles', summary.chainLength) : undefined,
              nls.localize('ai-focused-editor/ai-config/tt-provider', 'Provider: {0}', summary.provider),
              nls.localize('ai-focused-editor/ai-config/tt-model', 'Model: {0}', summary.model),
              nls.localize('ai-focused-editor/ai-config/tt-transport', 'Transport: {0}', summary.transportKind || 'api'),
              summary.transportId ? nls.localize('ai-focused-editor/ai-config/tt-transport-id', 'Transport ID: {0}', summary.transportId) : undefined,
              summary.profileId ? nls.localize('ai-focused-editor/ai-config/tt-profile-id', 'Profile ID: {0}', summary.profileId) : undefined,
              summary.endpointUrl
                ? nls.localize('ai-focused-editor/ai-config/tt-endpoint-custom', 'Endpoint: custom')
                : nls.localize('ai-focused-editor/ai-config/tt-endpoint-default', 'Endpoint: provider default'),
              nls.localize('ai-focused-editor/ai-config/tt-api-key', 'API key: {0}', apiKeyValue)
            ].filter((line): line is string => Boolean(line)).join('\n'))
      : status.notConfigured
        ? nls.localize('ai-focused-editor/ai-config/tt-not-configured', 'No AI connection configured yet.\nAdd a profile or alias in AI Model Config.\nClick to open AI Model Config.')
        : nls.localize('ai-focused-editor/ai-config/tt-incomplete', 'AI Focused Editor connection is incomplete.\nMissing: {0}\nClick to open AI Model Config.', status.missing.join(', '));

    await this.statusBar.setElement(STATUS_BAR_ID, {
      text,
      alignment: StatusBarAlignment.RIGHT,
      priority: 120,
      command: ModelConfigCommands.OPEN.id,
      tooltip
    });
  }
}
