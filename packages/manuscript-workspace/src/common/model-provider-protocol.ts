import type { AiConnectionProfile } from './ai-connection-protocol';
import type { AliasChainLeg } from './ai-alias-resolution';

export const ModelProviderRegistry = Symbol('ModelProviderRegistry');

/**
 * UI view of an ENDPOINT (channel) row in the Model Config Endpoints list.
 */
export interface AiEndpointDescriptor {
  id: string;
  label: string;
  provider: string;
  transportKind: string;
  endpointUrl?: string;
  enabled: boolean;
  hasApiKey: boolean;
  /** Compact availability windows, if any. */
  timeWindows: string[];
  /** Whether the endpoint is available right now (time-window + enabled). */
  availableNow: boolean;
  /** True when time-window strings failed to parse (treated as always-on). */
  windowWarning: boolean;
}

/**
 * UI view of an ALIAS (chain) row in the Model Config Aliases list.
 */
export interface AiAliasDescriptor {
  id: string;
  label: string;
  active: boolean;
  enabled: boolean;
  chain: AliasChainLeg[];
  /** How many chain legs resolve to an available endpoint right now. */
  availableLegs: number;
}

/**
 * A named, persistable AI profile (FR-013 "alias"). Secrets are NOT part of the
 * stored shape — API keys live in a user-scope preference map keyed by id.
 */
export interface StoredAiProfile {
  id: string;
  label?: string;
  provider: string;
  model: string;
  transportKind?: string;
  transportId?: string;
  profileId?: string;
  endpointUrl?: string;
  command?: string;
  authMethodId?: string;
  allowedModels?: string[];
  enabled?: boolean;
}

export interface AiProfileDescriptor {
  id: string;
  label: string;
  provider: string;
  model: string;
  transportKind: string;
  enabled: boolean;
  active: boolean;
  configured: boolean;
  missing: string[];
  hasApiKey: boolean;
  endpointUrl?: string;
  allowedModels?: string[];
}

/**
 * FR-013: multiple named provider/model profiles with an active selection and
 * an ordered failover chain (active profile first, then the remaining enabled
 * profiles in list order).
 */
export interface ModelProviderRegistry {
  listProfiles(): Promise<AiProfileDescriptor[]>;
  getActiveProfile(): Promise<AiConnectionProfile | undefined>;
  getFailoverChain(): Promise<AiConnectionProfile[]>;
  setActiveProfile(id: string): Promise<void>;
  upsertProfile(profile: StoredAiProfile): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  moveProfile(id: string, delta: -1 | 1): Promise<void>;
  /** Moves a profile to an absolute position in the failover order (FR-020 drag/drop). */
  reorderProfile(id: string, targetIndex: number): Promise<void>;
  setApiKey(id: string, apiKey: string): Promise<void>;
}
