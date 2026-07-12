/**
 * Backend protocol for installing the AFE Companion Obsidian plugin
 * (`packages/obsidian-plugin`, id `afe-companion`) straight into a book folder so
 * the folder doubles as a ready Obsidian vault.
 *
 * All filesystem work runs in the node backend (it has direct access to BOTH the
 * bundled plugin assets — copied next to `lib/backend` by
 * `scripts/copy-obsidian-plugin-assets.mjs`, with a dev fallback to
 * `packages/obsidian-plugin/dist` — AND the opened book folder). The browser
 * (Book Doctor) only reads the {@link ObsidianPluginStatus} to decide whether to
 * offer an install/update fix and then asks the backend to apply it.
 */
export const ObsidianPluginBackendService = Symbol('ObsidianPluginBackendService');
export const ObsidianPluginBackendServicePath = '/services/ai-focused-editor/obsidian-plugin';

/** The plugin id — the folder under `<book>/.obsidian/plugins/` and the community-plugins entry. */
export const OBSIDIAN_PLUGIN_ID = 'afe-companion';

/** Version + presence snapshot the doctor's pure check consumes. */
export interface ObsidianPluginStatus {
  /** Version from the bundled asset dir's manifest.json; `null` when assets are unavailable. */
  bundledVersion: string | null;
  /** Version from `<book>/.obsidian/plugins/afe-companion/manifest.json`; `null` when not installed. */
  installedVersion: string | null;
  /** Whether the book folder already has an `.obsidian/` directory (already used as a vault). */
  hasObsidianDir: boolean;
}

/** Outcome of an install/update action. */
export interface ObsidianPluginInstallResult {
  /** True when the plugin files were written (community-plugins merge may still be partial). */
  ok: boolean;
  /** Version of the freshly-installed plugin (read back from the copied manifest.json). */
  installedVersion: string | null;
  /**
   * True when `community-plugins.json` now lists `afe-companion` (created, appended,
   * or already present). False when the file was left untouched because it was
   * unparseable — the install is then PARTIAL (files copied, enablement manual).
   */
  communityPluginsMerged: boolean;
  /** True when the plugin files copied but the community-plugins merge was skipped. */
  partial: boolean;
  /** Present when the action failed or was partial — a human-readable reason. */
  message?: string;
}

export interface ObsidianPluginBackendService {
  /** Read the bundled + installed versions and `.obsidian/` presence for `rootUri`. */
  getStatus(rootUri: string): Promise<ObsidianPluginStatus>;
  /**
   * Install/update the plugin into `<book>/.obsidian/plugins/afe-companion/`
   * (overwriting only the plugin's own files) and merge `afe-companion` into
   * `<book>/.obsidian/community-plugins.json`. Never touches any other `.obsidian`
   * file.
   */
  install(rootUri: string): Promise<ObsidianPluginInstallResult>;
}
