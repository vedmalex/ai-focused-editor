import { PreferenceService } from '@theia/core/lib/common/preferences';
import { inject, injectable } from '@theia/core/shared/inversify';
import type { AiConnectionProfile } from '../common';
import {
  AI_FOCUSED_EDITOR_AI_API_KEY,
  AI_FOCUSED_EDITOR_AI_ENDPOINT_URL,
  AI_FOCUSED_EDITOR_AI_MODEL,
  AI_FOCUSED_EDITOR_AI_PROFILE_ID,
  AI_FOCUSED_EDITOR_AI_PROVIDER,
  AI_FOCUSED_EDITOR_AI_TRANSPORT_ID,
  AI_FOCUSED_EDITOR_AI_TRANSPORT_KIND
} from './ai-focused-editor-preferences';

export interface AiProfileStatus {
  configured: boolean;
  missing: string[];
  profile?: AiConnectionProfile;
  summary: {
    provider: string;
    model: string;
    transportKind: string;
    transportId: string;
    profileId: string;
    endpointUrl: string;
    hasApiKey: boolean;
  };
}

@injectable()
export class AiProfilePreferenceService {
  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  async getConfiguredProfile(resourceUri?: string): Promise<AiConnectionProfile | undefined> {
    const status = await this.getStatus(resourceUri);
    return status.profile;
  }

  async getStatus(resourceUri?: string): Promise<AiProfileStatus> {
    await this.preferenceService.ready;

    const provider = this.getPreferenceText(AI_FOCUSED_EDITOR_AI_PROVIDER, resourceUri);
    const model = this.getPreferenceText(AI_FOCUSED_EDITOR_AI_MODEL, resourceUri);
    const secretValue = this.getPreferenceText(AI_FOCUSED_EDITOR_AI_API_KEY, resourceUri);
    const transportKind = this.getPreferenceText(AI_FOCUSED_EDITOR_AI_TRANSPORT_KIND, resourceUri) || 'api';
    const missing: string[] = [];
    if (!provider) {
      missing.push(AI_FOCUSED_EDITOR_AI_PROVIDER);
    }
    if (!model) {
      missing.push(AI_FOCUSED_EDITOR_AI_MODEL);
    }
    if (!secretValue) {
      missing.push(AI_FOCUSED_EDITOR_AI_API_KEY);
    }

    const profile = missing.length === 0
      ? {
          id: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_PROFILE_ID, resourceUri) || undefined,
          provider,
          model,
          secretValue,
          endpointUrl: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_ENDPOINT_URL, resourceUri) || undefined,
          transportKind: transportKind as AiConnectionProfile['transportKind'],
          transportId: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_TRANSPORT_ID, resourceUri) || undefined
        }
      : undefined;

    return {
      configured: Boolean(profile),
      missing,
      profile,
      summary: {
        provider,
        model,
        transportKind,
        transportId: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_TRANSPORT_ID, resourceUri),
        profileId: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_PROFILE_ID, resourceUri),
        endpointUrl: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_ENDPOINT_URL, resourceUri),
        hasApiKey: Boolean(secretValue)
      }
    };
  }

  protected getPreferenceText(preferenceName: string, resourceUri?: string): string {
    return (this.preferenceService.get<string>(preferenceName, '', resourceUri) ?? '').trim();
  }
}
