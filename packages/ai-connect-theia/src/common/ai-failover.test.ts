import { describe, expect, test } from 'bun:test';
import type {
  AiConnectionProfile,
  AiConnectionService,
  AiGenerateRequest,
  AiGenerateResult
} from './ai-connection-protocol';
import { AiFailoverLegEvent, generateWithFailover } from './ai-failover';

function createService(behaviour: (profile: AiConnectionProfile) => AiGenerateResult | Error): AiConnectionService {
  return {
    getTransportKind: () => 'api',
    discoverModels: async () => ({ ok: true, models: [] }),
    streamText: async function* () { /* not used in these tests */ },
    generate: async (profile: AiConnectionProfile, _request: AiGenerateRequest) => {
      const result = behaviour(profile);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }
  };
}

const REQUEST: AiGenerateRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('generateWithFailover', () => {
  test('returns the first successful profile result', async () => {
    const service = createService(profile => ({
      text: `answer from ${profile.id}`,
      warnings: [],
      attempts: []
    }));
    const result = await generateWithFailover(service, [
      { id: 'a', provider: 'openai' },
      { id: 'b', provider: 'anthropic' }
    ], REQUEST);
    expect(result.text).toBe('answer from a');
    expect(result.profileUsed.id).toBe('a');
    expect(result.failedAttempts).toEqual([]);
  });

  test('falls over to the next profile when one fails', async () => {
    const service = createService(profile => profile.id === 'a'
      ? new Error('rate limited')
      : { text: 'fallback answer', warnings: [], attempts: [] });
    const result = await generateWithFailover(service, [
      { id: 'a', provider: 'openai' },
      { id: 'b', provider: 'anthropic' }
    ], REQUEST);
    expect(result.text).toBe('fallback answer');
    expect(result.profileUsed.id).toBe('b');
    expect(result.failedAttempts).toEqual([{ profileId: 'a', error: 'rate limited' }]);
  });

  test('throws an aggregate error when every profile fails', async () => {
    const service = createService(profile => new Error(`down: ${profile.id}`));
    await expect(generateWithFailover(service, [
      { id: 'a', provider: 'openai' },
      { id: 'b', provider: 'anthropic' }
    ], REQUEST)).rejects.toThrow('All 2 AI profile(s) failed: a: down: a; b: down: b');
  });

  test('throws immediately for an empty chain', async () => {
    const service = createService(() => new Error('unreachable'));
    await expect(generateWithFailover(service, [], REQUEST)).rejects.toThrow('No configured AI profiles');
  });

  test('reports one recorder event per attempted leg with outcomes', async () => {
    const service = createService(profile => profile.id === 'a'
      ? new Error('rate limited')
      : { text: 'ok', warnings: [], attempts: [] });
    const events: AiFailoverLegEvent[] = [];
    await generateWithFailover(service, [
      { id: 'a', provider: 'openai' },
      { id: 'b', provider: 'anthropic' }
    ], REQUEST, event => events.push(event));

    expect(events.map(event => event.outcome)).toEqual(['error', 'ok']);
    expect(events.map(event => event.index)).toEqual([0, 1]);
    expect(events[0].error).toBe('rate limited');
    expect(events[1].result?.text).toBe('ok');
    expect(events.every(event => typeof event.durationMs === 'number')).toBe(true);
  });

  test('a recorder that reports each leg still sees all failures on total failure', async () => {
    const service = createService(profile => new Error(`down: ${profile.id}`));
    const events: AiFailoverLegEvent[] = [];
    await expect(generateWithFailover(service, [
      { id: 'a', provider: 'openai' },
      { id: 'b', provider: 'anthropic' }
    ], REQUEST, event => events.push(event))).rejects.toThrow('All 2 AI profile(s) failed');
    expect(events.map(event => event.outcome)).toEqual(['error', 'error']);
  });
});
