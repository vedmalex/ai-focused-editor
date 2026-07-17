/**
 * Soft-migration resolver for the ai-connect preference keys.
 *
 * When the connection/alias module moved out of manuscript-workspace the
 * preference keys were renamed from the product-specific `aiFocusedEditor.ai.*`
 * to the neutral `aiConnect.*`. Existing user settings still carry the legacy
 * key, so every read resolves through this pure helper:
 *
 *   - the NEW key wins whenever it is EXPLICITLY set (any scope), else
 *   - the LEGACY value is used when IT is explicitly set, else
 *   - the caller's default is used.
 *
 * Kept free of Theia imports so it can be unit-tested in isolation with
 * `bun test`. The preference-reading services feed it the two `inspect`
 * results (value + whether-explicitly-set) for a key pair.
 */
export interface ResolveWithLegacyInput<T> {
  /** Effective value of the new `aiConnect.*` key (may be the schema default). */
  newValue: T | undefined;
  /** True when the new key is explicitly set in some scope. */
  newSet: boolean;
  /** Effective value of the legacy `aiFocusedEditor.ai.*` key. */
  legacyValue: T | undefined;
  /** True when the legacy key is explicitly set in some scope. */
  legacySet: boolean;
  /** Fallback when neither key is explicitly set. */
  defaultValue: T;
}

export function resolveWithLegacy<T>(input: ResolveWithLegacyInput<T>): T {
  if (input.newSet) {
    return (input.newValue ?? input.defaultValue) as T;
  }
  if (input.legacySet) {
    return (input.legacyValue ?? input.defaultValue) as T;
  }
  return input.defaultValue;
}
