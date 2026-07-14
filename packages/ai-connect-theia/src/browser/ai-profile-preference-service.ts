import {
  PreferenceScope,
  PreferenceService
} from '@theia/core/lib/common/preferences';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import type {
  AiAliasDescriptor,
  AiConnectionProfile,
  AiEndpointDescriptor,
  AliasChainLeg,
  ResolvedAliasChain,
  StoredAiAlias,
  StoredAiEndpoint
} from '../common';
import { resolveChainFromConfig, resolveEndpointLeg, resolveWithLegacy } from '../common';
import { getAiConnectTransportKind } from '../common/ai-connect-config';
import { isWithinWindows, parseTimeWindows } from '../common/ai-time-windows';
import {
  AI_CONNECT_ACTIVE_ALIAS,
  AI_CONNECT_ALIASES,
  AI_CONNECT_API_KEYS,
  AI_CONNECT_ENDPOINTS,
  AI_CONNECT_PINNED_ENDPOINT,
  AI_CONNECT_LEGACY_KEY_BY_NEW
} from './ai-connect-preferences';
import { buildUnconfiguredAiProfileStatus, type AiProfileStatus } from './ai-profile-status';

export type { AiProfileStatus } from './ai-profile-status';

/**
 * AI connection registry over the two-level ENDPOINT + ALIAS model. Endpoints
 * (channels) and aliases (ordered endpoint+model failover chains) are persisted
 * in workspace preferences; API keys live in a user-scope map keyed by endpoint
 * id. The active alias is the user default. When no alias exists at all the
 * status is an explicit "not configured" state — there is no active connection.
 */
@injectable()
export class AiProfilePreferenceService {
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
    if (!this.isAliasMode(resourceUri)) {
      return buildUnconfiguredAiProfileStatus();
    }
    return this.getAliasStatus(resourceUri);
  }

  /** getStatus() for endpoints/aliases mode: resolve the active alias chain. */
  protected getAliasStatus(resourceUri?: string): AiProfileStatus {
    const detailed = this.resolveAliasChainDetailed(undefined, new Date(), resourceUri);
    // The representative is the first fully-usable leg (the one that will
    // actually serve requests after failover); fall back to the first leg so
    // the "missing" list explains what the head of the chain still needs.
    const usable = detailed.chain.find(leg => this.getResolvedMissing(leg).length === 0);
    const representative = usable ?? detailed.chain[0];
    const missing = this.getResolvedMissing(representative);
    const configured = Boolean(usable);
    const pinned = this.getPinnedEndpointId(resourceUri);

    return {
      configured,
      notConfigured: false,
      missing,
      profile: usable,
      summary: {
        provider: representative?.provider ?? '',
        model: representative?.model ?? '',
        transportKind: (representative?.transportKind as string) || 'api',
        transportId: representative?.transportId ?? '',
        profileId: representative?.id ?? '',
        endpointUrl: representative?.endpointUrl ?? '',
        hasApiKey: Boolean(representative?.secretValue),
        activeProfileLabel: detailed.aliasLabel || detailed.aliasId || '',
        chainLength: detailed.chain.length,
        aliasMode: true,
        activeAlias: detailed.aliasId ?? '',
        activeAliasLabel: detailed.aliasLabel || detailed.aliasId || '',
        activeEndpoint: representative?.id ?? '',
        activeEndpointLabel: representative?.label || representative?.id || '',
        pinnedEndpoint: pinned,
        skipped: detailed.skipped
      }
    };
  }

  /** Missing-field tokens for a resolved chain leg (readable, not preference keys). */
  protected getResolvedMissing(profile: AiConnectionProfile | undefined): string[] {
    if (!profile) {
      return ['alias chain (no available endpoint)'];
    }
    const missing: string[] = [];
    if (!profile.provider) {
      missing.push('provider');
    }
    if (!profile.model) {
      missing.push('model');
    }
    if (profile.provider) {
      const kind = getAiConnectTransportKind({
        provider: profile.provider,
        transportKind: profile.transportKind,
        transportId: profile.transportId
      });
      if (kind === 'api' && !profile.secretValue) {
        missing.push('API key');
      }
    }
    return missing;
  }

  async getFailoverChain(resourceUri?: string): Promise<AiConnectionProfile[]> {
    await this.preferenceService.ready;
    if (!this.isAliasMode(resourceUri)) {
      return [];
    }
    return this.resolveAliasChainDetailed(undefined, new Date(), resourceUri).chain;
  }

  /**
   * Failover chain for a SPECIFIC alias, independent of the active alias. Used
   * by the per-alias LanguageModels so a request pins its own alias regardless
   * of which alias the user currently has selected as the default.
   */
  async getFailoverChainForAlias(aliasId: string, resourceUri?: string): Promise<AiConnectionProfile[]> {
    await this.preferenceService.ready;
    if (!this.isAliasMode(resourceUri)) {
      return [];
    }
    return this.resolveAliasChainDetailed(aliasId, new Date(), resourceUri).chain;
  }

  async setApiKey(id: string, apiKey: string): Promise<void> {
    const keys = { ...this.readApiKeys() };
    if (apiKey) {
      keys[id] = apiKey;
    } else {
      delete keys[id];
    }
    await this.preferenceService.set(AI_CONNECT_API_KEYS, keys, PreferenceScope.User);
  }

  // ---------------------------------------------------------------------------
  // Endpoints + aliases (two-level connection model)
  // ---------------------------------------------------------------------------

  /** Alias mode is active whenever at least one alias exists. */
  isAliasMode(resourceUri?: string): boolean {
    return this.readAliases(resourceUri).length > 0;
  }

  readEndpoints(resourceUri?: string): StoredAiEndpoint[] {
    const raw = this.readMigrated<StoredAiEndpoint[]>(AI_CONNECT_ENDPOINTS, [], resourceUri);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((endpoint): endpoint is StoredAiEndpoint =>
      typeof endpoint === 'object' && endpoint !== null && typeof (endpoint as StoredAiEndpoint).id === 'string'
    );
  }

  readAliases(resourceUri?: string): StoredAiAlias[] {
    const raw = this.readMigrated<StoredAiAlias[]>(AI_CONNECT_ALIASES, [], resourceUri);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((alias): alias is StoredAiAlias =>
      typeof alias === 'object' && alias !== null && typeof (alias as StoredAiAlias).id === 'string' && Array.isArray((alias as StoredAiAlias).chain)
    );
  }

  getActiveAliasId(resourceUri?: string): string {
    const aliases = this.readAliases(resourceUri);
    const configured = this.getPreferenceText(AI_CONNECT_ACTIVE_ALIAS, resourceUri);
    if (configured && aliases.some(alias => alias.id === configured)) {
      return configured;
    }
    return aliases[0]?.id ?? '';
  }

  getPinnedEndpointId(resourceUri?: string): string {
    return this.getPreferenceText(AI_CONNECT_PINNED_ENDPOINT, resourceUri);
  }

  /** Resolve the active (or given) alias chain into an ordered failover list. */
  resolveAliasChain(aliasId?: string, now: Date = new Date(), resourceUri?: string): AiConnectionProfile[] {
    return this.resolveAliasChainDetailed(aliasId, now, resourceUri).chain;
  }

  /** Richer resolution used by the UI: also reports the skipped endpoints. */
  resolveAliasChainDetailed(aliasId?: string, now: Date = new Date(), resourceUri?: string): ResolvedAliasChain {
    const endpoints = this.readEndpoints(resourceUri);
    const aliases = this.readAliases(resourceUri);
    const activeId = aliasId || this.getActiveAliasId(resourceUri);
    const keys = this.readApiKeys();
    const pinned = this.getPinnedEndpointId(resourceUri) || undefined;
    return resolveChainFromConfig(endpoints, aliases, activeId, keys, now, pinned);
  }

  /**
   * Build a one-off AiConnectionProfile for verifying/probing an endpoint with a
   * chosen model, WITHOUT saving or activating anything. The secret comes from
   * `overrideSecret` (the edit form's draft key) when present, else the saved
   * user-scope key for the endpoint id.
   */
  buildEndpointProbeProfile(endpoint: StoredAiEndpoint, model: string, overrideSecret?: string): AiConnectionProfile {
    const keys = this.readApiKeys();
    const override = typeof overrideSecret === 'string' ? overrideSecret.trim() : '';
    const secret = override || (typeof keys[endpoint.id] === 'string' ? keys[endpoint.id] : '');
    return resolveEndpointLeg(endpoint, model, secret);
  }

  async listEndpoints(resourceUri?: string): Promise<AiEndpointDescriptor[]> {
    await this.preferenceService.ready;
    const now = new Date();
    const keys = this.readApiKeys();
    return this.readEndpoints(resourceUri).map(endpoint => {
      const windows = Array.isArray(endpoint.timeWindows) ? endpoint.timeWindows : [];
      const parsed = parseTimeWindows(windows);
      const enabled = endpoint.enabled !== false;
      return {
        id: endpoint.id,
        label: endpoint.label || endpoint.id,
        provider: endpoint.provider || '',
        transportKind: endpoint.transportKind || 'api',
        endpointUrl: endpoint.endpointUrl || undefined,
        enabled,
        hasApiKey: typeof keys[endpoint.id] === 'string' && keys[endpoint.id].trim().length > 0,
        allowedModels: Array.isArray(endpoint.allowedModels) && endpoint.allowedModels.length > 0 ? endpoint.allowedModels : undefined,
        timeWindows: windows,
        availableNow: enabled && isWithinWindows(windows, now),
        windowWarning: parsed.hasWarning
      };
    });
  }

  async listAliases(resourceUri?: string): Promise<AiAliasDescriptor[]> {
    await this.preferenceService.ready;
    const now = new Date();
    const activeId = this.getActiveAliasId(resourceUri);
    const endpoints = this.readEndpoints(resourceUri);
    const endpointsById = new Map(endpoints.map(endpoint => [endpoint.id, endpoint]));
    return this.readAliases(resourceUri).map(alias => {
      const chain = Array.isArray(alias.chain) ? alias.chain : [];
      const availableLegs = chain.filter(leg => {
        const endpoint = endpointsById.get(leg.endpointId);
        return Boolean(endpoint) && endpoint!.enabled !== false && isWithinWindows(endpoint!.timeWindows, now);
      }).length;
      return {
        id: alias.id,
        label: alias.label || alias.id,
        active: alias.id === activeId,
        enabled: alias.enabled !== false,
        chain,
        availableLegs
      };
    });
  }

  async setActiveAlias(id: string): Promise<void> {
    await this.setWorkspacePreference(AI_CONNECT_ACTIVE_ALIAS, id);
  }

  async setPinnedEndpoint(id: string): Promise<void> {
    await this.setWorkspacePreference(AI_CONNECT_PINNED_ENDPOINT, id);
  }

  async upsertEndpoint(endpoint: StoredAiEndpoint): Promise<void> {
    const endpoints = this.readEndpoints();
    const index = endpoints.findIndex(candidate => candidate.id === endpoint.id);
    const next = [...endpoints];
    if (index >= 0) {
      next[index] = endpoint;
    } else {
      next.push(endpoint);
    }
    await this.setWorkspacePreference(AI_CONNECT_ENDPOINTS, next);
  }

  async deleteEndpoint(id: string): Promise<void> {
    const endpoints = this.readEndpoints();
    const next = endpoints.filter(endpoint => endpoint.id !== id);
    await this.setWorkspacePreference(AI_CONNECT_ENDPOINTS, next);
    if (this.getPinnedEndpointId() === id) {
      await this.setPinnedEndpoint('');
    }
    const keys = { ...this.readApiKeys() };
    if (id in keys) {
      delete keys[id];
      await this.preferenceService.set(AI_CONNECT_API_KEYS, keys, PreferenceScope.User);
    }
  }

  async moveEndpoint(id: string, delta: -1 | 1): Promise<void> {
    await this.setWorkspacePreference(AI_CONNECT_ENDPOINTS, this.moveInList(this.readEndpoints(), id, delta));
  }

  async reorderEndpoint(id: string, targetIndex: number): Promise<void> {
    await this.setWorkspacePreference(AI_CONNECT_ENDPOINTS, this.reorderList(this.readEndpoints(), id, targetIndex));
  }

  async upsertAlias(alias: StoredAiAlias): Promise<void> {
    const aliases = this.readAliases();
    const index = aliases.findIndex(candidate => candidate.id === alias.id);
    const next = [...aliases];
    if (index >= 0) {
      next[index] = alias;
    } else {
      next.push(alias);
    }
    await this.setWorkspacePreference(AI_CONNECT_ALIASES, next);
    if (next.length === 1) {
      await this.setActiveAlias(alias.id);
    }
  }

  async deleteAlias(id: string): Promise<void> {
    const aliases = this.readAliases();
    const next = aliases.filter(alias => alias.id !== id);
    await this.setWorkspacePreference(AI_CONNECT_ALIASES, next);
    if (this.getActiveAliasId() === id && next.length > 0) {
      await this.setActiveAlias(next[0].id);
    }
  }

  async moveAlias(id: string, delta: -1 | 1): Promise<void> {
    await this.setWorkspacePreference(AI_CONNECT_ALIASES, this.moveInList(this.readAliases(), id, delta));
  }

  async reorderAlias(id: string, targetIndex: number): Promise<void> {
    await this.setWorkspacePreference(AI_CONNECT_ALIASES, this.reorderList(this.readAliases(), id, targetIndex));
  }

  /** Replace an alias's chain (used by the leg add/remove/reorder controls). */
  async setAliasChain(aliasId: string, chain: AliasChainLeg[]): Promise<void> {
    const aliases = this.readAliases();
    const index = aliases.findIndex(alias => alias.id === aliasId);
    if (index < 0) {
      return;
    }
    const next = [...aliases];
    next[index] = { ...next[index], chain };
    await this.setWorkspacePreference(AI_CONNECT_ALIASES, next);
  }

  async addAliasLeg(aliasId: string, leg: AliasChainLeg): Promise<void> {
    const alias = this.readAliases().find(candidate => candidate.id === aliasId);
    if (!alias) {
      return;
    }
    await this.setAliasChain(aliasId, [...alias.chain, leg]);
  }

  async removeAliasLeg(aliasId: string, legIndex: number): Promise<void> {
    const alias = this.readAliases().find(candidate => candidate.id === aliasId);
    if (!alias || legIndex < 0 || legIndex >= alias.chain.length) {
      return;
    }
    const chain = [...alias.chain];
    chain.splice(legIndex, 1);
    await this.setAliasChain(aliasId, chain);
  }

  async moveAliasLeg(aliasId: string, legIndex: number, delta: -1 | 1): Promise<void> {
    const alias = this.readAliases().find(candidate => candidate.id === aliasId);
    if (!alias) {
      return;
    }
    const target = legIndex + delta;
    if (legIndex < 0 || target < 0 || target >= alias.chain.length) {
      return;
    }
    const chain = [...alias.chain];
    [chain[legIndex], chain[target]] = [chain[target], chain[legIndex]];
    await this.setAliasChain(aliasId, chain);
  }

  protected moveInList<T extends { id: string }>(list: T[], id: string, delta: -1 | 1): T[] {
    const index = list.findIndex(item => item.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) {
      return list;
    }
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }

  protected reorderList<T extends { id: string }>(list: T[], id: string, targetIndex: number): T[] {
    const index = list.findIndex(item => item.id === id);
    if (index < 0) {
      return list;
    }
    const clamped = Math.max(0, Math.min(targetIndex, list.length - 1));
    if (clamped === index) {
      return list;
    }
    const next = [...list];
    const [moved] = next.splice(index, 1);
    next.splice(clamped, 0, moved);
    return next;
  }

  protected readApiKeys(): Record<string, string> {
    const raw = this.readMigrated<Record<string, string>>(AI_CONNECT_API_KEYS, {});
    return typeof raw === 'object' && raw !== null ? raw : {};
  }

  /**
   * Read a migrated `aiConnect.*` preference: the new key wins when explicitly
   * set (any scope), else the legacy `aiFocusedEditor.ai.*` value, else default.
   * Applied to every stored-connection read so pre-migration user settings keep
   * working without a one-time rewrite.
   */
  protected readMigrated<T>(newKey: string, defaultValue: T, resourceUri?: string): T {
    const legacyKey = AI_CONNECT_LEGACY_KEY_BY_NEW[newKey];
    const neu = this.preferenceService.inspect(newKey, resourceUri);
    const legacy = legacyKey ? this.preferenceService.inspect(legacyKey, resourceUri) : undefined;
    const isSet = (inspection: typeof neu): boolean =>
      !!inspection && (
        inspection.globalValue !== undefined ||
        inspection.workspaceValue !== undefined ||
        inspection.workspaceFolderValue !== undefined
      );
    return resolveWithLegacy<T>({
      newValue: neu?.value as T | undefined,
      newSet: isSet(neu),
      legacyValue: legacy?.value as T | undefined,
      legacySet: isSet(legacy),
      defaultValue
    });
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
    return (this.readMigrated<string>(preferenceName, '', resourceUri) ?? '').trim();
  }
}
