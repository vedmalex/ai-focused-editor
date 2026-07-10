import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import {
  StatusBar,
  StatusBarAlignment
} from '@theia/core/lib/browser/status-bar/status-bar';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AI_FOCUSED_EDITOR_AI_ACTIVE_ALIAS,
  AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE,
  AI_FOCUSED_EDITOR_AI_ALIASES,
  AI_FOCUSED_EDITOR_AI_API_KEY,
  AI_FOCUSED_EDITOR_AI_API_KEYS,
  AI_FOCUSED_EDITOR_AI_ENDPOINT_URL,
  AI_FOCUSED_EDITOR_AI_ENDPOINTS,
  AI_FOCUSED_EDITOR_AI_MODEL,
  AI_FOCUSED_EDITOR_AI_PINNED_ENDPOINT,
  AI_FOCUSED_EDITOR_AI_PROFILE_ID,
  AI_FOCUSED_EDITOR_AI_PROFILES,
  AI_FOCUSED_EDITOR_AI_PROVIDER,
  AI_FOCUSED_EDITOR_AI_TRANSPORT_ID,
  AI_FOCUSED_EDITOR_AI_TRANSPORT_KIND
} from './ai-focused-editor-preferences';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { ModelConfigCommands } from './model-config-view-contribution';

const STATUS_BAR_ID = 'ai-focused-editor.ai-profile-status';
const AI_PROFILE_PREFERENCES = new Set([
  AI_FOCUSED_EDITOR_AI_PROVIDER,
  AI_FOCUSED_EDITOR_AI_MODEL,
  AI_FOCUSED_EDITOR_AI_API_KEY,
  AI_FOCUSED_EDITOR_AI_ENDPOINT_URL,
  AI_FOCUSED_EDITOR_AI_TRANSPORT_KIND,
  AI_FOCUSED_EDITOR_AI_TRANSPORT_ID,
  AI_FOCUSED_EDITOR_AI_PROFILE_ID,
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
    // legacy `profile · provider/model` label.
    let text: string;
    if (!status.configured) {
      text = '$(warning) AI: configure';
    } else if (summary.aliasMode) {
      const endpoint = summary.activeEndpointLabel || summary.activeEndpoint;
      text = `$(symbol-misc) ${pinIcon}AI: ${summary.activeAliasLabel}${endpoint ? ` · ${endpoint}` : ''}`;
    } else {
      const profileLabel = summary.activeProfileLabel;
      text = `$(symbol-misc) AI: ${profileLabel ? `${profileLabel} · ` : ''}${summary.provider}/${summary.model}`;
    }

    const tooltip = status.configured
      ? (summary.aliasMode
          ? [
              'AI Focused Editor connection (alias mode)',
              `Alias: ${summary.activeAliasLabel}`,
              `Endpoint: ${summary.activeEndpointLabel || summary.activeEndpoint}`,
              summary.pinnedEndpoint ? `Pinned endpoint: ${summary.pinnedEndpoint}` : undefined,
              summary.chainLength > 1 ? `Failover chain: ${summary.chainLength} available endpoint(s)` : undefined,
              `Provider: ${summary.provider}`,
              `Model: ${summary.model}`,
              `Transport: ${summary.transportKind || 'api'}`,
              `API key: ${summary.hasApiKey ? 'configured' : 'missing'}`,
              summary.skipped.length > 0
                ? `Skipped: ${summary.skipped.map(entry => `${entry.endpointId} (${entry.reason})`).join(', ')}`
                : undefined
            ].filter((line): line is string => Boolean(line)).join('\n')
          : [
              'AI Focused Editor profile',
              summary.activeProfileLabel ? `Active profile: ${summary.activeProfileLabel}` : undefined,
              summary.chainLength > 1 ? `Failover chain: ${summary.chainLength} profiles` : undefined,
              `Provider: ${summary.provider}`,
              `Model: ${summary.model}`,
              `Transport: ${summary.transportKind || 'api'}`,
              summary.transportId ? `Transport ID: ${summary.transportId}` : undefined,
              summary.profileId ? `Profile ID: ${summary.profileId}` : undefined,
              summary.endpointUrl ? 'Endpoint: custom' : 'Endpoint: provider default',
              `API key: ${summary.hasApiKey ? 'configured' : 'missing'}`
            ].filter((line): line is string => Boolean(line)).join('\n'))
      : `AI Focused Editor connection is incomplete.\nMissing: ${status.missing.join(', ')}\nClick to open AI Model Config.`;

    await this.statusBar.setElement(STATUS_BAR_ID, {
      text,
      alignment: StatusBarAlignment.RIGHT,
      priority: 120,
      command: ModelConfigCommands.OPEN.id,
      tooltip
    });
  }
}
