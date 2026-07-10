import {
  listTextProviderCatalog,
  type AiConnectConfigInput
} from '@vedmalex/ai-connect';
import type {
  AiConnectionProfile,
  AiTransportKind
} from '../common';

const PROVIDER_CATALOG = Object.freeze(listTextProviderCatalog());
const DEFAULT_TRANSPORT_KIND: AiTransportKind = 'api';
const LOCAL_PROXY_BASE_URLS = Object.freeze({
  openai: 'http://127.0.0.1:8045/v1',
  anthropic: 'http://127.0.0.1:8045/v1',
  gemini: 'http://127.0.0.1:8045/v1beta/models'
});
const LOCAL_PROXY_DEFAULT_MODELS = Object.freeze({
  openai: 'gpt-oss-120b-medium',
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-3.1-pro-low'
});
const NON_CATALOG_CLI_ARGS = Object.freeze([
  '-p',
  '{prompt}',
  '--model',
  '{model}',
  '{files}',
  '--print-timeout',
  '110s'
]);
const NON_CATALOG_CLI_FILE_CATEGORIES = Object.freeze([
  'text',
  'image',
  'document',
  'other'
]);

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTransportKind(value: unknown): AiTransportKind {
  const transportKind = normalizeText(value);
  if (transportKind === 'proxy') {
    return 'api';
  }
  if (transportKind === 'api' || transportKind === 'acp' || transportKind === 'cli' || transportKind === 'server') {
    return transportKind;
  }
  return DEFAULT_TRANSPORT_KIND;
}

function normalizeApprovalEnv(env: Record<string, string> = {}): [string, string][] {
  return Object.entries(env)
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => [key.trim(), value.trim()] as [string, string])
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
}

function normalizeLocalAuthMethodId(
  provider: string,
  transportKind: AiTransportKind,
  transportId: string,
  authMethodId?: string
): string {
  const normalizedAuthMethodId = normalizeText(authMethodId);
  if (!normalizedAuthMethodId || transportKind !== 'acp') {
    return normalizedAuthMethodId;
  }
  if (provider === 'gemini' && transportId === 'gemini-acp' && normalizedAuthMethodId === 'oauth') {
    return 'oauth-personal';
  }
  return normalizedAuthMethodId;
}

function getProviderEntry(provider: string) {
  return PROVIDER_CATALOG.find(item => item.providerId === normalizeText(provider));
}

function getTransportEntries(provider: string, transportKind = '') {
  const entry = getProviderEntry(provider);
  if (!entry) {
    return [];
  }
  const normalizedKind = transportKind ? normalizeTransportKind(transportKind) : undefined;
  return entry.transports.filter(transport => !normalizedKind || transport.transportKind === normalizedKind);
}

function getTransportEntry(provider: string, transportId?: string) {
  const normalizedTransportId = normalizeText(transportId);
  if (!normalizedTransportId) {
    return undefined;
  }
  return getProviderEntry(provider)?.transports.find(transport => transport.transportId === normalizedTransportId);
}

function isAiConnectProvider(provider: string): boolean {
  return Boolean(getProviderEntry(provider));
}

function resolveDefaultTransportId(provider: string, transportKind: AiTransportKind = DEFAULT_TRANSPORT_KIND): string {
  return getTransportEntries(provider, transportKind)[0]?.transportId || '';
}

function getAiConnectBootstrapModel(profile: AiConnectionProfile): string {
  const explicitModel = normalizeText(profile.model);
  if (explicitModel) {
    return explicitModel;
  }
  return getTransportEntry(profile.provider, getAiConnectTransportId(profile))?.defaultModel || '';
}

function getAiConnectAccountModels(profile: AiConnectionProfile): string[] {
  const models = [getAiConnectBootstrapModel(profile)];
  for (const allowed of profile.allowedModels ?? []) {
    const model = normalizeText(allowed);
    if (model && !models.includes(model)) {
      models.push(model);
    }
  }
  return models;
}

export function getAiConnectTransportId(profile: AiConnectionProfile): string {
  const provider = normalizeText(profile.provider);
  const explicitTransportId = normalizeText(profile.transportId || profile.connectorType);
  if (explicitTransportId && getTransportEntry(provider, explicitTransportId)) {
    return explicitTransportId;
  }

  const fallbackId = resolveDefaultTransportId(provider, normalizeTransportKind(profile.transportKind));
  return fallbackId || resolveDefaultTransportId(provider, DEFAULT_TRANSPORT_KIND);
}

export function getAiConnectTransportKind(profile: AiConnectionProfile): AiTransportKind {
  const provider = normalizeText(profile.provider);
  const transportId = getAiConnectTransportId(profile);
  return getTransportEntry(provider, transportId)?.transportKind || normalizeTransportKind(profile.transportKind);
}

export async function computeLocalCommandApprovalKey(command: string, env: Record<string, string> = {}): Promise<string> {
  let canonical = `cmd:${normalizeText(command)}\n`;
  for (const [key, value] of normalizeApprovalEnv(env)) {
    canonical += `env:${key}=${value}\n`;
  }

  const encoded = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeAiConnectEndpointUrl(provider: string, endpointUrl?: string): string {
  const normalizedProvider = normalizeText(provider);
  const baseUrl = normalizeText(endpointUrl).replace(/\/+$/, '');
  if (!baseUrl) {
    return '';
  }
  if (normalizedProvider === 'anthropic' && baseUrl.endsWith('/messages')) {
    return baseUrl.replace(/\/messages$/, '');
  }
  if (normalizedProvider === 'openai' && baseUrl.endsWith('/chat/completions')) {
    return baseUrl.replace(/\/chat\/completions$/, '');
  }
  if (normalizedProvider === 'gemini' && baseUrl.endsWith(':generateContent')) {
    return baseUrl.replace(/:generateContent$/, '');
  }
  return baseUrl;
}

export interface LocalProxyEndpointDefaults {
  url: string;
  model: string;
  models: string[];
}

export function getLocalProxyEndpointDefaults(provider = 'openai'): LocalProxyEndpointDefaults {
  const normalizedProvider = normalizeText(provider);
  if (normalizedProvider === 'anthropic') {
    return {
      url: LOCAL_PROXY_BASE_URLS.anthropic,
      model: LOCAL_PROXY_DEFAULT_MODELS.anthropic,
      models: [LOCAL_PROXY_DEFAULT_MODELS.anthropic]
    };
  }
  if (normalizedProvider === 'gemini') {
    return {
      url: LOCAL_PROXY_BASE_URLS.gemini,
      model: LOCAL_PROXY_DEFAULT_MODELS.gemini,
      models: ['gemini-3.1-pro-low', 'gemini-3-flash']
    };
  }
  return {
    url: LOCAL_PROXY_BASE_URLS.openai,
    model: LOCAL_PROXY_DEFAULT_MODELS.openai,
    models: [LOCAL_PROXY_DEFAULT_MODELS.openai]
  };
}

export function getAiConnectEndpointModelProbeUrl(provider = '', endpointUrl = ''): string {
  const normalizedProvider = normalizeText(provider);
  const baseUrl = normalizeAiConnectEndpointUrl(normalizedProvider, endpointUrl);
  if (!baseUrl) {
    return '';
  }
  if (baseUrl.endsWith('/models')) {
    return baseUrl;
  }
  return `${baseUrl}/models`;
}

export interface AiProviderCatalogTransport {
  transportKind: AiTransportKind;
  transportId: string;
  transportLabel: string;
  defaultModel: string;
  defaultBaseUrl?: string;
  defaultCommand?: string;
}

export interface AiProviderCatalogEntry {
  providerId: string;
  label: string;
  transports: AiProviderCatalogTransport[];
}

export function getAiProviderCatalog(): AiProviderCatalogEntry[] {
  return PROVIDER_CATALOG.map(entry => ({
    providerId: entry.providerId,
    label: entry.label,
    transports: entry.transports.map(transport => ({
      transportKind: transport.transportKind,
      transportId: transport.transportId,
      transportLabel: transport.transportLabel,
      defaultModel: transport.defaultModel,
      defaultBaseUrl: transport.defaultBaseUrl,
      defaultCommand: transport.defaultCommand
    }))
  }));
}

export function buildAiConnectRouteSelector(profile: AiConnectionProfile): string {
  const provider = normalizeText(profile.provider);
  const accountId = normalizeText(profile.id) || `${provider}-default`;
  return `${provider}:${accountId}:${getAiConnectBootstrapModel(profile)}`;
}

function buildNonCatalogConfigInput(profile: AiConnectionProfile): AiConnectConfigInput {
  const provider = normalizeText(profile.provider);
  const accountId = normalizeText(profile.id) || `${provider}-default`;
  const model = getAiConnectBootstrapModel(profile);
  const transportKind = normalizeTransportKind(profile.transportKind || 'cli');
  const command = normalizeText(profile.command);
  const transportId = `${provider}-${transportKind}`;
  const transport = transportKind === 'cli'
    ? {
        kind: 'cli',
        id: transportId,
        command: command || provider,
        cli: {
          argsTemplate: [...NON_CATALOG_CLI_ARGS],
          parser: { kind: 'text', stripAnsi: true },
          discovery: { via: 'none' },
          fileInput: {
            placement: 'args',
            perFileArgs: ['@{path}'],
            categories: [...NON_CATALOG_CLI_FILE_CATEGORIES]
          }
        }
      }
    : {
        kind: transportKind,
        id: transportId,
        ...(command ? { command } : {})
      };

  return {
    providers: {
      [provider]: {
        accounts: [{
          id: accountId,
          profile: accountId,
          transport,
          models: getAiConnectAccountModels(profile),
          modelAllowlistMode: 'shortlist'
        }]
      }
    },
    routing: {
      operations: {
        text: [buildAiConnectRouteSelector(profile)]
      }
    }
  } as AiConnectConfigInput;
}

export function buildAiConnectConfigInput(profile: AiConnectionProfile): AiConnectConfigInput {
  if (!isAiConnectProvider(profile.provider)) {
    return buildNonCatalogConfigInput(profile);
  }

  const provider = normalizeText(profile.provider);
  const accountId = normalizeText(profile.id) || `${provider}-default`;
  const model = getAiConnectBootstrapModel(profile);
  const endpointUrl = normalizeAiConnectEndpointUrl(provider, profile.endpointUrl || profile.url || profile.endpoint);
  const transportId = getAiConnectTransportId(profile);
  const transportKind = getAiConnectTransportKind(profile);
  const authMethodId = normalizeLocalAuthMethodId(
    provider,
    transportKind,
    transportId,
    profile.authMethodId || profile.connectorRef
  );
  const command = normalizeText(profile.command);
  const transport = transportKind === 'api'
    ? {
        kind: 'api',
        id: transportId || 'api',
        ...(endpointUrl ? { baseUrl: endpointUrl } : {})
      }
    : {
        kind: transportKind,
        id: transportId,
        ...((transportKind === 'server' && endpointUrl) ? { baseUrl: endpointUrl } : {}),
        ...(command ? { command } : {}),
        ...(authMethodId ? { auth: { methodId: authMethodId } } : {})
      };

  return {
    providers: {
      [provider]: {
        accounts: [{
          id: accountId,
          profile: accountId,
          transport,
          models: getAiConnectAccountModels(profile),
          ...(transportKind === 'api'
            ? {
                credentials: [{
                  id: `${accountId}-credential`,
                  apiKey: normalizeText(profile.secretValue)
                }]
              }
            : {})
        }]
      }
    },
    routing: {
      operations: {
        text: [buildAiConnectRouteSelector(profile)]
      }
    }
  } as AiConnectConfigInput;
}
