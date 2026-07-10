import {
  PreferenceScope,
  PreferenceService
} from '@theia/core/lib/common/preferences';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  AiConnectionProfile,
  AiProfileDescriptor,
  ModelProviderRegistry,
  StoredAiProfile
} from '../common';
import { getAiConnectTransportKind } from '../common/ai-connect-config';
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

export const LEGACY_PROFILE_ID = 'default';

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
    /** Label of the active named profile ('' in legacy single-profile mode). */
    activeProfileLabel: string;
    /** Number of configured profiles in the failover chain. */
    chainLength: number;
  };
}

/**
 * FR-013 profile registry: named profiles ("aliases") persisted in workspace
 * preferences, API keys in a user-scope map, an active profile selection, and
 * an ordered failover chain. Falls back to the legacy single-profile
 * aiFocusedEditor.ai.* keys when no named profile exists.
 */
@injectable()
export class AiProfilePreferenceService implements ModelProviderRegistry {
  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  @inject(WorkspaceService)
  protected readonly workspaceService!: WorkspaceService;

  async getConfiguredProfile(resourceUri?: string): Promise<AiConnectionProfile | undefined> {
    const status = await this.getStatus(resourceUri);
    return status.profile;
  }

  async getStatus(resourceUri?: string): Promise<AiProfileStatus> {
    await this.preferenceService.ready;
    const stored = this.readStoredProfiles(resourceUri);
    const activeId = this.getActiveProfileId(stored, resourceUri);
    const active = stored.find(profile => profile.id === activeId) ?? this.readLegacyProfile(resourceUri);
    const missing = this.getMissingFields(active, resourceUri);
    const resolved = missing.length === 0 ? this.resolveProfile(active, resourceUri) : undefined;
    const chain = await this.getFailoverChain(resourceUri);

    return {
      configured: Boolean(resolved),
      missing,
      profile: resolved,
      summary: {
        provider: active.provider ?? '',
        model: active.model ?? '',
        transportKind: active.transportKind || 'api',
        transportId: active.transportId ?? '',
        profileId: active.profileId ?? '',
        endpointUrl: active.endpointUrl ?? '',
        hasApiKey: Boolean(this.getApiKeyFor(active.id, resourceUri)),
        activeProfileLabel: this.isLegacyMode(resourceUri) ? '' : (active.label || active.id),
        chainLength: chain.length
      }
    };
  }

  async listProfiles(resourceUri?: string): Promise<AiProfileDescriptor[]> {
    await this.preferenceService.ready;
    const stored = this.readStoredProfiles(resourceUri);
    const profiles = stored.length > 0 ? stored : [this.readLegacyProfile(resourceUri)];
    const activeId = this.getActiveProfileId(profiles, resourceUri);

    return profiles.map(profile => {
      const missing = this.getMissingFields(profile, resourceUri);
      return {
        id: profile.id,
        label: profile.label || profile.id,
        provider: profile.provider ?? '',
        model: profile.model ?? '',
        transportKind: profile.transportKind || 'api',
        enabled: profile.enabled !== false,
        active: profile.id === activeId,
        configured: missing.length === 0,
        missing,
        hasApiKey: Boolean(this.getApiKeyFor(profile.id, resourceUri)),
        endpointUrl: profile.endpointUrl || undefined,
        allowedModels: profile.allowedModels
      };
    });
  }

  async getActiveProfile(resourceUri?: string): Promise<AiConnectionProfile | undefined> {
    return this.getConfiguredProfile(resourceUri);
  }

  async getFailoverChain(resourceUri?: string): Promise<AiConnectionProfile[]> {
    await this.preferenceService.ready;
    const stored = this.readStoredProfiles(resourceUri);
    const profiles = stored.length > 0 ? stored : [this.readLegacyProfile(resourceUri)];
    const activeId = this.getActiveProfileId(profiles, resourceUri);

    const ordered = [
      ...profiles.filter(profile => profile.id === activeId),
      ...profiles.filter(profile => profile.id !== activeId && profile.enabled !== false)
    ];

    return ordered
      .filter(profile => this.getMissingFields(profile, resourceUri).length === 0)
      .map(profile => this.resolveProfile(profile, resourceUri));
  }

  async setActiveProfile(id: string): Promise<void> {
    await this.setWorkspacePreference(AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE, id);
  }

  async upsertProfile(profile: StoredAiProfile): Promise<void> {
    const stored = this.readStoredProfiles();
    const index = stored.findIndex(candidate => candidate.id === profile.id);
    const next = [...stored];
    if (index >= 0) {
      next[index] = profile;
    } else {
      next.push(profile);
    }
    await this.setWorkspacePreference(AI_FOCUSED_EDITOR_AI_PROFILES, next);
    if (next.length === 1) {
      await this.setActiveProfile(profile.id);
    }
  }

  async deleteProfile(id: string): Promise<void> {
    const stored = this.readStoredProfiles();
    const next = stored.filter(profile => profile.id !== id);
    await this.setWorkspacePreference(AI_FOCUSED_EDITOR_AI_PROFILES, next);
    if (this.getActiveProfileId(next) === id && next.length > 0) {
      await this.setActiveProfile(next[0].id);
    }
    const keys = { ...this.readApiKeys() };
    if (id in keys) {
      delete keys[id];
      await this.preferenceService.set(AI_FOCUSED_EDITOR_AI_API_KEYS, keys, PreferenceScope.User);
    }
  }

  async moveProfile(id: string, delta: -1 | 1): Promise<void> {
    const stored = this.readStoredProfiles();
    const index = stored.findIndex(profile => profile.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= stored.length) {
      return;
    }
    const next = [...stored];
    [next[index], next[target]] = [next[target], next[index]];
    await this.setWorkspacePreference(AI_FOCUSED_EDITOR_AI_PROFILES, next);
  }

  async reorderProfile(id: string, targetIndex: number): Promise<void> {
    const stored = this.readStoredProfiles();
    const index = stored.findIndex(profile => profile.id === id);
    if (index < 0) {
      return;
    }
    const clamped = Math.max(0, Math.min(targetIndex, stored.length - 1));
    if (clamped === index) {
      return;
    }
    const next = [...stored];
    const [moved] = next.splice(index, 1);
    next.splice(clamped, 0, moved);
    await this.setWorkspacePreference(AI_FOCUSED_EDITOR_AI_PROFILES, next);
  }

  async setApiKey(id: string, apiKey: string): Promise<void> {
    const keys = { ...this.readApiKeys() };
    if (apiKey) {
      keys[id] = apiKey;
    } else {
      delete keys[id];
    }
    await this.preferenceService.set(AI_FOCUSED_EDITOR_AI_API_KEYS, keys, PreferenceScope.User);
  }

  /**
   * The editable stored shapes for the config UI. In legacy single-profile
   * mode this synthesizes one 'default' entry from the flat keys, so saving
   * it migrates the workspace to the named-profiles model.
   */
  getStoredProfileList(resourceUri?: string): StoredAiProfile[] {
    const stored = this.readStoredProfiles(resourceUri);
    return stored.length > 0 ? stored : [this.readLegacyProfile(resourceUri)];
  }

  protected isLegacyMode(resourceUri?: string): boolean {
    return this.readStoredProfiles(resourceUri).length === 0;
  }

  protected readStoredProfiles(resourceUri?: string): StoredAiProfile[] {
    const raw = this.preferenceService.get<StoredAiProfile[]>(AI_FOCUSED_EDITOR_AI_PROFILES, [], resourceUri);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((profile): profile is StoredAiProfile =>
      typeof profile === 'object' && profile !== null && typeof (profile as StoredAiProfile).id === 'string'
    );
  }

  /** Legacy single-profile mode: synthesize a profile from the flat keys. */
  protected readLegacyProfile(resourceUri?: string): StoredAiProfile {
    return {
      id: LEGACY_PROFILE_ID,
      provider: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_PROVIDER, resourceUri),
      model: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_MODEL, resourceUri),
      transportKind: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_TRANSPORT_KIND, resourceUri) || 'api',
      transportId: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_TRANSPORT_ID, resourceUri) || undefined,
      profileId: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_PROFILE_ID, resourceUri) || undefined,
      endpointUrl: this.getPreferenceText(AI_FOCUSED_EDITOR_AI_ENDPOINT_URL, resourceUri) || undefined
    };
  }

  protected getActiveProfileId(profiles: StoredAiProfile[], resourceUri?: string): string {
    const configured = this.getPreferenceText(AI_FOCUSED_EDITOR_AI_ACTIVE_PROFILE, resourceUri);
    if (configured && profiles.some(profile => profile.id === configured)) {
      return configured;
    }
    return profiles[0]?.id ?? LEGACY_PROFILE_ID;
  }

  protected getMissingFields(profile: StoredAiProfile, resourceUri?: string): string[] {
    const missing: string[] = [];
    if (!profile.provider) {
      missing.push(AI_FOCUSED_EDITOR_AI_PROVIDER);
    }
    if (!profile.model) {
      missing.push(AI_FOCUSED_EDITOR_AI_MODEL);
    }
    // API keys only gate the api transport; acp/cli/server authorize through
    // the underlying agent (OAuth, CLI login), matching ai-editor v1 behavior.
    if (profile.provider) {
      const effectiveTransportKind = getAiConnectTransportKind({
        provider: profile.provider,
        transportKind: profile.transportKind as AiConnectionProfile['transportKind'],
        transportId: profile.transportId
      });
      if (effectiveTransportKind === 'api' && !this.getApiKeyFor(profile.id, resourceUri)) {
        missing.push(AI_FOCUSED_EDITOR_AI_API_KEY);
      }
    }
    return missing;
  }

  protected resolveProfile(profile: StoredAiProfile, resourceUri?: string): AiConnectionProfile {
    return {
      id: profile.profileId || profile.id,
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      transportKind: (profile.transportKind || 'api') as AiConnectionProfile['transportKind'],
      transportId: profile.transportId || undefined,
      endpointUrl: profile.endpointUrl || undefined,
      command: profile.command || undefined,
      authMethodId: profile.authMethodId || undefined,
      allowedModels: profile.allowedModels,
      secretValue: this.getApiKeyFor(profile.id, resourceUri) || undefined
    };
  }

  protected getApiKeyFor(profileId: string, resourceUri?: string): string {
    const keys = this.readApiKeys();
    const mapped = typeof keys[profileId] === 'string' ? keys[profileId].trim() : '';
    if (mapped) {
      return mapped;
    }
    if (profileId === LEGACY_PROFILE_ID || this.isLegacyMode(resourceUri)) {
      return this.getPreferenceText(AI_FOCUSED_EDITOR_AI_API_KEY, resourceUri);
    }
    return '';
  }

  protected readApiKeys(): Record<string, string> {
    const raw = this.preferenceService.get<Record<string, string>>(AI_FOCUSED_EDITOR_AI_API_KEYS, {});
    return typeof raw === 'object' && raw !== null ? raw : {};
  }

  protected async setWorkspacePreference(preferenceName: string, value: unknown): Promise<void> {
    await this.workspaceService.ready;
    const root = this.workspaceService.tryGetRoots()[0] ?? (await this.workspaceService.roots)[0];
    const resourceUri = root?.resource.toString();
    if (resourceUri) {
      await this.preferenceService.set(preferenceName, value, PreferenceScope.Folder, resourceUri);
    } else {
      await this.preferenceService.updateValue(preferenceName, value);
    }
  }

  protected getPreferenceText(preferenceName: string, resourceUri?: string): string {
    return (this.preferenceService.get<string>(preferenceName, '', resourceUri) ?? '').trim();
  }
}
