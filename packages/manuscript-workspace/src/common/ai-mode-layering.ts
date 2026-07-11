/**
 * Pure (Theia-free) three-layer merge for AI modes.
 *
 * Modes are contributed by three layers, lowest to highest precedence:
 *   1. `built-in` — bundled base modes shipped with the editor.
 *   2. `global`   — the user's `~/.ai-focused-editor/custom-modes.yaml`.
 *   3. `book`     — the book's `ai/prompts/custom-modes.yaml`.
 *
 * Merge is BY MODE ID: a mode of a given id in a higher layer replaces the WHOLE
 * lower-layer record (no field-level merge). `enabled: false` marks a mode hidden
 * from menus/agents/pickers but still surfaced (disabled) in the form editor.
 *
 * Kept here (no Theia imports) so it is unit-testable under `bun test` and reused
 * verbatim by the node registry service.
 */

import type { AiMode, AiModeOrigin, ResolvedAiMode } from './ai-mode-protocol';

/** One precedence layer: its origin and the modes parsed from that layer's file. */
export interface AiModeLayer {
  origin: AiModeOrigin;
  modes: AiMode[];
}

/** Numeric precedence rank; a higher rank wins on id collision. */
const ORIGIN_RANK: Record<AiModeOrigin, number> = {
  'built-in': 0,
  global: 1,
  book: 2
};

/** Whether a mode counts as enabled (the default) — only an explicit `false` hides it. */
export function isModeEnabled(mode: AiMode): boolean {
  return mode.enabled !== false;
}

/**
 * Merge the given layers by mode id. `layers` are provided lowest-precedence
 * first (built-in, global, book); a later layer's mode of the same id replaces
 * the whole earlier record while keeping the earlier record's slot/order.
 *
 * Each resulting mode is origin-tagged; when it shadows a lower layer its
 * `overrides` names that lower origin. Output order is first-seen id order
 * across the layers (base modes first, then global-only, then book-only), which
 * gives a stable list for the form editor.
 */
export function layerModes(layers: AiModeLayer[]): ResolvedAiMode[] {
  const order: string[] = [];
  const byId = new Map<string, ResolvedAiMode>();

  // Process strictly in ascending precedence so a higher layer always wins,
  // regardless of the caller's array order.
  const ordered = [...layers].sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin]);

  for (const layer of ordered) {
    for (const mode of layer.modes) {
      const existing = byId.get(mode.id);
      const resolved: ResolvedAiMode = {
        ...mode,
        origin: layer.origin,
        enabled: isModeEnabled(mode)
      };
      if (existing) {
        // Higher layer shadows the earlier record; keep its position but record
        // the (highest) lower origin it overrides.
        resolved.overrides = existing.overrides
          ? highestOrigin(existing.overrides, existing.origin)
          : existing.origin;
        byId.set(mode.id, resolved);
      } else {
        byId.set(mode.id, resolved);
        order.push(mode.id);
      }
    }
  }

  return order.map(id => byId.get(id)!);
}

/** Return the higher-precedence of two origins. */
function highestOrigin(a: AiModeOrigin, b: AiModeOrigin): AiModeOrigin {
  return ORIGIN_RANK[a] >= ORIGIN_RANK[b] ? a : b;
}

/**
 * The subset a consumer (menus/agents/fragments/pickers) should register:
 * enabled modes only, origin-tag preserved.
 */
export function enabledResolvedModes(resolved: ResolvedAiMode[]): ResolvedAiMode[] {
  return resolved.filter(isModeEnabled);
}
