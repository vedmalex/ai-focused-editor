import { describe, expect, test } from 'bun:test';
import {
  assembleAliasCheckVerdict,
  assembleAliasLegVerdict,
  assembleEndpointCheckVerdict,
  classifyChainLegSkip
} from './ai-verification';
import type { StoredAiEndpoint } from './ai-alias-resolution';

describe('assembleEndpointCheckVerdict', () => {
  test('reports reachable with a deduped, trimmed model list', () => {
    const verdict = assembleEndpointCheckVerdict({
      ok: true,
      models: ['gpt-4o', ' gpt-4o ', 'gpt-4o-mini', '']
    });
    expect(verdict.reachable).toBe(true);
    expect(verdict.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(verdict.modelCount).toBe(2);
    expect(verdict.detail).toBeUndefined();
  });

  test('unreachable with no models keeps the failure detail', () => {
    const verdict = assembleEndpointCheckVerdict({ ok: false, models: [], detail: '  401 Unauthorized ' });
    expect(verdict.reachable).toBe(false);
    expect(verdict.modelCount).toBe(0);
    expect(verdict.detail).toBe('401 Unauthorized');
  });

  test('treats a present model list as reachable even when ok is false', () => {
    const verdict = assembleEndpointCheckVerdict({ ok: false, models: ['m1'] });
    expect(verdict.reachable).toBe(true);
    expect(verdict.modelCount).toBe(1);
  });
});

describe('classifyChainLegSkip', () => {
  const endpoint = (overrides: Partial<StoredAiEndpoint>): StoredAiEndpoint => ({
    id: 'e1',
    provider: 'openai',
    ...overrides
  });

  test('missing endpoint', () => {
    expect(classifyChainLegSkip(undefined)).toBe('missing-endpoint');
  });

  test('disabled endpoint', () => {
    expect(classifyChainLegSkip(endpoint({ enabled: false }))).toBe('disabled');
  });

  test('outside its availability window', () => {
    // Monday 09:00–10:00 only; probe at Monday 12:00.
    const monNoon = new Date('2026-07-06T12:00:00');
    expect(classifyChainLegSkip(endpoint({ timeWindows: ['1 09:00-10:00'] }), monNoon)).toBe('outside-time-window');
  });

  test('usable endpoint returns undefined', () => {
    expect(classifyChainLegSkip(endpoint({}))).toBeUndefined();
  });
});

describe('assembleAliasLegVerdict', () => {
  test('a skipped leg carries the reason and skipped generation', () => {
    const verdict = assembleAliasLegVerdict({
      index: 0,
      endpointId: 'e1',
      model: 'm1',
      skip: 'outside-time-window'
    });
    expect(verdict.skipped).toBe('outside-time-window');
    expect(verdict.generation).toBe('skipped');
    expect(verdict.connection).toBeUndefined();
  });

  test('full pass: connection ok, model present, generation ok', () => {
    const verdict = assembleAliasLegVerdict({
      index: 1,
      endpointId: 'e1',
      model: 'gpt-4o',
      discovery: { ok: true, models: ['gpt-4o', 'gpt-4o-mini'] },
      generation: { ok: true, text: ' OK ' }
    });
    expect(verdict.connection).toBe('ok');
    expect(verdict.modelState).toBe('present');
    expect(verdict.discoveredModelCount).toBe(2);
    expect(verdict.generation).toBe('ok');
    expect(verdict.generationText).toBe('OK');
  });

  test('model absent when discovery succeeds but list lacks the leg model', () => {
    const verdict = assembleAliasLegVerdict({
      index: 0,
      endpointId: 'e1',
      model: 'ghost-model',
      discovery: { ok: true, models: ['gpt-4o'] },
      generation: { ok: true, text: 'OK' }
    });
    expect(verdict.modelState).toBe('absent');
  });

  test('model unknown when discovery unavailable but generation still works', () => {
    const verdict = assembleAliasLegVerdict({
      index: 0,
      endpointId: 'e1',
      model: 'gpt-4o',
      discovery: { ok: false, models: [], detail: 'no /models endpoint' },
      generation: { ok: true, text: 'OK' }
    });
    // Generation reached the endpoint, so connection is ok despite discovery failing.
    expect(verdict.connection).toBe('ok');
    expect(verdict.modelState).toBe('unknown');
    expect(verdict.connectionDetail).toBeUndefined();
    expect(verdict.generation).toBe('ok');
  });

  test('connection fail keeps discovery detail and generation error', () => {
    const verdict = assembleAliasLegVerdict({
      index: 0,
      endpointId: 'e1',
      model: 'gpt-4o',
      discovery: { ok: false, models: [], detail: 'ECONNREFUSED' },
      generation: { ok: false, error: 'connect failed' }
    });
    expect(verdict.connection).toBe('fail');
    expect(verdict.connectionDetail).toBe('ECONNREFUSED');
    expect(verdict.modelState).toBe('unknown');
    expect(verdict.generation).toBe('fail');
    expect(verdict.generationError).toBe('connect failed');
  });
});

describe('assembleAliasCheckVerdict', () => {
  test('empty chain', () => {
    expect(assembleAliasCheckVerdict('a', 'A', []).overall).toBe('empty');
  });

  test('unavailable when every leg is skipped', () => {
    const legs = [
      assembleAliasLegVerdict({ index: 0, endpointId: 'e1', model: 'm1', skip: 'disabled' }),
      assembleAliasLegVerdict({ index: 1, endpointId: 'e2', model: 'm2', skip: 'outside-time-window' })
    ];
    expect(assembleAliasCheckVerdict('a', 'A', legs).overall).toBe('unavailable');
  });

  test('ok when any non-skipped leg generated', () => {
    const legs = [
      assembleAliasLegVerdict({ index: 0, endpointId: 'e1', model: 'm1', discovery: { ok: false, models: [] }, generation: { ok: false, error: 'x' } }),
      assembleAliasLegVerdict({ index: 1, endpointId: 'e2', model: 'm2', discovery: { ok: true, models: ['m2'] }, generation: { ok: true, text: 'OK' } })
    ];
    expect(assembleAliasCheckVerdict('a', 'A', legs).overall).toBe('ok');
  });

  test('failed when usable legs exist but none generated', () => {
    const legs = [
      assembleAliasLegVerdict({ index: 0, endpointId: 'e1', model: 'm1', discovery: { ok: false, models: [] }, generation: { ok: false, error: 'x' } }),
      assembleAliasLegVerdict({ index: 1, endpointId: 'e2', model: 'm2', skip: 'disabled' })
    ];
    expect(assembleAliasCheckVerdict('a', 'A', legs).overall).toBe('failed');
  });
});
