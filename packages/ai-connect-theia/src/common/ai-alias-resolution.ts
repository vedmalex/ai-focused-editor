import { convertV1Registry } from '@vedmalex/ai-connect/registry';
import type { ConnectionRegistry, RegistryEndpoint } from '@vedmalex/ai-connect/registry';
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
  /** Curated model shortlist for this endpoint (offered as alias-leg suggestions). */
  allowedModels?: string[];
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
 * Result of converting a v2 {@link ConnectionRegistry} back into the editor's
 * stored preference shapes. Secrets are pulled into `keys` (keyed by endpoint id)
 * so they land in the user-scope map, never on the endpoint record.
 */
export interface RegistryToStoredResult {
  endpoints: StoredAiEndpoint[];
  aliases: StoredAiAlias[];
  keys: Record<string, string>;
  /** `registry.defaults.alias` — the document's active alias, if declared. */
  defaultAliasId?: string;
}

/** Map a RegistryEndpoint.models list to a StoredAiEndpoint.allowedModels shortlist. */
function mapRegistryModels(endpoint: RegistryEndpoint): string[] {
  const models = Array.isArray(endpoint.models) ? endpoint.models : [];
  const ids = models
    .map(model => (typeof model === 'string' ? text(model) : text((model as { id?: unknown }).id)))
    .filter(id => id.length > 0);
  const defaultModel = text(endpoint.defaultModel);
  // The library orders defaultModel first at compile time; preserve that so a
  // round-trip through storedToRegistry reproduces the same head-of-list.
  if (defaultModel) {
    return [defaultModel, ...ids.filter(id => id !== defaultModel)];
  }
  return ids;
}

/** Extract the opaque `metadata.timeWindows` string[] the library round-trips verbatim. */
function mapTimeWindows(metadata: RegistryEndpoint['metadata']): string[] {
  const raw = metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>).timeWindows
    : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(text).filter(window => window.length > 0);
}

/**
 * Convert a v2 {@link ConnectionRegistry} into StoredAiEndpoint[]/StoredAiAlias[]
 * via an explicit whitelist. Secrets (`auth.token`) go into `keys`, never onto the
 * endpoint. Fields with no stored slot (kind, headers, envPassthrough,
 * contextWindow, maxOutputTokens, capabilities, cli, liveCheck, allowlistMode,
 * auth.fallbackTokens/params/tokenEnv) are intentionally dropped. Reused by both
 * the v1 import path (parseV1Import) and the v2 file import (block 3b).
 */
export function storedFromRegistry(registry: ConnectionRegistry): RegistryToStoredResult {
  const endpoints: StoredAiEndpoint[] = [];
  const keys: Record<string, string> = {};
  const endpointsById = new Map<string, RegistryEndpoint>();

  for (const ep of registry.endpoints ?? []) {
    const id = text(ep.id);
    if (!id) {
      continue;
    }
    endpointsById.set(id, ep);

    const stored: StoredAiEndpoint = {
      id,
      provider: text(ep.provider) || 'openai'
    };
    const label = text(ep.label);
    if (label) {
      stored.label = label;
    }
    const transportKind = text(ep.transport);
    if (transportKind) {
      stored.transportKind = transportKind;
    }
    const transportId = text(ep.transportId);
    if (transportId) {
      stored.transportId = transportId;
    }
    const endpointUrl = text(ep.baseUrl);
    if (endpointUrl) {
      stored.endpointUrl = endpointUrl;
    }
    const command = text(ep.command);
    if (command) {
      stored.command = command;
    }
    const authMethodId = text(ep.auth?.methodId);
    if (authMethodId) {
      stored.authMethodId = authMethodId;
    }
    if (ep.env && typeof ep.env === 'object' && !Array.isArray(ep.env)) {
      stored.env = ep.env as Record<string, string>;
    }
    const allowedModels = mapRegistryModels(ep);
    if (allowedModels.length > 0) {
      stored.allowedModels = allowedModels;
    }
    const timeWindows = mapTimeWindows(ep.metadata);
    if (timeWindows.length > 0) {
      stored.timeWindows = timeWindows;
    }
    if (ep.enabled === false) {
      stored.enabled = false;
    }
    const token = text(ep.auth?.token);
    if (token) {
      keys[id] = token;
    }
    endpoints.push(stored);
  }

  const aliases: StoredAiAlias[] = [];
  for (const al of registry.aliases ?? []) {
    const id = text(al.id);
    if (!id) {
      continue;
    }
    const chain: AliasChainLeg[] = (Array.isArray(al.chain) ? al.chain : [])
      .map(leg => {
        const endpointId = text(leg.endpointId);
        // RegistryAlias legs allow an optional model; fall back to the endpoint's
        // defaultModel, then '' (StoredAiAlias legs require a string).
        const model = text(leg.model) || text(endpointsById.get(endpointId)?.defaultModel) || '';
        return { endpointId, model };
      })
      .filter(leg => leg.endpointId.length > 0);
    const stored: StoredAiAlias = { id, chain };
    const label = text(al.label) || text(al.description);
    if (label) {
      stored.label = label;
    }
    if (al.enabled === false) {
      stored.enabled = false;
    }
    aliases.push(stored);
  }

  const defaultAliasId = text(registry.defaults?.alias);
  return { endpoints, aliases, keys, defaultAliasId: defaultAliasId || undefined };
}

/**
 * Compat overlay closing the gap between convertV1Registry (bs-search v1 dialect)
 * and the ai-editor v1 dialect. convertV1Registry silently ignores the ai-editor
 * fields (`apiKey`, `endpoint`/`endpointUrl` alt to `url`, `command`, `env`,
 * `timeWindows`, `enabled`, `transportKind`); this re-applies them onto the
 * already-converted endpoints, keyed by id. It NEVER creates new endpoints (so
 * `deleted:true` tombstones the library dropped stay dropped) and never touches
 * aliases.
 */
function overlayAiEditorV1Fields(
  base: RegistryToStoredResult,
  endpointsFile: V1EndpointsFile | undefined
): V1ImportResult {
  const endpointsById = new Map<string, StoredAiEndpoint>();
  for (const endpoint of base.endpoints) {
    endpointsById.set(endpoint.id, endpoint);
  }

  for (const raw of endpointsFile?.endpoints ?? []) {
    const id = text(raw.id);
    if (!id) {
      continue;
    }
    const endpoint = endpointsById.get(id);
    if (!endpoint) {
      continue;
    }

    // ai-editor v1 endpoint-URL aliases the library does not know (`endpointUrl`
    // direct, `endpoint` as alt to `url`). `url` is already handled → baseUrl.
    const endpointUrl = text(raw.endpointUrl) || text(raw.endpoint);
    if (endpointUrl) {
      endpoint.endpointUrl = endpointUrl;
    }
    const command = text(raw.command);
    if (command) {
      endpoint.command = command;
    }
    const transportKind = text(raw.transportKind);
    if (transportKind) {
      endpoint.transportKind = transportKind;
    }
    if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
      endpoint.env = raw.env as Record<string, string>;
    }
    if (Array.isArray(raw.timeWindows)) {
      const windows = (raw.timeWindows as unknown[]).map(text).filter(window => window.length > 0);
      if (windows.length > 0) {
        endpoint.timeWindows = windows;
      }
    }
    if (raw.enabled === false) {
      endpoint.enabled = false;
    }
    // ai-editor v1 uses `apiKey` (fallback `token`); convertV1Registry only reads
    // `token`, so restore the secret into the user-scope keys map here.
    const secret = text(raw.apiKey) || text(raw.token);
    if (secret) {
      base.keys[id] = secret;
    }
  }

  // NOTE (F-D3.2-3): V1ImportResult intentionally omits defaultAliasId. Its only
  // consumer, importV1Settings() in model-config-widget.ts, reads endpoints/
  // aliases/keys only — a v1 import does not adopt the document's active alias,
  // matching the pre-migration contract. defaultAliasId remains available on
  // RegistryToStoredResult for the v2 import path (block 3b), which does use it.
  return { endpoints: base.endpoints, aliases: base.aliases, keys: base.keys };
}

/**
 * Pure ai-editor v1 import: convert rag-endpoints.json + rag-aliases.json into
 * StoredAiEndpoint[]/StoredAiAlias[] through the library's convertV1Registry
 * (bs-search v1 → v2), the shared storedFromRegistry adapter, and a thin
 * ai-editor-dialect compat overlay. Name + signature preserved (widget contract).
 */
export function parseV1Import(
  endpointsFile: V1EndpointsFile | undefined,
  aliasesFile: V1AliasesFile | undefined
): V1ImportResult {
  const { registry } = convertV1Registry(endpointsFile, aliasesFile);
  const base = storedFromRegistry(registry);
  return overlayAiEditorV1Fields(base, endpointsFile);
}
