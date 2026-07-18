import { describe, expect, test } from 'bun:test';
import type { HealthReport, RouteHealthReport } from '@vedmalex/ai-connect';
import {
  aggregateHealthLatency,
  deriveHealthStatus,
  summarizeHealthReport,
  toAiHealthReport,
  toAiRouteHealth
} from './ai-health';

function makeRoute(overrides: Partial<RouteHealthReport> = {}): RouteHealthReport {
  return {
    routeId: 'r1',
    provider: 'openai',
    handlerKey: 'openai::api',
    transportKind: 'api',
    transportId: 't1',
    modelId: 'gpt-4o',
    ok: true,
    endpoint: { ok: true, detail: 'reachable' },
    model: { ok: true, detail: 'ping ok', latencyMs: 120 },
    ...overrides
  } as RouteHealthReport;
}

describe('toAiRouteHealth', () => {
  test('flattens the two stages into readable flags', () => {
    const flat = toAiRouteHealth(makeRoute());
    expect(flat).toEqual({
      routeId: 'r1',
      provider: 'openai',
      transportKind: 'api',
      modelId: 'gpt-4o',
      ok: true,
      reachable: true,
      reachDetail: 'reachable',
      modelOk: true,
      modelDetail: 'ping ok',
      latencyMs: 120
    });
  });

  test('carries a failed reachability stage through', () => {
    const flat = toAiRouteHealth(makeRoute({
      ok: false,
      endpoint: { ok: false, detail: 'connection refused' },
      model: { ok: false, detail: 'skipped: endpoint unreachable' }
    }));
    expect(flat.reachable).toBe(false);
    expect(flat.reachDetail).toBe('connection refused');
    expect(flat.modelOk).toBe(false);
    expect(flat.latencyMs).toBeUndefined();
  });

  test('does not carry extra fields (e.g. handlerKey)', () => {
    expect(Object.keys(toAiRouteHealth(makeRoute())).sort()).toEqual([
      'latencyMs', 'modelDetail', 'modelId', 'modelOk', 'ok', 'provider', 'reachDetail', 'reachable', 'routeId', 'transportKind'
    ]);
  });
});

describe('toAiHealthReport', () => {
  test('maps ok flag and every route', () => {
    const report: HealthReport = { ok: false, routes: [makeRoute(), makeRoute({ routeId: 'r2', ok: false, model: { ok: false, detail: 'bad' } })] };
    const mapped = toAiHealthReport(report);
    expect(mapped.ok).toBe(false);
    expect(mapped.routes.map(r => r.routeId)).toEqual(['r1', 'r2']);
  });
});

describe('deriveHealthStatus', () => {
  test('unreachable when there are no routes', () => {
    expect(deriveHealthStatus({ ok: false, routes: [] })).toBe('unreachable');
  });

  test('unreachable when no route is reachable', () => {
    const report = toAiHealthReport({ ok: false, routes: [makeRoute({ ok: false, endpoint: { ok: false, detail: 'x' } })] } as HealthReport);
    expect(deriveHealthStatus(report)).toBe('unreachable');
  });

  test('ok when the report is ok and every route is healthy', () => {
    expect(deriveHealthStatus(toAiHealthReport({ ok: true, routes: [makeRoute()] }))).toBe('ok');
  });

  test('degraded when reachable but a model ping failed', () => {
    const report = toAiHealthReport({
      ok: false,
      routes: [makeRoute({ ok: false, endpoint: { ok: true, detail: 'reachable' }, model: { ok: false, detail: 'model missing' } })]
    });
    expect(deriveHealthStatus(report)).toBe('degraded');
  });

  test('degraded when only some routes are healthy', () => {
    const report = toAiHealthReport({
      ok: false,
      routes: [makeRoute(), makeRoute({ routeId: 'r2', ok: false, model: { ok: false, detail: 'bad' } })]
    });
    expect(deriveHealthStatus(report)).toBe('degraded');
  });
});

describe('aggregateHealthLatency', () => {
  test('returns the minimum measured latency', () => {
    const report = toAiHealthReport({
      ok: true,
      routes: [makeRoute({ model: { ok: true, detail: 'ok', latencyMs: 200 } }), makeRoute({ routeId: 'r2', model: { ok: true, detail: 'ok', latencyMs: 90 } })]
    });
    expect(aggregateHealthLatency(report)).toBe(90);
  });

  test('undefined when no route reports a latency', () => {
    const report = toAiHealthReport({ ok: false, routes: [makeRoute({ model: { ok: false, detail: 'no ping' } })] });
    expect(aggregateHealthLatency(report)).toBeUndefined();
  });
});

describe('summarizeHealthReport', () => {
  test('undefined on full success', () => {
    expect(summarizeHealthReport(toAiHealthReport({ ok: true, routes: [makeRoute()] }))).toBeUndefined();
  });

  test('reports reachability detail when unreachable', () => {
    const report = toAiHealthReport({ ok: false, routes: [makeRoute({ ok: false, endpoint: { ok: false, detail: 'connection refused' }, model: { ok: false, detail: 'skipped' } })] });
    expect(summarizeHealthReport(report)).toBe('connection refused');
  });

  test('reports model detail when reached but model failed', () => {
    const report = toAiHealthReport({ ok: false, routes: [makeRoute({ ok: false, endpoint: { ok: true, detail: 'reachable' }, model: { ok: false, detail: 'model 404' } })] });
    expect(summarizeHealthReport(report)).toBe('model 404');
  });

  test('reports "no route resolved" for an empty report', () => {
    expect(summarizeHealthReport({ ok: false, routes: [] })).toBe('no route resolved');
  });
});
