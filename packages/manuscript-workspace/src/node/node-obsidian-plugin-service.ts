import { existsSync, promises as fs } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { injectable } from '@theia/core/shared/inversify';
import {
  OBSIDIAN_PLUGIN_ID,
  ObsidianPluginBackendService,
  ObsidianPluginInstallResult,
  ObsidianPluginStatus
} from '../common';

/** The three files the plugin bundle is made of (the only files this service writes into the plugin dir). */
const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'] as const;

/**
 * Backend installer for the AFE Companion Obsidian plugin. It resolves the
 * bundled plugin assets, reports the install status a book needs, and (on the
 * doctor's request) copies the plugin into `<book>/.obsidian/plugins/afe-companion/`
 * and enables it via `<book>/.obsidian/community-plugins.json`.
 *
 * Asset resolution order (first dir that has a `manifest.json` wins):
 *  1. `<module>/../obsidian-plugin` — the packaged/bundled layout, where
 *     `scripts/copy-obsidian-plugin-assets.mjs` places the assets next to
 *     `lib/backend`;
 *  2. `packages/obsidian-plugin/dist` found by climbing from the module dir, then
 *     from `process.cwd()` — the dev-monorepo fallback (no app copy needed).
 */
@injectable()
export class NodeObsidianPluginService implements ObsidianPluginBackendService {
  async getStatus(rootUri: string): Promise<ObsidianPluginStatus> {
    const bundledDir = resolveBundledPluginDir();
    const bundledVersion = bundledDir
      ? await readManifestVersion(join(bundledDir, 'manifest.json'))
      : null;

    const rootPath = toRootPath(rootUri);
    const installedVersion = await readManifestVersion(
      join(rootPath, '.obsidian', 'plugins', OBSIDIAN_PLUGIN_ID, 'manifest.json')
    );
    const hasObsidianDir = await isDirectory(join(rootPath, '.obsidian'));

    return { bundledVersion, installedVersion, hasObsidianDir };
  }

  async install(rootUri: string): Promise<ObsidianPluginInstallResult> {
    const bundledDir = resolveBundledPluginDir();
    if (!bundledDir) {
      return {
        ok: false,
        installedVersion: null,
        communityPluginsMerged: false,
        partial: false,
        message: 'Bundled AFE Companion plugin assets were not found; rebuild the app.'
      };
    }

    const rootPath = toRootPath(rootUri);
    const destDir = join(rootPath, '.obsidian', 'plugins', OBSIDIAN_PLUGIN_ID);
    await fs.mkdir(destDir, { recursive: true });

    // Overwrite ONLY the plugin's own three files — never anything else under .obsidian.
    for (const file of PLUGIN_FILES) {
      const source = join(bundledDir, file);
      if (existsSync(source)) {
        await fs.copyFile(source, join(destDir, file));
      }
    }

    const installedVersion = await readManifestVersion(join(destDir, 'manifest.json'));
    const merge = await this.mergeCommunityPlugins(rootPath);

    return {
      ok: true,
      installedVersion,
      communityPluginsMerged: merge.merged,
      partial: !merge.merged,
      message: merge.message
    };
  }

  /**
   * Merge `afe-companion` into `<book>/.obsidian/community-plugins.json`:
   *  - absent → create it as `["afe-companion"]`;
   *  - a valid JSON array → append the id if missing, rewriting the array while
   *    preserving every other entry;
   *  - already present → no-op (still "merged");
   *  - unparseable / not an array → leave the file UNTOUCHED and report partial,
   *    so the copied files are never lost to a bad enablement file.
   */
  protected async mergeCommunityPlugins(rootPath: string): Promise<{ merged: boolean; message?: string }> {
    const file = join(rootPath, '.obsidian', 'community-plugins.json');
    const text = await readTextIfExists(file);

    if (text === undefined) {
      await fs.writeFile(file, `${JSON.stringify([OBSIDIAN_PLUGIN_ID], undefined, 2)}\n`, 'utf8');
      return { merged: true };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        merged: false,
        message: 'community-plugins.json is not valid JSON; enable AFE Companion manually.'
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        merged: false,
        message: 'community-plugins.json is not a JSON array; enable AFE Companion manually.'
      };
    }
    if (parsed.includes(OBSIDIAN_PLUGIN_ID)) {
      return { merged: true };
    }
    parsed.push(OBSIDIAN_PLUGIN_ID);
    await fs.writeFile(file, `${JSON.stringify(parsed, undefined, 2)}\n`, 'utf8');
    return { merged: true };
  }
}

/** Locate the bundled plugin asset dir; undefined when neither packaged nor dev assets exist. */
function resolveBundledPluginDir(): string | undefined {
  const candidates: string[] = [
    // Packaged/bundled: apps/<target>/lib/backend -> apps/<target>/lib/obsidian-plugin.
    join(__dirname, '..', 'obsidian-plugin'),
    join(__dirname, 'obsidian-plugin')
  ];
  // Dev-monorepo fallback: climb for packages/obsidian-plugin/dist from the module
  // dir and from the process cwd.
  for (const start of [__dirname, process.cwd()]) {
    let dir = start;
    for (let depth = 0; depth < 8; depth++) {
      candidates.push(join(dir, 'packages', 'obsidian-plugin', 'dist'));
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'manifest.json'))) {
      return candidate;
    }
  }
  return undefined;
}

async function readManifestVersion(path: string): Promise<string | null> {
  const text = await readTextIfExists(path);
  if (text === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const version = isRecord(parsed) ? parsed.version : undefined;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

function toRootPath(rootUri: string): string {
  if (rootUri.startsWith('file:')) {
    return FileUri.fsPath(rootUri);
  }
  return isAbsolute(rootUri) ? rootUri : resolve(process.cwd(), rootUri);
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
