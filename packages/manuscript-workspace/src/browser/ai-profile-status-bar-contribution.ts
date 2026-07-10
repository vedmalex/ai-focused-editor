import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import {
  StatusBar,
  StatusBarAlignment
} from '@theia/core/lib/browser/status-bar/status-bar';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
  AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE,
  AI_FOCUSED_EDITOR_AI_API_KEY,
  AI_FOCUSED_EDITOR_AI_API_KEYS,
  AI_FOCUSED_EDITOR_AI_ENDPOINT_URL,
  AI_FOCUSED_EDITOR_AI_MODEL,
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
  AI_FOCUSED_EDITOR_AI_API_KEYS
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
    const profileLabel = status.summary.activeProfileLabel;
    const text = status.configured
      ? `$(symbol-misc) AI: ${profileLabel ? `${profileLabel} · ` : ''}${status.summary.provider}/${status.summary.model}`
      : '$(warning) AI: configure';

    await this.statusBar.setElement(STATUS_BAR_ID, {
      text,
      alignment: StatusBarAlignment.RIGHT,
      priority: 120,
      command: ModelConfigCommands.OPEN.id,
      tooltip: status.configured
        ? [
            'AI Focused Editor profile',
            profileLabel ? `Active profile: ${profileLabel}` : undefined,
            status.summary.chainLength > 1 ? `Failover chain: ${status.summary.chainLength} profiles` : undefined,
            `Provider: ${status.summary.provider}`,
            `Model: ${status.summary.model}`,
            `Transport: ${status.summary.transportKind || 'api'}`,
            status.summary.transportId ? `Transport ID: ${status.summary.transportId}` : undefined,
            status.summary.profileId ? `Profile ID: ${status.summary.profileId}` : undefined,
            status.summary.endpointUrl ? 'Endpoint: custom' : 'Endpoint: provider default',
            `API key: ${status.summary.hasApiKey ? 'configured' : 'missing'}`
          ].filter((line): line is string => Boolean(line)).join('\n')
        : `AI Focused Editor profile is incomplete.\nMissing: ${status.missing.join(', ')}\nClick to open AI Model Config.`
    });
  }
}
