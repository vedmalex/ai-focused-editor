import type { ChainSkipReason, StoredAiEndpoint } from './ai-alias-resolution';
import { isWithinWindows } from './ai-time-windows';

/**
 * Pure verdict-assembly helpers for the two-stage AI-connection verification.
 *
 * Stage 1 (per endpoint): "connection" — reach the endpoint and fetch its model
 * list. Stage 2 (per alias): for each chain leg in order, report connection,
 * whether the leg model is present in the discovered list, and a minimal test
 * generation through THAT specific leg. All functions here are side-effect free
 * (no RPC, no DOM) so the widget/contribution runs the probes and hands the raw
 * outcomes to these assemblers, which are unit-tested directly.
 */

/** Raw model-discovery outcome for one endpoint (already flattened to model ids). */
export interface EndpointDiscoveryOutcome {
  ok: boolean;
  models: string[];
  detail?: string;
}

/** Raw single-leg generation outcome. */
export interface LegGenerationOutcome {
  ok: boolean;
  text?: string;
  error?: string;
}

/** Stage-1 verdict for a single endpoint: reachability + discovered model list. */
export interface EndpointCheckVerdict {
  reachable: boolean;
  modelCount: number;
  models: string[];
  detail?: string;
}

export type AliasLegConnectionState = 'ok' | 'fail';
export type AliasLegModelState = 'present' | 'absent' | 'unknown';
export type AliasLegGenerationState = 'ok' | 'fail' | 'skipped';
export type AliasCheckOverall = 'ok' | 'failed' | 'unavailable' | 'empty';

/** Stage-2 verdict row for one alias chain leg. */
export interface AliasLegVerdict {
  index: number;
  endpointId: string;
  model: string;
  /** Set when the leg was skipped before any network probe (missing/disabled/off-window). */
  skipped?: ChainSkipReason;
  connection?: AliasLegConnectionState;
  connectionDetail?: string;
  modelState?: AliasLegModelState;
  /** Number of models discovered for this leg's endpoint (only when discovery succeeded). */
  discoveredModelCount?: number;
  generation?: AliasLegGenerationState;
  generationText?: string;
  generationError?: string;
}

/** Overall stage-2 verdict for an alias plus its per-leg rows. */
export interface AliasCheckVerdict {
  aliasId: string;
  aliasLabel: string;
  overall: AliasCheckOverall;
  legs: AliasLegVerdict[];
}

/** Raw per-leg probe inputs the pure assembler turns into an {@link AliasLegVerdict}. */
export interface AliasLegProbe {
  index: number;
  endpointId: string;
  model: string;
  /** When set, the leg is skipped and no discovery/generation is attempted. */
  skip?: ChainSkipReason;
  discovery?: EndpointDiscoveryOutcome;
  generation?: LegGenerationOutcome;
}

function dedupeModels(models: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const model of models ?? []) {
    const trimmed = typeof model === 'string' ? model.trim() : '';
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function cleanDetail(detail: string | undefined): string | undefined {
  const trimmed = typeof detail === 'string' ? detail.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Classify why a chain leg's endpoint is unusable right now, mirroring the skip
 * rules of `resolveChainFromConfig` (missing endpoint, disabled, or outside its
 * availability window). Returns `undefined` when the endpoint is usable now.
 */
export function classifyChainLegSkip(
  endpoint: StoredAiEndpoint | undefined,
  now: Date = new Date()
): ChainSkipReason | undefined {
  if (!endpoint) {
    return 'missing-endpoint';
  }
  if (endpoint.enabled === false) {
    return 'disabled';
  }
  if (!isWithinWindows(endpoint.timeWindows, now)) {
    return 'outside-time-window';
  }
  return undefined;
}

/** Assemble the stage-1 endpoint verdict from a model-discovery outcome. */
export function assembleEndpointCheckVerdict(discovery: EndpointDiscoveryOutcome): EndpointCheckVerdict {
  const models = dedupeModels(discovery.models);
  return {
    reachable: Boolean(discovery.ok) || models.length > 0,
    modelCount: models.length,
    models,
    detail: cleanDetail(discovery.detail)
  };
}

/** Assemble the stage-2 verdict row for one alias chain leg from its raw probes. */
export function assembleAliasLegVerdict(probe: AliasLegProbe): AliasLegVerdict {
  if (probe.skip) {
    return {
      index: probe.index,
      endpointId: probe.endpointId,
      model: probe.model,
      skipped: probe.skip,
      generation: 'skipped'
    };
  }

  const discoveryOk = Boolean(probe.discovery?.ok);
  const generationOk = Boolean(probe.generation?.ok);
  const models = probe.discovery ? dedupeModels(probe.discovery.models) : [];

  // Either a successful model list or a successful generation proves the leg's
  // endpoint was actually reached.
  const connection: AliasLegConnectionState = discoveryOk || generationOk ? 'ok' : 'fail';

  const modelState: AliasLegModelState = discoveryOk
    ? (models.includes(probe.model.trim()) ? 'present' : 'absent')
    : 'unknown';

  const verdict: AliasLegVerdict = {
    index: probe.index,
    endpointId: probe.endpointId,
    model: probe.model,
    connection,
    modelState,
    discoveredModelCount: discoveryOk ? models.length : undefined,
    generation: probe.generation ? (generationOk ? 'ok' : 'fail') : undefined
  };

  if (connection === 'fail') {
    verdict.connectionDetail = cleanDetail(probe.discovery?.detail);
  }
  if (probe.generation) {
    if (generationOk) {
      verdict.generationText = cleanDetail(probe.generation.text);
    } else {
      verdict.generationError = cleanDetail(probe.generation.error);
    }
  }
  return verdict;
}

/**
 * Assemble the overall alias verdict from its per-leg rows. As a failover chain,
 * an alias is `ok` when ANY non-skipped leg generated; `failed` when it has
 * usable legs but none generated; `unavailable` when every leg was skipped; and
 * `empty` when the chain has no legs.
 */
export function assembleAliasCheckVerdict(
  aliasId: string,
  aliasLabel: string,
  legs: AliasLegVerdict[]
): AliasCheckVerdict {
  let overall: AliasCheckOverall;
  if (legs.length === 0) {
    overall = 'empty';
  } else {
    const active = legs.filter(leg => !leg.skipped);
    if (active.length === 0) {
      overall = 'unavailable';
    } else if (active.some(leg => leg.generation === 'ok')) {
      overall = 'ok';
    } else {
      overall = 'failed';
    }
  }
  return { aliasId, aliasLabel, overall, legs };
}
