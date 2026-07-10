import type { AliasChainLeg } from './ai-alias-resolution';

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
  /** Curated model shortlist for this endpoint (suggestions for alias legs). */
  allowedModels?: string[];
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
