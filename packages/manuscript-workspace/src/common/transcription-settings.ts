/**
 * Pure (Theia-free) helpers for the Transcription Settings panel and the Book
 * Doctor's transcription SETTINGS checks.
 *
 * The panel shows, for every `mediaTranscription.*` key, the EFFECTIVE value
 * and WHERE IT CAME FROM (default / user / workspace / folder). Theia's
 * `PreferenceService.inspect()` already returns the per-scope values; the
 * origin-resolution itself is pure (narrowest defined scope wins) and lives
 * here so it is unit-testable under `bun test`.
 */

/** Where an effective preference value came from (narrowest defined scope). */
export type PreferenceValueOrigin = 'default' | 'user' | 'workspace' | 'folder';

/**
 * The per-scope values of one preference — a structural subset of Theia's
 * `PreferenceInspection` (`globalValue` = user scope), so the browser can pass
 * `preferences.inspect(key)` straight in.
 */
export interface PreferenceScopeValues<T> {
  defaultValue?: T;
  /** Value in USER scope (`~/.theia/settings.json`). */
  globalValue?: T;
  /** Value in WORKSPACE scope (`<workspace>/.theia/settings.json`). */
  workspaceValue?: T;
  /** Value in workspace-FOLDER scope (multi-root folder settings). */
  workspaceFolderValue?: T;
}

/** The resolved effective value plus its origin scope. */
export interface EffectivePreference<T> {
  value: T | undefined;
  origin: PreferenceValueOrigin;
}

/**
 * Resolve the EFFECTIVE value of a preference from its per-scope values using
 * the Theia cascade: folder > workspace > user > default. A scope counts as
 * "defined" when its value is not `undefined` (an empty string IS a defined
 * value — the user deliberately cleared the path there). When nothing is
 * defined anywhere the origin is `default` with an `undefined` value.
 */
export function resolveEffectivePreference<T>(values: PreferenceScopeValues<T>): EffectivePreference<T> {
  if (values.workspaceFolderValue !== undefined) {
    return { value: values.workspaceFolderValue, origin: 'folder' };
  }
  if (values.workspaceValue !== undefined) {
    return { value: values.workspaceValue, origin: 'workspace' };
  }
  if (values.globalValue !== undefined) {
    return { value: values.globalValue, origin: 'user' };
  }
  return { value: values.defaultValue, origin: 'default' };
}

/**
 * True when the preference carries a non-blank value at WORKSPACE level
 * (workspace or workspace-folder scope) — the Book Doctor's secret check uses
 * this for `mediaTranscription.groqApiKey` (a workspace-scope secret lands in
 * `<book>/.theia/settings.json` and can be committed).
 */
export function hasWorkspaceScopedValue(values: PreferenceScopeValues<string>): boolean {
  const workspace = values.workspaceFolderValue ?? values.workspaceValue;
  return typeof workspace === 'string' && workspace.trim().length > 0;
}

/**
 * Split a raw `mediaTranscription.groqApiKey` value into individual keys (the
 * `GROQ_API_KEY` comma-separated list convention the backend GroqKeyManager
 * rotates over). Blank entries are dropped; a blank/undefined input yields [].
 */
export function splitGroqApiKeys(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map(key => key.trim())
    .filter(key => key.length > 0);
}
