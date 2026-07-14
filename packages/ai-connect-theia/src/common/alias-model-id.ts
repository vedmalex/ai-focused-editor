/**
 * Stable, collision-free mapping between an ai-connect ALIAS id and the
 * Theia LanguageModel id that represents "always route through THIS alias".
 *
 * Id scheme: `ai-connect/<encoded-alias>` where the alias segment is
 * percent-encoded with {@link encodeURIComponent}. That encoding is:
 *   - injective (two different aliases never produce the same id, because
 *     decodeURIComponent inverts it), so ids are collision-free even for
 *     aliases with slashes, spaces, `%`, or other awkward characters;
 *   - reversible (see {@link aliasFromModelId}), so the sync contribution can
 *     recover the alias from a registered model id.
 * `encodeURIComponent` also encodes `/`, so the ONLY `/` in the id is the
 * prefix separator — the segment is always a single, unambiguous token.
 */
export const ALIAS_MODEL_ID_PREFIX = 'ai-connect/';

/** LanguageModel id for the per-alias model that pins requests to `alias`. */
export function aliasModelId(alias: string): string {
  return `${ALIAS_MODEL_ID_PREFIX}${encodeURIComponent(alias)}`;
}

/** True when `id` is one of our per-alias model ids (not the static default). */
export function isAliasModelId(id: string): boolean {
  return id.startsWith(ALIAS_MODEL_ID_PREFIX);
}

/** Recover the alias id from a per-alias model id, or `undefined` if it is not one. */
export function aliasFromModelId(id: string): string | undefined {
  if (!isAliasModelId(id)) {
    return undefined;
  }
  const segment = id.slice(ALIAS_MODEL_ID_PREFIX.length);
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding — not an id we produced; ignore it.
    return undefined;
  }
}

/** One alias-model to register: its source alias id plus the derived model id. */
export interface AliasModelToAdd {
  alias: string;
  id: string;
}

export interface AliasModelDiff {
  /** Alias-models present in `aliases` but not yet in `currentIds`. */
  toAdd: AliasModelToAdd[];
  /** Registered alias-model ids that no longer correspond to any alias. */
  toRemove: string[];
}

/**
 * Pure reconciliation between the currently-registered alias-model ids and the
 * desired alias list. `currentIds` must contain ONLY per-alias model ids (the
 * caller filters the registry with {@link isAliasModelId} so the static
 * back-compat model is never a removal candidate).
 *
 * Rename is naturally an add+remove: the old alias id maps to a model id absent
 * from the new alias set (removed) and the new alias id maps to a model id
 * absent from `currentIds` (added). Duplicate aliases collapse to one model.
 */
export function diffAliasModels(currentIds: readonly string[], aliases: readonly string[]): AliasModelDiff {
  const desiredIds = new Set<string>();
  const toAdd: AliasModelToAdd[] = [];
  const current = new Set(currentIds);

  for (const alias of aliases) {
    const id = aliasModelId(alias);
    if (desiredIds.has(id)) {
      continue;
    }
    desiredIds.add(id);
    if (!current.has(id)) {
      toAdd.push({ alias, id });
    }
  }

  const toRemove = currentIds.filter(id => !desiredIds.has(id));
  return { toAdd, toRemove };
}
