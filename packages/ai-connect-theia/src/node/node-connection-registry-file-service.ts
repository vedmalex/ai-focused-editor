import * as os from 'os';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';
import {
  loadConnectionRegistry,
  saveConnectionRegistry,
  saveConnectionSecrets
} from '@vedmalex/ai-connect/registry/fs';
import type {
  ConnectionRegistry,
  RegistrySecretsFragment,
  SaveRegistryResult,
  SaveSecretsResult
} from '@vedmalex/ai-connect/registry';
import {
  ConnectionRegistryFileService,
  type RegistryFileContext,
  type RegistryFileLayer,
  type RegistryFileLoadResult
} from '../common';

const REGISTRY_FILENAME = 'connections.json';
const SECRETS_FILENAME = 'connections.secrets.json';

/**
 * A "no registry found on disk" signal from the library's loader. This is a
 * STRUCTURAL check rather than `isAiConnectError`/`instanceof`:
 * `@vedmalex/ai-connect/registry/fs` is a separately-bundled entry that
 * inlines its own `AiConnectError` class, so an identity `instanceof` against
 * the main-entry class fails (in production node builds too, not just under
 * bun).
 *
 * `code === 'validation_error'` alone is NOT sufficient: the library throws
 * that SAME code both for a genuine not-found (registry-fs.js: `new
 * AiConnectError('validation_error', 'No connection registry found. Searched:
 * …', { searchedPaths })`) AND for a corrupt v2 file that `parseRegistry`
 * rejects (e.g. `{"version":2}` with no `endpoints` array), which carries no
 * `details.searchedPaths`. Discriminating on `details.searchedPaths` being an
 * array is what actually distinguishes "nothing there" from "something there
 * but broken" — a corrupt config must propagate as an error, not be
 * misreported as absent. A malformed-JSON fault throws a `SyntaxError` (no
 * `code` at all) and is intentionally NOT caught here — it propagates too.
 */
function isRegistryNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'validation_error' &&
    Array.isArray((error as { details?: { searchedPaths?: unknown } }).details?.searchedPaths)
  );
}

/**
 * Backend implementation of {@link ConnectionRegistryFileService} — the ONLY
 * module in this package that imports `@vedmalex/ai-connect/registry/fs` (the
 * node/bun-only filesystem loader/writer). All layer paths resolve OUTSIDE the
 * workspace root, so this cannot use Theia's `FileService`.
 *
 * `resolveLayerPath` reproduces the library's XDG/user + project layer addressing
 * (the library's `resolveSaveTarget` is private), keeping load/save/secrets all
 * anchored on one explicit path so the target is never ambiguous.
 */
@injectable()
export class NodeConnectionRegistryFileService implements ConnectionRegistryFileService {
  async resolveLayerPath(layer: RegistryFileLayer, opts?: RegistryFileContext): Promise<string> {
    return this.resolveRegistryPath(layer, opts);
  }

  async loadFromLayer(
    layer: RegistryFileLayer,
    opts?: RegistryFileContext & { includeSecrets?: boolean }
  ): Promise<RegistryFileLoadResult> {
    const layerPath = this.resolveRegistryPath(layer, opts);
    try {
      // Passing `path` isolates this single layer (the library otherwise merges
      // user+project+env and throws when none exist).
      const loaded = await loadConnectionRegistry({
        path: layerPath,
        includeSecrets: opts?.includeSecrets ?? false,
        cwd: opts?.cwd
      });
      return {
        found: true,
        registry: loaded.registry,
        path: layerPath,
        issues: loaded.issues,
        notes: loaded.notes
      };
    } catch (error) {
      // A missing file surfaces as AiConnectError("validation_error", "No
      // connection registry found …", { searchedPaths }) — that marker is the
      // honest not-found signal (see isRegistryNotFound). A corrupt v2 file
      // and malformed JSON both propagate instead of being swallowed here.
      if (isRegistryNotFound(error)) {
        return {
          found: false,
          registry: { version: 2, endpoints: [] },
          path: layerPath,
          issues: [],
          notes: []
        };
      }
      throw error;
    }
  }

  async saveToLayer(
    layer: RegistryFileLayer,
    registry: ConnectionRegistry,
    mode: 'merge' | 'replace',
    opts?: RegistryFileContext
  ): Promise<SaveRegistryResult> {
    const layerPath = this.resolveRegistryPath(layer, opts);
    // Library defaults kept intact: backup:true, atomic tmp+rename, verbatim merge.
    return saveConnectionRegistry(registry, { path: layerPath, mode, cwd: opts?.cwd });
  }

  async saveSecretsToLayer(
    layer: RegistryFileLayer,
    fragment: RegistrySecretsFragment,
    mode: 'merge' | 'replace',
    opts?: RegistryFileContext
  ): Promise<SaveSecretsResult> {
    const secretsPath = path.join(path.dirname(this.resolveRegistryPath(layer, opts)), SECRETS_FILENAME);
    return saveConnectionSecrets(fragment, { path: secretsPath, mode, cwd: opts?.cwd });
  }

  /**
   * Resolve the absolute `connections.json` path for a layer, mirroring the
   * library's private `resolveSaveTarget`:
   * - user    → `$XDG_CONFIG_HOME|~/.config` + `/ai-connect/connections.json`
   * - project → `<cwd>/.config/ai-connect/connections.json` (cwd is required)
   * - {path}  → `path.resolve(cwd ?? process.cwd(), path)`
   */
  protected resolveRegistryPath(layer: RegistryFileLayer, opts?: RegistryFileContext): string {
    if (typeof layer === 'object') {
      return path.resolve(opts?.cwd ?? process.cwd(), layer.path);
    }
    if (layer === 'user') {
      const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
      return path.join(configHome, 'ai-connect', REGISTRY_FILENAME);
    }
    // layer === 'project'
    const cwd = opts?.cwd;
    if (!cwd) {
      throw new Error(
        "The 'project' registry layer requires a workspace root (opts.cwd); none was provided."
      );
    }
    return path.join(cwd, '.config', 'ai-connect', REGISTRY_FILENAME);
  }
}
