import type { AiConnectionProfile } from './ai-connection-protocol';

export const ModelProviderRegistry = Symbol('ModelProviderRegistry');

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
