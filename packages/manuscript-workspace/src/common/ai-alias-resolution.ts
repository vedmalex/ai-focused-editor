import type { AiConnectionProfile, AiTransportKind } from './ai-connection-protocol';
import { isWithinWindows } from './ai-time-windows';

/**
 * A stored ENDPOINT (channel): where/how to reach a provider. Secrets are NOT
 * stored here — API keys live in a user-scope map keyed by endpoint id. The
 * v1-compat fallback fields (`transport`, `url`/`endpoint`, `apiKey`/`token`)
 * are accepted during resolution so a freshly imported ai-editor v1 endpoint
 * resolves identically without a normalization pass.
 */
export interface StoredAiEndpoint {
  id: string;
  label?: string;
  provider: string;
  transportKind?: string;
  transportId?: string;
  endpointUrl?: string;
  command?: string;
  authMethodId?: string;
  env?: Record<string, string>;
  /** Compact availability windows (see ai-time-windows). Empty/absent = always on. */
  timeWindows?: string[];
  enabled?: boolean;
  // --- ai-editor v1 import-compatibility fallbacks ---
  transport?: string;
  url?: string;
  endpoint?: string;
  apiKey?: string;
  token?: string;
}

/** One leg of an alias chain: an endpoint reference paired with a model id. */
export interface AliasChainLeg {
  endpointId: string;
  model: string;
}

/** A stored ALIAS (chain): an ordered list of endpoint+model legs. */
export interface StoredAiAlias {
  id: string;
  label?: string;
  chain: AliasChainLeg[];
  enabled?: boolean;
}

export type ChainSkipReason = 'missing-endpoint' | 'disabled' | 'outside-time-window';

export interface ResolvedChainSkip {
  endpointId: string;
  model: string;
  reason: ChainSkipReason;
}

export interface ResolvedAliasChain {
  aliasId?: string;
  aliasLabel?: string;
  /** True when a matching alias with a non-empty chain was found. */
  aliasFound: boolean;
  chain: AiConnectionProfile[];
  skipped: ResolvedChainSkip[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve one endpoint + model leg into an AiConnectionProfile using the exact
 * ai-editor v1 field fallbacks. The secret is supplied from the user-scope
 * apiKeys map (falling back to the v1 in-endpoint apiKey/token for freshly
 * imported records).
 */
export function resolveEndpointLeg(
  endpoint: StoredAiEndpoint,
  model: string,
  secret?: string
): AiConnectionProfile {
  const provider = text(endpoint.provider) || 'openai';
  const transportKind = (text(endpoint.transportKind) || text(endpoint.transport) || 'api') as AiTransportKind | 'proxy';
  const endpointUrl = text(endpoint.endpointUrl) || text(endpoint.url) || text(endpoint.endpoint);
  const secretValue = text(secret) || text(endpoint.apiKey) || text(endpoint.token);
  const command = text(endpoint.command);
  const env = endpoint.env && Object.keys(endpoint.env).length > 0 ? endpoint.env : undefined;
  const authMethodId = text(endpoint.authMethodId);
  const transportId = text(endpoint.transportId);

  return {
    id: text(endpoint.id) || provider,
    label: endpoint.label,
    provider,
    transportKind,
    transportId: transportId || undefined,
    endpointUrl: endpointUrl || undefined,
    model: text(model),
    command: command || undefined,
    authMethodId: authMethodId || undefined,
    env,
    secretValue: secretValue || undefined
  };
}

function reorderForPin(chain: AliasChainLeg[], pinnedEndpointId?: string): AliasChainLeg[] {
  const pinned = text(pinnedEndpointId);
  if (!pinned) {
    return chain;
  }
  const preferred = chain.filter(leg => leg.endpointId === pinned);
  if (preferred.length === 0) {
    return chain;
  }
  const rest = chain.filter(leg => leg.endpointId !== pinned);
  return [...preferred, ...rest];
}

/**
 * Pure resolution of an active alias into an ordered failover chain of
 * AiConnectionProfiles, plus the endpoints that were skipped (missing,
 * disabled, or outside their availability window at `now`).
 *
 * When `pinnedEndpointId` is set and appears in the chain, its legs are moved
 * to the front so the pinned endpoint is tried first.
 */
export function resolveChainFromConfig(
  endpoints: readonly StoredAiEndpoint[],
  aliases: readonly StoredAiAlias[],
  activeAliasId: string | undefined,
  keys: Record<string, string>,
  now: Date = new Date(),
  pinnedEndpointId?: string
): ResolvedAliasChain {
  const endpointsById = new Map<string, StoredAiEndpoint>();
  for (const endpoint of endpoints) {
    if (endpoint && typeof endpoint.id === 'string') {
      endpointsById.set(endpoint.id, endpoint);
    }
  }

  const activeId = text(activeAliasId);
  const alias = (activeId ? aliases.find(candidate => candidate.id === activeId) : undefined) ?? aliases[0];

  if (!alias || !Array.isArray(alias.chain) || alias.chain.length === 0) {
    return {
      aliasId: alias?.id,
      aliasLabel: alias?.label,
      aliasFound: Boolean(alias),
      chain: [],
      skipped: []
    };
  }

  const legs = reorderForPin(alias.chain, pinnedEndpointId);
  const chain: AiConnectionProfile[] = [];
  const skipped: ResolvedChainSkip[] = [];

  for (const leg of legs) {
    const endpoint = endpointsById.get(leg.endpointId);
    if (!endpoint) {
      skipped.push({ endpointId: leg.endpointId, model: leg.model, reason: 'missing-endpoint' });
      continue;
    }
    if (endpoint.enabled === false) {
      skipped.push({ endpointId: leg.endpointId, model: leg.model, reason: 'disabled' });
      continue;
    }
    if (!isWithinWindows(endpoint.timeWindows, now)) {
      skipped.push({ endpointId: leg.endpointId, model: leg.model, reason: 'outside-time-window' });
      continue;
    }
    chain.push(resolveEndpointLeg(endpoint, leg.model, keys[endpoint.id]));
  }

  return {
    aliasId: alias.id,
    aliasLabel: alias.label,
    aliasFound: true,
    chain,
    skipped
  };
}

/** Raw ai-editor v1 rag-endpoints.json / rag-aliases.json shapes. */
export interface V1EndpointsFile {
  endpoints?: Array<Record<string, unknown>>;
}
export interface V1AliasesFile {
  aliases?: Array<Record<string, unknown>>;
}

export interface V1ImportResult {
  endpoints: StoredAiEndpoint[];
  aliases: StoredAiAlias[];
  /** endpoint id -> API key, extracted from v1 apiKey|token for the user-scope map. */
  keys: Record<string, string>;
}

/**
 * Pure ai-editor v1 import: normalize rag-endpoints.json + rag-aliases.json into
 * StoredAiEndpoint[]/StoredAiAlias[] using the exact v1 field fallbacks
 * (apiKey|token, url|endpoint, transport, provider default 'openai'). Secrets are
 * pulled out into `keys` (keyed by endpoint id) so they land in the user-scope map.
 */
export function parseV1Import(
  endpointsFile: V1EndpointsFile | undefined,
  aliasesFile: V1AliasesFile | undefined
): V1ImportResult {
  const endpoints: StoredAiEndpoint[] = [];
  const keys: Record<string, string> = {};

  for (const raw of endpointsFile?.endpoints ?? []) {
    const id = text(raw.id);
    if (!id) {
      continue;
    }
    const provider = text(raw.provider) || 'openai';
    const transportKind = text(raw.transportKind) || text(raw.transport) || 'api';
    const endpointUrl = text(raw.endpointUrl) || text(raw.url) || text(raw.endpoint);
    const command = text(raw.command);
    const env = (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env))
      ? (raw.env as Record<string, string>)
      : undefined;
    const secret = text(raw.apiKey) || text(raw.token);
    if (secret) {
      keys[id] = secret;
    }
    endpoints.push({
      id,
      label: text(raw.label) || undefined,
      provider,
      transportKind,
      endpointUrl: endpointUrl || undefined,
      command: command || undefined,
      env,
      timeWindows: Array.isArray(raw.timeWindows)
        ? (raw.timeWindows as unknown[]).map(text).filter(window => window.length > 0)
        : undefined,
      enabled: raw.enabled === false ? false : undefined
    });
  }

  const aliases: StoredAiAlias[] = [];
  for (const raw of aliasesFile?.aliases ?? []) {
    // v1 keys the alias by `alias`; accept `id` as an alternative.
    const id = text(raw.alias) || text(raw.id);
    if (!id) {
      continue;
    }
    const chainRaw = Array.isArray(raw.chain) ? (raw.chain as Array<Record<string, unknown>>) : [];
    const chain: AliasChainLeg[] = chainRaw
      .map(leg => ({ endpointId: text(leg.endpointId), model: text(leg.model) }))
      .filter(leg => leg.endpointId.length > 0);
    aliases.push({
      id,
      label: text(raw.label) || text(raw.description) || undefined,
      chain,
      enabled: raw.enabled === false ? false : undefined
    });
  }

  return { endpoints, aliases, keys };
}
