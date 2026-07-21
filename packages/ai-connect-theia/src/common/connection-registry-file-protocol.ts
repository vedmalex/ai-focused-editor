import type {
  ConnectionRegistry,
  ConversionNote,
  RegistryIssue,
  RegistrySecretsFragment,
  SaveRegistryResult,
  SaveSecretsResult
} from '@vedmalex/ai-connect/registry';

/**
 * JSON-RPC service for reading/writing v2 `connections.json` registry files that
 * live OUTSIDE the workspace root (`~/.config/ai-connect/`,
 * `<cwd>/.config/ai-connect/`). The `@vedmalex/ai-connect/registry/fs` loader is
 * node/bun-only, so all filesystem access happens on the backend; the browser
 * consumes this proxy. Every argument and result is plain JSON.
 */
export const ConnectionRegistryFileService = Symbol('ConnectionRegistryFileService');
export const ConnectionRegistryFileServicePath = '/services/ai-focused-editor/connection-registry-file';

/**
 * Which on-disk layer to target: the XDG user layer, the project layer (anchored
 * on {@link RegistryFileContext.cwd}), or an explicit file path.
 */
export type RegistryFileLayer = 'user' | 'project' | { path: string };

/**
 * The backend process cwd is NOT the workspace root; the project layer and any
 * relative `{ path }` must be anchored on the workspace root passed from the
 * frontend explicitly.
 */
export interface RegistryFileContext {
  /** Workspace root fs-path; anchors the `project` layer and relative custom paths. */
  cwd?: string;
}

export interface RegistryFileLoadResult {
  /** False when no registry file existed at the resolved layer path. */
  found: boolean;
  registry: ConnectionRegistry;
  /** The layer path that was searched/loaded. */
  path: string;
  issues: RegistryIssue[];
  notes: ConversionNote[];
}

export interface ConnectionRegistryFileService {
  /**
   * Load a single layer's registry file in isolation (via the library's
   * `opts.path`, bypassing multi-layer merge). A missing file yields
   * `{ found: false, registry: { version: 2, endpoints: [] } }`; a malformed JSON
   * file propagates.
   */
  loadFromLayer(
    layer: RegistryFileLayer,
    opts?: RegistryFileContext & { includeSecrets?: boolean }
  ): Promise<RegistryFileLoadResult>;
  /** Persist the registry to the layer (`merge` keeps neighbors' entries verbatim). */
  saveToLayer(
    layer: RegistryFileLayer,
    registry: ConnectionRegistry,
    mode: 'merge' | 'replace',
    opts?: RegistryFileContext
  ): Promise<SaveRegistryResult>;
  /** Persist secrets to the sibling `connections.secrets.json` for the layer. */
  saveSecretsToLayer(
    layer: RegistryFileLayer,
    fragment: RegistrySecretsFragment,
    mode: 'merge' | 'replace',
    opts?: RegistryFileContext
  ): Promise<SaveSecretsResult>;
  /** Resolve the absolute on-disk path a layer maps to (no I/O). */
  resolveLayerPath(layer: RegistryFileLayer, opts?: RegistryFileContext): Promise<string>;
}
