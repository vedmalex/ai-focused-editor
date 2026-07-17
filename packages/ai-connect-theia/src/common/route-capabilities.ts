import type { PublicRouteCapabilities } from '@vedmalex/ai-connect';

/**
 * Book-agnostic capability descriptor for the route an alias/profile resolves
 * to. The nine boolean flags are the secret-free {@link PublicRouteCapabilities}
 * subset ai-connect exposes for untrusted callers (UI/agent discovery) — no
 * internal routing flags (localOnly, requiresFilesystem, rotation, …) leak
 * here. Consumers read these BEFORE sending a request to gate the UI
 * (e.g. hide the image-attach button when `supportsImageInput` is false).
 */
export interface AiRouteCapabilities {
  /** Route is safe to run from a browser (api transport, no local binary). */
  browserSafe: boolean;
  /** Route can stream token deltas. */
  supportsStreaming: boolean;
  /** Route accepts a tool/function JSON schema. */
  supportsToolSchema: boolean;
  /** Route runs the tool loop and calls tools itself (server-side). */
  supportsToolExecution: boolean;
  /** Route supports client-executed tools (functions the client runs in-process). */
  supportsClientToolExecution: boolean;
  /** Route accepts model INPUT file uploads (image/PDF/other). */
  supportsFileUpload: boolean;
  /** Route can produce file OUTPUT. */
  supportsFileOutput: boolean;
  /** Route accepts image INPUT (vision). */
  supportsImageInput: boolean;
  /** Route can produce image OUTPUT. */
  supportsImageOutput: boolean;
}

/** The nine capability flag keys, in a stable order (for merge/iteration). */
export const AI_ROUTE_CAPABILITY_KEYS: readonly (keyof AiRouteCapabilities)[] = [
  'browserSafe',
  'supportsStreaming',
  'supportsToolSchema',
  'supportsToolExecution',
  'supportsClientToolExecution',
  'supportsFileUpload',
  'supportsFileOutput',
  'supportsImageInput',
  'supportsImageOutput'
];

/**
 * Conservative fallback for local transports (acp/cli/server) whose route
 * cannot report capabilities: streaming is assumed, everything else off. Honest
 * about what a local transport reliably does over the JSON-RPC boundary.
 */
export const CONSERVATIVE_LOCAL_CAPABILITIES: AiRouteCapabilities = {
  browserSafe: false,
  supportsStreaming: true,
  supportsToolSchema: false,
  supportsToolExecution: false,
  supportsClientToolExecution: false,
  supportsFileUpload: false,
  supportsFileOutput: false,
  supportsImageInput: false,
  supportsImageOutput: false
};

/**
 * Map ai-connect's {@link PublicRouteCapabilities} to our book-agnostic
 * {@link AiRouteCapabilities}. EXPLICIT field construction (never a spread) so a
 * future ai-connect capability flag cannot silently appear in our shape.
 */
export function toAiRouteCapabilities(caps: PublicRouteCapabilities): AiRouteCapabilities {
  return {
    browserSafe: caps.browserSafe,
    supportsStreaming: caps.supportsStreaming,
    supportsToolSchema: caps.supportsToolSchema,
    supportsToolExecution: caps.supportsToolExecution,
    supportsClientToolExecution: caps.supportsClientToolExecution,
    supportsFileUpload: caps.supportsFileUpload,
    supportsFileOutput: caps.supportsFileOutput,
    supportsImageInput: caps.supportsImageInput,
    supportsImageOutput: caps.supportsImageOutput
  };
}

/**
 * Merge several capability sets with a boolean OR per flag: a capability is
 * advertised if ANY candidate route offers it. Returns undefined for an empty
 * list (nothing known). Used when the exact model is not among the listed
 * candidates and we fall back to the union of what the eligible routes can do.
 */
export function mergeRouteCapabilities(list: AiRouteCapabilities[]): AiRouteCapabilities | undefined {
  if (list.length === 0) {
    return undefined;
  }
  // Start from all-false so the result is a pure union across candidates.
  const merged = {} as AiRouteCapabilities;
  for (const key of AI_ROUTE_CAPABILITY_KEYS) {
    merged[key] = false;
  }
  for (const caps of list) {
    for (const key of AI_ROUTE_CAPABILITY_KEYS) {
      merged[key] = merged[key] || caps[key];
    }
  }
  return merged;
}

/** Minimal candidate shape (structurally an ai-connect CandidateModel). */
export interface RouteCapabilityCandidate {
  model: string;
  capabilities: PublicRouteCapabilities;
}

/**
 * Resolve the capabilities for a profile's `model` from a candidate list:
 *  1. exact model match → that candidate's capabilities;
 *  2. no exact match (or no model given) → OR-merge of every candidate's caps;
 *  3. empty candidate list → undefined (unknown).
 */
export function resolveCandidateCapabilities(
  candidates: readonly RouteCapabilityCandidate[],
  model: string | undefined
): AiRouteCapabilities | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const wanted = (model ?? '').trim();
  if (wanted) {
    const exact = candidates.find(candidate => candidate.model === wanted);
    if (exact) {
      return toAiRouteCapabilities(exact.capabilities);
    }
  }
  return mergeRouteCapabilities(candidates.map(candidate => toAiRouteCapabilities(candidate.capabilities)));
}
