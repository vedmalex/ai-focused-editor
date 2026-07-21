import { describe, expect, test } from 'bun:test';
import { keysToSecretsFragment, storedToRegistry } from './ai-registry-conversion';
import { storedFromRegistry, type StoredAiAlias, type StoredAiEndpoint } from './ai-alias-resolution';

describe('storedToRegistry — secret containment (R2)', () => {
  test('never copies v1-compat secret/legacy fields into the registry', () => {
    const endpoints: StoredAiEndpoint[] = [
      {
        id: 'gw',
        provider: 'openai',
        transportKind: 'api',
        endpointUrl: 'http://g/v1',
        // v1-compat fields that MUST NOT reach the registry:
        apiKey: 'sk-INLINE-SECRET',
        token: 'tok-INLINE-SECRET',
        url: 'http://legacy/v1',
        endpoint: 'http://legacy2/v1',
        transport: 'proxy'
      } as StoredAiEndpoint
    ];
    const registry = storedToRegistry(endpoints, []);
    const serialized = JSON.stringify(registry);
    expect(serialized).not.toContain('sk-INLINE-SECRET');
    expect(serialized).not.toContain('tok-INLINE-SECRET');
    expect(serialized).not.toContain('auth.token');
    // No auth.token / fallbackTokens anywhere.
    expect(registry.endpoints[0].auth?.token).toBeUndefined();
    expect(registry.endpoints[0].auth?.fallbackTokens).toBeUndefined();
    // baseUrl comes from the whitelisted endpointUrl, not the legacy url/endpoint.
    expect(registry.endpoints[0].baseUrl).toBe('http://g/v1');
  });

  test('keysToSecretsFragment carries secrets only in the fragment and drops blanks', () => {
    const fragment = keysToSecretsFragment({ gw: 'sk-1', empty: '', blank: '   ', '': 'orphan' });
    expect(fragment.endpoints).toEqual([{ id: 'gw', auth: { token: 'sk-1' } }] as typeof fragment.endpoints);
  });
});

describe('storedToRegistry — server transport url/command asymmetry (F-D3.2-2)', () => {
  test('a server endpoint keeps both baseUrl and command', () => {
    // Unlike convertV1Registry (which maps a v1 `url` to baseUrl OR command by
    // transport), storedToRegistry sources baseUrl from endpointUrl and command
    // from command independently, so a server endpoint can carry both.
    const endpoints: StoredAiEndpoint[] = [
      { id: 'srv', provider: 'openai', transportKind: 'server', endpointUrl: 'http://s/v1', command: 'serve --port 9' }
    ];
    const registry = storedToRegistry(endpoints, []);
    expect(registry.endpoints[0]).toMatchObject({
      id: 'srv',
      transport: 'server',
      baseUrl: 'http://s/v1',
      command: 'serve --port 9'
    });
  });

  test('an acp endpoint drops the baseUrl (api/server-only slot)', () => {
    const registry = storedToRegistry(
      [{ id: 'a', provider: 'anthropic', transportKind: 'acp', endpointUrl: 'http://x/v1', command: 'claude' }],
      []
    );
    expect(registry.endpoints[0].baseUrl).toBeUndefined();
    expect(registry.endpoints[0].command).toBe('claude');
  });
});

describe('round-trip stored -> registry -> stored (R3)', () => {
  const pick = (e: StoredAiEndpoint) => ({
    id: e.id,
    label: e.label,
    provider: e.provider,
    transportKind: e.transportKind,
    endpointUrl: e.endpointUrl,
    command: e.command,
    env: e.env,
    allowedModels: e.allowedModels,
    timeWindows: e.timeWindows,
    enabled: e.enabled
  });

  test('preserves whitelisted fields and chain order', () => {
    const endpoints: StoredAiEndpoint[] = [
      {
        id: 'gw',
        label: 'Gateway',
        provider: 'anthropic',
        transportKind: 'api',
        endpointUrl: 'http://g/v1',
        allowedModels: ['claude-a', 'claude-b'],
        timeWindows: ['09:00-18:00'],
        enabled: false
      },
      {
        id: 'agent',
        provider: 'openai',
        transportKind: 'acp',
        command: 'claude',
        env: { HOME: '/tmp' }
      }
    ];
    const aliases: StoredAiAlias[] = [
      {
        id: 'main',
        label: 'Main',
        chain: [
          { endpointId: 'gw', model: 'claude-a' },
          { endpointId: 'agent', model: 'claude-b' }
        ]
      }
    ];

    const registry = storedToRegistry(endpoints, aliases, { activeAliasId: 'main' });
    expect(registry.defaults?.alias).toBe('main');

    const back = storedFromRegistry(registry);
    expect(back.defaultAliasId).toBe('main');
    expect(back.endpoints.map(pick)).toEqual(endpoints.map(pick));
    // Chain order + models are preserved exactly.
    expect(back.aliases[0].chain).toEqual(aliases[0].chain);
    expect(back.aliases[0]).toMatchObject({ id: 'main', label: 'Main' });
  });

  test('reverse contour on a v2 document with metadata.timeWindows and object models', () => {
    const back = storedFromRegistry({
      version: 2,
      defaults: { alias: 'x' },
      endpoints: [
        {
          id: 'gw',
          provider: 'openai',
          transport: 'api',
          baseUrl: 'http://g/v1',
          models: [{ id: 'm1', label: 'M1' }, 'm2'],
          defaultModel: 'm1',
          metadata: { timeWindows: ['00:00-06:00'] }
        }
      ],
      aliases: [{ id: 'x', chain: [{ endpointId: 'gw', model: 'm1' }] }]
    });
    expect(back.endpoints[0].allowedModels).toEqual(['m1', 'm2']);
    expect(back.endpoints[0].timeWindows).toEqual(['00:00-06:00']);

    // And it survives a second forward pass unchanged (models/timeWindows).
    const forward = storedToRegistry(back.endpoints, back.aliases, { activeAliasId: back.defaultAliasId });
    expect(forward.endpoints[0].models).toEqual(['m1', 'm2']);
    expect(forward.endpoints[0].metadata).toEqual({ timeWindows: ['00:00-06:00'] });
    expect(forward.defaults?.alias).toBe('x');
  });
});
