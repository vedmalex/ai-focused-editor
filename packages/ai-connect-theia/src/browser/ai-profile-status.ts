import type {
  AiConnectionProfile,
  ResolvedAliasChain
} from '../common';

/**
 * The resolved AI-connection status the UI (status bar, Model Config, AI Debug)
 * reads. Kept in this dependency-free module (no Theia browser imports) so the
 * `notConfigured` snapshot can be unit-tested without a DOM.
 */
export interface AiProfileStatus {
  configured: boolean;
  /**
   * True when nothing is configured at all: no named profiles and no aliases.
   * The UI reads this to show an explicit "not configured" state (distinct from
   * a configured-but-incomplete profile, where `configured` is false but
   * `notConfigured` stays false).
   */
  notConfigured: boolean;
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
    /** Label of the active named profile/alias ('' when not configured). */
    activeProfileLabel: string;
    /** Number of configured profiles in the failover chain. */
    chainLength: number;
    /** True when resolution runs through the endpoints/aliases model. */
    aliasMode: boolean;
    /** Active alias id ('' when not in alias mode). */
    activeAlias: string;
    /** Active alias label (falls back to id; '' when not in alias mode). */
    activeAliasLabel: string;
    /** Resolved first-leg endpoint id ('' when not in alias mode or unresolved). */
    activeEndpoint: string;
    /** Resolved first-leg endpoint label (falls back to id). */
    activeEndpointLabel: string;
    /** Pinned endpoint id ('' when no pin). */
    pinnedEndpoint: string;
    /** Endpoints skipped while resolving the active alias chain (for logging/UI). */
    skipped: ResolvedAliasChain['skipped'];
  };
}

/**
 * Status when nothing is configured: no named profiles and no aliases. There is
 * no active profile, so the connection is unconfigured (not merely incomplete).
 * The UI reads `notConfigured` to prompt the user to add a profile or alias.
 */
export function buildUnconfiguredAiProfileStatus(): AiProfileStatus {
  return {
    configured: false,
    notConfigured: true,
    missing: ['no AI profile configured'],
    profile: undefined,
    summary: {
      provider: '',
      model: '',
      transportKind: 'api',
      transportId: '',
      profileId: '',
      endpointUrl: '',
      hasApiKey: false,
      activeProfileLabel: '',
      chainLength: 0,
      aliasMode: false,
      activeAlias: '',
      activeAliasLabel: '',
      activeEndpoint: '',
      activeEndpointLabel: '',
      pinnedEndpoint: '',
      skipped: []
    }
  };
}
