import { describe, expect, test } from 'bun:test';
import type { ConnectionRegistry } from '@vedmalex/ai-connect/registry';
import {
  parseV1Import,
  resolveChainFromConfig,
  resolveEndpointLeg,
  storedFromRegistry,
  type StoredAiAlias,
  type StoredAiEndpoint
} from './ai-alias-resolution';

const alwaysOn = new Date(2026, 0, 5, 12, 0); // Monday noon

describe('resolveEndpointLeg — v1 field parity', () => {
  test('maps a normalized endpoint with the user-scope secret', () => {
    const endpoint: StoredAiEndpoint = {
      id: 'gateway',
      label: 'Local gateway',
      provider: 'anthropic',
      transportKind: 'api',
      endpointUrl: 'http://127.0.0.1:8045/v1',
      command: 'anthropic',
      env: { FOO: 'bar' }
    };
    const profile = resolveEndpointLeg(endpoint, 'claude-sonnet-4-6', 'sk-user');
    expect(profile).toMatchObject({
      id: 'gateway',
      provider: 'anthropic',
      transportKind: 'api',
      endpointUrl: 'http://127.0.0.1:8045/v1',
      model: 'claude-sonnet-4-6',
      command: 'anthropic',
      env: { FOO: 'bar' },
      secretValue: 'sk-user'
    });
  });

  test('applies v1 fallbacks: transport, url/endpoint, apiKey/token, provider default', () => {
    // Raw v1 endpoint shape (no normalized fields): provider missing -> openai,
    // transport -> transportKind, endpoint -> endpointUrl, token -> secretValue.
    const v1Endpoint = {
      id: 'legacy',
      transport: 'api',
      endpoint: 'http://legacy.example/v1',
      token: 'tok-123'
    } as unknown as StoredAiEndpoint;
    const profile = resolveEndpointLeg(v1Endpoint, 'gpt-oss-120b-medium');
    expect(profile.provider).toBe('openai');
    expect(profile.transportKind).toBe('api');
    expect(profile.endpointUrl).toBe('http://legacy.example/v1');
    expect(profile.secretValue).toBe('tok-123');
    expect(profile.model).toBe('gpt-oss-120b-medium');
  });

  test('user-scope key wins over an inline v1 apiKey', () => {
    const endpoint = { id: 'e', provider: 'openai', apiKey: 'inline' } as unknown as StoredAiEndpoint;
    expect(resolveEndpointLeg(endpoint, 'm', 'from-map').secretValue).toBe('from-map');
  });
});

describe('resolveChainFromConfig', () => {
  const endpoints: StoredAiEndpoint[] = [
    { id: 'primary', provider: 'anthropic', endpointUrl: 'http://p/v1' },
    { id: 'backup', provider: 'openai', endpointUrl: 'http://b/v1' }
  ];
  const aliases: StoredAiAlias[] = [
    {
      id: 'fable',
      chain: [
        { endpointId: 'primary', model: 'claude-sonnet-4-6' },
        { endpointId: 'backup', model: 'gpt-oss-120b-medium' }
      ]
    }
  ];
  const keys = { primary: 'sk-p', backup: 'sk-b' };

  test('resolves both legs in order', () => {
    const result = resolveChainFromConfig(endpoints, aliases, 'fable', keys, alwaysOn);
    expect(result.aliasFound).toBe(true);
    expect(result.chain.map(p => p.id)).toEqual(['primary', 'backup']);
    expect(result.chain[0].secretValue).toBe('sk-p');
    expect(result.chain[0].model).toBe('claude-sonnet-4-6');
    expect(result.skipped).toHaveLength(0);
  });

  test('falls back to the first alias when activeAliasId is unknown', () => {
    const result = resolveChainFromConfig(endpoints, aliases, 'does-not-exist', keys, alwaysOn);
    expect(result.aliasId).toBe('fable');
    expect(result.chain).toHaveLength(2);
  });

  test('skips a disabled endpoint', () => {
    const withDisabled: StoredAiEndpoint[] = [
      { ...endpoints[0], enabled: false },
      endpoints[1]
    ];
    const result = resolveChainFromConfig(withDisabled, aliases, 'fable', keys, alwaysOn);
    expect(result.chain.map(p => p.id)).toEqual(['backup']);
    expect(result.skipped).toEqual([{ endpointId: 'primary', model: 'claude-sonnet-4-6', reason: 'disabled' }]);
  });

  test('skips an endpoint outside its time window', () => {
    const windowed: StoredAiEndpoint[] = [
      { ...endpoints[0], timeWindows: ['22:00-23:00'] }, // noon is outside
      endpoints[1]
    ];
    const result = resolveChainFromConfig(windowed, aliases, 'fable', keys, alwaysOn);
    expect(result.chain.map(p => p.id)).toEqual(['backup']);
    expect(result.skipped[0]).toMatchObject({ endpointId: 'primary', reason: 'outside-time-window' });
  });

  test('skips a leg whose endpoint is missing', () => {
    const brokenAlias: StoredAiAlias[] = [
      { id: 'fable', chain: [{ endpointId: 'ghost', model: 'm' }, { endpointId: 'backup', model: 'm2' }] }
    ];
    const result = resolveChainFromConfig(endpoints, brokenAlias, 'fable', keys, alwaysOn);
    expect(result.chain.map(p => p.id)).toEqual(['backup']);
    expect(result.skipped).toEqual([{ endpointId: 'ghost', model: 'm', reason: 'missing-endpoint' }]);
  });

  test('pinned endpoint is reordered to the front', () => {
    const result = resolveChainFromConfig(endpoints, aliases, 'fable', keys, alwaysOn, 'backup');
    expect(result.chain.map(p => p.id)).toEqual(['backup', 'primary']);
  });

  test('pin that is absent from the chain leaves order unchanged', () => {
    const result = resolveChainFromConfig(endpoints, aliases, 'fable', keys, alwaysOn, 'ghost');
    expect(result.chain.map(p => p.id)).toEqual(['primary', 'backup']);
  });

  test('empty chain resolves to an empty list', () => {
    const emptyAlias: StoredAiAlias[] = [{ id: 'empty', chain: [] }];
    const result = resolveChainFromConfig(endpoints, emptyAlias, 'empty', keys, alwaysOn);
    expect(result.chain).toEqual([]);
    // The alias record exists (so status can still name it), it just has no legs.
    expect(result.aliasId).toBe('empty');
    expect(result.aliasFound).toBe(true);
  });

  test('no aliases at all resolves to an empty list', () => {
    const result = resolveChainFromConfig(endpoints, [], undefined, keys, alwaysOn);
    expect(result.chain).toEqual([]);
    expect(result.aliasFound).toBe(false);
  });
});

describe('parseV1Import', () => {
  test('maps rag-endpoints.json + rag-aliases.json with v1 fallbacks', () => {
    const endpointsFile = {
      endpoints: [
        { id: 'gateway', provider: 'openai', transport: 'api', url: 'http://g/v1', apiKey: 'sk-1' },
        { id: 'legacy', endpoint: 'http://l/v1', token: 'tok-2' }
      ]
    };
    const aliasesFile = {
      aliases: [
        { alias: 'fable', description: 'Claude via gateway', chain: [{ endpointId: 'gateway', model: 'gpt-oss-120b-medium' }] }
      ]
    };
    const result = parseV1Import(endpointsFile, aliasesFile);

    expect(result.endpoints).toHaveLength(2);
    expect(result.endpoints[0]).toMatchObject({ id: 'gateway', provider: 'openai', transportKind: 'api', endpointUrl: 'http://g/v1' });
    // provider defaults to openai; endpoint -> endpointUrl
    expect(result.endpoints[1]).toMatchObject({ id: 'legacy', provider: 'openai', endpointUrl: 'http://l/v1' });
    // secrets extracted to the keys map, not left on the endpoint
    expect(result.keys).toEqual({ gateway: 'sk-1', legacy: 'tok-2' });

    expect(result.aliases).toHaveLength(1);
    expect(result.aliases[0]).toMatchObject({ id: 'fable', label: 'Claude via gateway' });
    expect(result.aliases[0].chain).toEqual([{ endpointId: 'gateway', model: 'gpt-oss-120b-medium' }]);
  });

  test('tolerates missing files', () => {
    const result = parseV1Import(undefined, undefined);
    expect(result.endpoints).toEqual([]);
    expect(result.aliases).toEqual([]);
    expect(result.keys).toEqual({});
  });

  test('an imported v1 endpoint resolves through resolveChainFromConfig with parity', () => {
    const { endpoints, aliases, keys } = parseV1Import(
      { endpoints: [{ id: 'gateway', provider: 'anthropic', transport: 'api', url: 'http://g/v1', apiKey: 'sk-1' }] },
      { aliases: [{ alias: 'fable', chain: [{ endpointId: 'gateway', model: 'claude-sonnet-4-6' }] }] }
    );
    const resolved = resolveChainFromConfig(endpoints, aliases, 'fable', keys, alwaysOn);
    expect(resolved.chain[0]).toMatchObject({
      provider: 'anthropic',
      transportKind: 'api',
      endpointUrl: 'http://g/v1',
      model: 'claude-sonnet-4-6',
      secretValue: 'sk-1'
    });
  });

  test('a deleted:true v1 endpoint is a tombstone and is dropped', () => {
    // convertV1Registry skips deleted entries; the overlay does not resurrect them.
    const result = parseV1Import(
      {
        endpoints: [
          { id: 'keep', provider: 'openai', url: 'http://k/v1' },
          { id: 'gone', provider: 'openai', url: 'http://x/v1', deleted: true }
        ]
      },
      undefined
    );
    expect(result.endpoints.map(e => e.id)).toEqual(['keep']);
  });

  test('the overlay carries ai-editor v1 fields the library ignores: timeWindows, env, enabled:false', () => {
    const result = parseV1Import(
      {
        endpoints: [
          {
            id: 'gw',
            provider: 'openai',
            transportKind: 'acp',
            command: 'claude',
            url: 'http://g/v1',
            env: { TOKEN: 'x' },
            timeWindows: ['22:00-23:00', '  '],
            enabled: false
          }
        ]
      },
      undefined
    );
    expect(result.endpoints[0]).toMatchObject({
      id: 'gw',
      transportKind: 'acp',
      command: 'claude',
      env: { TOKEN: 'x' },
      timeWindows: ['22:00-23:00'],
      enabled: false
    });
  });

  test('an alias leg with no model falls back to the endpoint defaultModel then empty string', () => {
    const result = parseV1Import(
      { endpoints: [{ id: 'gw', provider: 'openai', url: 'http://g/v1' }] },
      {
        aliases: [
          { alias: 'a', chain: [{ endpointId: 'gw' }, { endpointId: 'gw', model: 'm2' }] }
        ]
      }
    );
    // v1 has no defaultModel, so the model-less leg resolves to ''.
    expect(result.aliases[0].chain).toEqual([
      { endpointId: 'gw', model: '' },
      { endpointId: 'gw', model: 'm2' }
    ]);
  });
});

describe('storedFromRegistry', () => {
  test('maps a v2 registry: baseUrl, transport, models, metadata.timeWindows, auth.token -> keys', () => {
    const registry: ConnectionRegistry = {
      version: 2,
      defaults: { alias: 'main' },
      endpoints: [
        {
          id: 'gw',
          provider: 'anthropic',
          transport: 'api',
          baseUrl: 'http://g/v1',
          label: 'Gateway',
          models: ['a', { id: 'b' }],
          defaultModel: 'b',
          auth: { token: 'sk-secret', methodId: 'oauth' },
          enabled: false,
          metadata: { timeWindows: ['09:00-18:00'] }
        }
      ],
      aliases: [
        { id: 'main', description: 'Main', chain: [{ endpointId: 'gw', model: 'a' }] }
      ]
    };
    const result = storedFromRegistry(registry);
    expect(result.defaultAliasId).toBe('main');
    expect(result.endpoints[0]).toMatchObject({
      id: 'gw',
      provider: 'anthropic',
      transportKind: 'api',
      endpointUrl: 'http://g/v1',
      label: 'Gateway',
      authMethodId: 'oauth',
      allowedModels: ['b', 'a'], // defaultModel ordered first
      timeWindows: ['09:00-18:00'],
      enabled: false
    });
    // Secret lands in keys, never on the endpoint record.
    expect(result.keys).toEqual({ gw: 'sk-secret' });
    expect((result.endpoints[0] as Record<string, unknown>).token).toBeUndefined();
    // description flows into label; chain model preserved.
    expect(result.aliases[0]).toMatchObject({ id: 'main', label: 'Main' });
    expect(result.aliases[0].chain).toEqual([{ endpointId: 'gw', model: 'a' }]);
  });

  test('a model-less alias leg falls back to the endpoint defaultModel', () => {
    const registry: ConnectionRegistry = {
      version: 2,
      endpoints: [{ id: 'gw', provider: 'openai', transport: 'api', defaultModel: 'default-m' }],
      aliases: [{ id: 'a', chain: [{ endpointId: 'gw' }] }]
    };
    const result = storedFromRegistry(registry);
    expect(result.aliases[0].chain).toEqual([{ endpointId: 'gw', model: 'default-m' }]);
  });
});
