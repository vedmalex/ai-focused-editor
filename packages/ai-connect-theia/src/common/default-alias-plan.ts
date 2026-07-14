/**
 * Planning logic for contributing the ai-connect model into Theia's
 * `default/*` language-model aliases (the identifiers agents resolve when the
 * user has not mapped a model explicitly in the AI Configuration view).
 *
 * Theia seeds those aliases with official provider model ids only
 * (anthropic/openai/google) — in an app whose models come from ai-connect,
 * every agent fails with "Couldn't find a ready language model" until each is
 * mapped by hand. Prepending our always-ready current-alias model makes
 * agents work out of the box, while the user's explicit `selectedModelId`
 * (set through the AI Configuration UI) still wins in `resolveAlias`.
 */

export interface DefaultAliasLike {
  readonly id: string;
  readonly defaultModelIds: string[];
  readonly description?: string;
  readonly selectedModelId?: string;
}

/**
 * Compute the alias entries that need rewriting so that `modelId` is the
 * FIRST default of every `default/*` alias (when `enabled`), or absent from
 * all of them (when not). Untouched aliases are not returned. All other
 * fields — including the user's `selectedModelId` — are preserved verbatim.
 */
export function planDefaultAliasUpdates(
  aliases: readonly DefaultAliasLike[],
  modelId: string,
  enabled: boolean
): DefaultAliasLike[] {
  const updates: DefaultAliasLike[] = [];
  for (const alias of aliases) {
    if (!alias.id.startsWith('default/')) {
      continue;
    }
    const without = alias.defaultModelIds.filter(id => id !== modelId);
    const next = enabled ? [modelId, ...without] : without;
    if (!sameIds(alias.defaultModelIds, next)) {
      updates.push({ ...alias, defaultModelIds: next });
    }
  }
  return updates;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
