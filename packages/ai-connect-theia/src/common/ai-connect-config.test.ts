import { describe, expect, test } from 'bun:test';
import {
  buildAiConnectConfigInput,
  buildAiConnectRouteSelector,
  getAiConnectEndpointModelProbeUrl,
  getAiConnectTransportKind,
  getAiProviderCatalog,
  getLocalProxyEndpointDefaults,
  normalizeAiConnectEndpointUrl
} from './ai-connect-config';

describe('getLocalProxyEndpointDefaults', () => {
  test('returns openai defaults for unknown/empty provider', () => {
    expect(getLocalProxyEndpointDefaults().url).toBe('http://127.0.0.1:8045/v1');
    expect(getLocalProxyEndpointDefaults('unknown').model).toBe('gpt-oss-120b-medium');
  });

  test('returns anthropic proxy defaults', () => {
    const defaults = getLocalProxyEndpointDefaults('anthropic');
    expect(defaults.url).toBe('http://127.0.0.1:8045/v1');
    expect(defaults.model).toBe('claude-sonnet-4-6');
  });

  test('returns gemini proxy defaults with model shortlist', () => {
    const defaults = getLocalProxyEndpointDefaults('gemini');
    expect(defaults.url).toBe('http://127.0.0.1:8045/v1beta/models');
    expect(defaults.models).toContain('gemini-3-flash');
  });
});

describe('getAiConnectEndpointModelProbeUrl', () => {
  test('appends /models to a bare base URL', () => {
    expect(getAiConnectEndpointModelProbeUrl('openai', 'http://127.0.0.1:8045/v1'))
      .toBe('http://127.0.0.1:8045/v1/models');
  });

  test('keeps an existing /models suffix', () => {
    expect(getAiConnectEndpointModelProbeUrl('gemini', 'http://127.0.0.1:8045/v1beta/models'))
      .toBe('http://127.0.0.1:8045/v1beta/models');
  });

  test('normalizes provider-specific completion suffixes first', () => {
    expect(getAiConnectEndpointModelProbeUrl('openai', 'https://api.example.com/v1/chat/completions'))
      .toBe('https://api.example.com/v1/models');
  });

  test('returns empty string without an endpoint', () => {
    expect(getAiConnectEndpointModelProbeUrl('openai', '')).toBe('');
  });
});

describe('normalizeAiConnectEndpointUrl', () => {
  test('strips trailing slashes', () => {
    expect(normalizeAiConnectEndpointUrl('openai', 'https://api.example.com/v1///'))
      .toBe('https://api.example.com/v1');
  });

  test('strips anthropic /messages suffix', () => {
    expect(normalizeAiConnectEndpointUrl('anthropic', 'https://api.anthropic.com/v1/messages'))
      .toBe('https://api.anthropic.com/v1');
  });

  test('strips gemini :generateContent suffix', () => {
    expect(normalizeAiConnectEndpointUrl('gemini', 'https://host/v1beta/models/gemini:generateContent'))
      .toBe('https://host/v1beta/models/gemini');
  });
});

describe('getAiProviderCatalog', () => {
  test('exposes catalog providers with transports', () => {
    const catalog = getAiProviderCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    const openai = catalog.find(entry => entry.providerId === 'openai');
    expect(openai).toBeDefined();
    expect(openai!.transports.length).toBeGreaterThan(0);
    expect(openai!.transports.every(transport => transport.transportId.length > 0)).toBe(true);
  });
});

describe('buildAiConnectConfigInput', () => {
  test('builds api transport config with credentials', () => {
    const config = buildAiConnectConfigInput({
      provider: 'openai',
      model: 'gpt-test',
      transportKind: 'api',
      secretValue: 'secret-key',
      endpointUrl: 'http://127.0.0.1:8045/v1'
    });
    const account = config.providers?.openai?.accounts?.[0] as unknown as Record<string, unknown>;
    expect(account).toBeDefined();
    const transport = account.transport as Record<string, unknown>;
    expect(transport.kind).toBe('api');
    expect(transport.baseUrl).toBe('http://127.0.0.1:8045/v1');
    const credentials = account.credentials as Array<Record<string, unknown>>;
    expect(credentials[0].apiKey).toBe('secret-key');
  });

  test('treats proxy transport as api', () => {
    const profile = {
      provider: 'openai',
      model: 'gpt-test',
      transportKind: 'proxy' as const,
      secretValue: 'k'
    };
    expect(getAiConnectTransportKind(profile)).toBe('api');
  });

  test('omits credentials for non-api transports and keeps the auth method', () => {
    const config = buildAiConnectConfigInput({
      provider: 'anthropic',
      model: 'claude-test',
      transportKind: 'acp',
      transportId: 'claude-code-acp',
      authMethodId: 'oauth'
    });
    const account = config.providers?.anthropic?.accounts?.[0] as unknown as Record<string, unknown>;
    expect(account.credentials).toBeUndefined();
    const transport = account.transport as Record<string, unknown>;
    expect(transport.kind).toBe('acp');
    expect(transport.id).toBe('claude-code-acp');
    expect((transport.auth as Record<string, unknown>).methodId).toBe('oauth');
  });

  test('falls back to the default api transport when the requested transport id is unknown', () => {
    // The 0.9.0 catalog has no gemini acp transport; an old gemini-acp profile
    // must degrade to the api route instead of producing a broken transport.
    expect(getAiConnectTransportKind({
      provider: 'gemini',
      model: 'gemini-test',
      transportKind: 'acp',
      transportId: 'gemini-acp'
    })).toBe('api');
  });

  test('falls back to cli config for non-catalog providers', () => {
    const config = buildAiConnectConfigInput({
      provider: 'my-agent',
      model: 'local-model',
      command: 'my-agent-cli'
    });
    const account = config.providers?.['my-agent']?.accounts?.[0] as unknown as Record<string, unknown>;
    expect(account).toBeDefined();
    const transport = account.transport as Record<string, unknown>;
    expect(transport.kind).toBe('cli');
    expect(transport.command).toBe('my-agent-cli');
    expect(account.modelAllowlistMode).toBe('shortlist');
  });

  test('route selector uses provider, account id, and model', () => {
    expect(buildAiConnectRouteSelector({
      id: 'acct',
      provider: 'openai',
      model: 'gpt-test'
    })).toBe('openai:acct:gpt-test');
  });
});

describe('single-element pool invariant (0.13.0 routeHints.pool breaking change)', () => {
  // The 0.12.0+ library dispatches an explicit routeHints.pool in exact pool order
  // (no baseSort re-sort). Our config builder emits a single account + a single
  // route selector per leg; failover chaining happens in ai-failover.ts, one
  // service.generate per leg. So each dispatched pool has exactly one element and
  // the ordering breaking-change is a no-op for us. This test pins that invariant.
  const profiles = {
    api: { provider: 'openai', model: 'gpt-test', transportKind: 'api' as const, secretValue: 'k', endpointUrl: 'http://127.0.0.1:8045/v1' },
    cli: { provider: 'anthropic', model: 'claude-test', transportKind: 'cli' as const, command: 'claude' },
    acp: { provider: 'anthropic', model: 'claude-test', transportKind: 'acp' as const, transportId: 'claude-code-acp', authMethodId: 'oauth' },
    nonCatalog: { provider: 'my-agent', model: 'local-model', command: 'my-agent-cli' }
  };

  for (const [name, profile] of Object.entries(profiles)) {
    test(`${name}: exactly one account and one text route selector`, () => {
      const config = buildAiConnectConfigInput(profile);
      const providerBlock = config.providers?.[profile.provider] as { accounts?: unknown[] } | undefined;
      expect(providerBlock?.accounts).toHaveLength(1);
      const textRoutes = config.routing?.operations?.text as string[] | undefined;
      expect(textRoutes).toHaveLength(1);
      expect(textRoutes?.[0]).toBe(buildAiConnectRouteSelector(profile));
    });
  }
});
