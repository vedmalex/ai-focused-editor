import type { HealthReport, RouteHealthReport } from '@vedmalex/ai-connect';

/**
 * Book-agnostic, flattened health report for the route(s) a profile resolves to.
 * ai-connect's live `checkHealth` runs a two-stage probe per route (Stage-1
 * endpoint reachability, Stage-2 minimal chat ping); this shape flattens those
 * two {@link RouteHealthReport} stages into readable flags/details so the UI can
 * render them without knowing ai-connect's stage vocabulary.
 */
export interface AiHealthReport {
  /** Every route is healthy (reachable AND its model ping succeeded). */
  ok: boolean;
  routes: AiRouteHealth[];
}

/** Flattened per-route health verdict (the two ai-connect stages merged). */
export interface AiRouteHealth {
  routeId: string;
  provider: string;
  transportKind: string;
  modelId: string;
  /** Route is fully healthy (reachable AND model ping ok). */
  ok: boolean;
  /** Stage-1: the endpoint was reachable. */
  reachable: boolean;
  /** Stage-1 human-readable detail. */
  reachDetail: string;
  /** Stage-2: the minimal model chat ping succeeded. */
  modelOk: boolean;
  /** Stage-2 human-readable detail. */
  modelDetail: string;
  /** Stage-2 measured ping round-trip, when captured. */
  latencyMs?: number;
}

/** Overall connection health, one step coarser than the per-route verdicts. */
export type AiHealthStatus = 'ok' | 'degraded' | 'unreachable';

/**
 * A single configured connection's (alias's) live health, as surfaced by the
 * browser {@link AiHealthService}. Book-agnostic: an id/label plus a derived
 * status, the best measured latency, and a short detail line.
 */
export interface AiEndpointHealth {
  id: string;
  label: string;
  status: AiHealthStatus;
  latencyMs?: number;
  detail?: string;
}

/**
 * Map one ai-connect {@link RouteHealthReport} to our flattened
 * {@link AiRouteHealth}. EXPLICIT field construction (never a spread) so a
 * future ai-connect field cannot silently leak into our shape.
 */
export function toAiRouteHealth(route: RouteHealthReport): AiRouteHealth {
  return {
    routeId: route.routeId,
    provider: route.provider,
    transportKind: route.transportKind,
    modelId: route.modelId,
    ok: route.ok,
    reachable: route.endpoint.ok,
    reachDetail: route.endpoint.detail,
    modelOk: route.model.ok,
    modelDetail: route.model.detail,
    latencyMs: route.model.latencyMs
  };
}

/** Map a whole ai-connect {@link HealthReport} to our {@link AiHealthReport}. */
export function toAiHealthReport(report: HealthReport): AiHealthReport {
  return {
    ok: report.ok,
    routes: report.routes.map(toAiRouteHealth)
  };
}

/**
 * Derive a coarse {@link AiHealthStatus} from a flattened report:
 *  - `unreachable` — no routes, or NOT ONE route was reachable;
 *  - `ok` — the report is ok and every route is fully healthy;
 *  - `degraded` — at least one route is reachable but the report is not fully ok
 *    (a model ping failed, or only some routes are healthy).
 */
export function deriveHealthStatus(report: AiHealthReport): AiHealthStatus {
  if (report.routes.length === 0) {
    return 'unreachable';
  }
  if (!report.routes.some(route => route.reachable)) {
    return 'unreachable';
  }
  if (report.ok && report.routes.every(route => route.ok)) {
    return 'ok';
  }
  return 'degraded';
}

/**
 * Representative latency for a report: the lowest measured `latencyMs` across
 * routes that reported one (the fastest healthy leg). Undefined when no route
 * captured a latency (e.g. a reachability-only check, or every leg unreachable).
 */
export function aggregateHealthLatency(report: AiHealthReport): number | undefined {
  const latencies = report.routes
    .map(route => route.latencyMs)
    .filter((latency): latency is number => typeof latency === 'number');
  return latencies.length > 0 ? Math.min(...latencies) : undefined;
}

/**
 * A short human-readable detail line for a report. On success returns undefined
 * (the status badge already says "ok"); otherwise the detail of the first route
 * that failed — its model-stage detail when reached-but-model-failed, else its
 * reachability detail.
 */
export function summarizeHealthReport(report: AiHealthReport): string | undefined {
  if (report.routes.length === 0) {
    return 'no route resolved';
  }
  if (report.ok && report.routes.every(route => route.ok)) {
    return undefined;
  }
  const failing = report.routes.find(route => !route.ok);
  if (!failing) {
    return undefined;
  }
  if (!failing.reachable) {
    return failing.reachDetail || 'endpoint unreachable';
  }
  return failing.modelDetail || failing.reachDetail || 'model ping failed';
}
