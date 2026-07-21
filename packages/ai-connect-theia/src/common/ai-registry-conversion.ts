import type {
  ConnectionRegistry,
  RegistryAlias,
  RegistryEndpoint,
  RegistrySecretsFragment
} from '@vedmalex/ai-connect/registry';
import type { StoredAiAlias, StoredAiEndpoint } from './ai-alias-resolution';

// The reverse direction (ConnectionRegistry -> Stored) is `storedFromRegistry`,
// re-exported from ./ai-alias-resolution and reused wherever a v2 file is imported.

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Fold the editor's transportKind onto the v2 transport enum (proxy -> api). */
function normalizeTransport(kind: string | undefined): RegistryEndpoint['transport'] {
  const value = text(kind);
  if (value === 'api' || value === 'acp' || value === 'cli' || value === 'server') {
    return value;
  }
  // '' and the v1-compat 'proxy' both fold to 'api' (matches resolveEndpointLeg).
  return 'api';
}

/**
 * Convert the editor's stored endpoints/aliases into a v2 {@link ConnectionRegistry}
 * (mirror of storedFromRegistry). WHITELIST is mandatory: the v1-compat secret/
 * legacy fields on StoredAiEndpoint (`apiKey`, `token`, `url`, `endpoint`,
 * `transport`) are the FIRST secret barrier and are NEVER copied into a
 * RegistryEndpoint — secrets travel only through {@link keysToSecretsFragment}.
 */
export function storedToRegistry(
  endpoints: readonly StoredAiEndpoint[],
  aliases: readonly StoredAiAlias[],
  opts?: { activeAliasId?: string }
): ConnectionRegistry {
  const registryEndpoints: RegistryEndpoint[] = [];
  for (const ep of endpoints) {
    const id = text(ep.id);
    if (!id) {
      continue;
    }
    const transport = normalizeTransport(ep.transportKind);
    const endpoint: RegistryEndpoint = {
      id,
      provider: text(ep.provider) || 'openai',
      transport
    };
    const label = text(ep.label);
    if (label) {
      endpoint.label = label;
    }
    const transportId = text(ep.transportId);
    if (transportId) {
      endpoint.transportId = transportId;
    }
    // baseUrl is an api/server-only slot; the v1-compat url/endpoint fields are
    // deliberately not read here.
    const baseUrl = text(ep.endpointUrl);
    if (baseUrl && (transport === 'api' || transport === 'server')) {
      endpoint.baseUrl = baseUrl;
    }
    const command = text(ep.command);
    if (command) {
      endpoint.command = command;
    }
    if (ep.env && typeof ep.env === 'object' && !Array.isArray(ep.env) && Object.keys(ep.env).length > 0) {
      endpoint.env = ep.env;
    }
    const models = (ep.allowedModels ?? []).map(text).filter(model => model.length > 0);
    if (models.length > 0) {
      endpoint.models = models;
    }
    const timeWindows = (ep.timeWindows ?? []).map(text).filter(window => window.length > 0);
    if (timeWindows.length > 0) {
      endpoint.metadata = { timeWindows };
    }
    const authMethodId = text(ep.authMethodId);
    if (authMethodId) {
      endpoint.auth = { methodId: authMethodId };
    }
    if (ep.enabled === false) {
      endpoint.enabled = false;
    }
    registryEndpoints.push(endpoint);
  }

  const registryAliases: RegistryAlias[] = [];
  for (const al of aliases) {
    const id = text(al.id);
    if (!id) {
      continue;
    }
    const chain = (Array.isArray(al.chain) ? al.chain : [])
      .map(leg => {
        const endpointId = text(leg.endpointId);
        const model = text(leg.model);
        // RegistryAlias legs carry an optional model; omit it when empty.
        return model ? { endpointId, model } : { endpointId };
      })
      .filter(leg => leg.endpointId.length > 0);
    const alias: RegistryAlias = { id, chain };
    const label = text(al.label);
    if (label) {
      alias.label = label;
    }
    if (al.enabled === false) {
      alias.enabled = false;
    }
    registryAliases.push(alias);
  }

  const registry: ConnectionRegistry = { version: 2, endpoints: registryEndpoints };
  if (registryAliases.length > 0) {
    registry.aliases = registryAliases;
  }
  const activeAliasId = text(opts?.activeAliasId);
  if (activeAliasId) {
    registry.defaults = { alias: activeAliasId };
  }
  return registry;
}

/**
 * Build the `connections.secrets.json` fragment from the user-scope key map. The
 * fragment is a "zero schema" partial (merged verbatim by the library, never run
 * through parseRegistry), so provider/transport are intentionally omitted. Empty
 * ids and blank tokens are dropped.
 */
export function keysToSecretsFragment(keys: Record<string, string>): RegistrySecretsFragment {
  const endpoints = Object.entries(keys)
    .filter(([id, token]) => text(id).length > 0 && text(token).length > 0)
    .map(([id, token]) => ({ id, auth: { token } }));
  return { endpoints: endpoints as unknown as RegistrySecretsFragment['endpoints'] };
}
