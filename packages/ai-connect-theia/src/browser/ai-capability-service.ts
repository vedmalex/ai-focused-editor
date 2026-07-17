import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import type { AiConnectionProfile, AiRouteCapabilities } from '../common';
import { AiConnectionService as AiConnectionServiceSymbol } from '../common';
import type { AiConnectionService } from '../common';
import { AiProfilePreferenceService } from './ai-profile-preference-service';
import { AI_CONNECT_WATCHED_PREFERENCES } from './ai-connect-preferences';

/** Cache lifetime, mirroring the package's short-TTL discovery/entity caches. */
const CAPABILITIES_TTL_MS = 5000;

interface CacheEntry {
  at: number;
  value: AiRouteCapabilities | undefined;
}

/**
 * Reads what the active (or a named) alias's resolved route supports — vision,
 * client tools, streaming, file upload — BEFORE a request is sent, so the UI can
 * proactively gate features. Resolves the alias's representative profile via
 * {@link AiProfilePreferenceService}, then delegates to
 * {@link AiConnectionService.getCapabilities} (a synchronous, no-I/O projection
 * on the api path). A short TTL cache keyed by profile identity avoids rebuilding
 * a client on every UI refresh; any `aiConnect.*` preference change clears it.
 * Never throws — an unknown capability set surfaces as undefined.
 */
@injectable()
export class AiCapabilityService {
  @inject(AiProfilePreferenceService)
  protected readonly aiProfilePreferences!: AiProfilePreferenceService;

  @inject(AiConnectionServiceSymbol)
  protected readonly connectionService!: AiConnectionService;

  @inject(PreferenceService)
  protected readonly preferenceService!: PreferenceService;

  protected readonly cache = new Map<string, CacheEntry>();

  @postConstruct()
  protected init(): void {
    // Invalidate on any endpoint/alias/key/active-alias change (new + legacy keys).
    this.preferenceService.onPreferencesChanged(changes => {
      if (Object.keys(changes).some(key => AI_CONNECT_WATCHED_PREFERENCES.has(key))) {
        this.invalidate();
      }
    });
  }

  /** Capabilities of the route the ACTIVE alias resolves to (undefined if unknown/unconfigured). */
  async getActiveAliasCapabilities(): Promise<AiRouteCapabilities | undefined> {
    try {
      const profile = await this.aiProfilePreferences.getConfiguredProfile();
      return this.getCapabilitiesForProfile(profile);
    } catch {
      return undefined;
    }
  }

  /** Capabilities of the route a SPECIFIC alias resolves to, independent of the active alias. */
  async getCapabilitiesForAlias(aliasId: string): Promise<AiRouteCapabilities | undefined> {
    try {
      const chain = await this.aiProfilePreferences.getFailoverChainForAlias(aliasId);
      // Prefer the first fully-usable leg (the one that will actually serve),
      // else the head of the chain so we still report something plausible.
      const profile = chain.find(leg => Boolean(leg.provider) && Boolean(leg.model)) ?? chain[0];
      return this.getCapabilitiesForProfile(profile);
    } catch {
      return undefined;
    }
  }

  /** Drop all cached capability entries (called on preference change). */
  invalidate(): void {
    this.cache.clear();
  }

  protected async getCapabilitiesForProfile(profile: AiConnectionProfile | undefined): Promise<AiRouteCapabilities | undefined> {
    if (!profile) {
      return undefined;
    }
    const key = this.profileKey(profile);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CAPABILITIES_TTL_MS) {
      return hit.value;
    }
    let value: AiRouteCapabilities | undefined;
    try {
      value = await this.connectionService.getCapabilities(profile);
    } catch {
      value = undefined;
    }
    this.cache.set(key, { at: now, value });
    return value;
  }

  /** Identity of the route a profile targets — the fields that change its capabilities. */
  protected profileKey(profile: AiConnectionProfile): string {
    return [
      profile.provider ?? '',
      profile.model ?? '',
      profile.transportKind ?? '',
      profile.transportId ?? '',
      profile.endpointUrl ?? profile.endpoint ?? profile.url ?? ''
    ].join('|');
  }
}
