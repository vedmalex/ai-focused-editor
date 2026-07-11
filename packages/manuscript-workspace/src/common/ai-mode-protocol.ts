import type { GenerateParameters } from '@vedmalex/ai-connect';
import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';

export const AiModeRegistry = Symbol('AiModeRegistry');
export const AiModeRegistryBackendService = Symbol('AiModeRegistryBackendService');
export const AiModeRegistryBackendServicePath = '/services/ai-focused-editor/ai-mode-registry';

/**
 * Where a mode draws its input from and where it may surface in the UI.
 * - `selection`: operate on the current editor selection.
 * - `word`: operate on the word under the cursor.
 * - `chapter`: operate on the whole active document.
 * - `chat`: no editor input; send to the AI chat.
 */
export type AiModeContext = 'selection' | 'word' | 'chapter' | 'chat';

/**
 * How a mode delivers its result.
 * - `replace`: replace the input range via a Change Set (selection/word only).
 * - `insert`: insert the result after the input range via a Change Set.
 * - `chat`: send the request to the AI chat view.
 */
export type AiModeApply = 'replace' | 'insert' | 'chat';

export const AI_MODE_CONTEXTS: readonly AiModeContext[] = ['selection', 'word', 'chapter', 'chat'];
export const AI_MODE_APPLY_KINDS: readonly AiModeApply[] = ['replace', 'insert', 'chat'];

/**
 * Which layer a resolved mode was contributed by, lowest to highest precedence:
 * - `built-in`: bundled base modes shipped with the editor (read-only).
 * - `global`: the user's `~/.ai-focused-editor/custom-modes.yaml`.
 * - `book`: the book's `ai/prompts/custom-modes.yaml`.
 * A mode of a given id in a higher layer replaces the whole lower-layer record.
 */
export type AiModeOrigin = 'built-in' | 'global' | 'book';

export const AI_MODE_ORIGINS: readonly AiModeOrigin[] = ['built-in', 'global', 'book'];

export interface AiMode {
  id: string;
  label: string;
  description?: string;
  systemPrompt: string;
  userPrompt?: string;
  parameters?: GenerateParameters;
  /** Input source + default UI placement. Defaults to `chat`. */
  context?: AiModeContext;
  /** Whether to expose the mode in the editor context menu. Defaults to `false`. */
  menu?: boolean;
  /** How the result is delivered. Defaults to `replace` for selection, else `chat`. */
  apply?: AiModeApply;
  /** Whether to register the mode as a chat `@agent`. Defaults to `false`. */
  agent?: boolean;
  /** Optional codicon name (without the `codicon-` prefix) for menus. */
  icon?: string;
  /**
   * Whether the mode is active. Defaults to `true`. A mode with `enabled: false`
   * is hidden from menus, agents, prompt fragments and pickers, but still shown
   * (as disabled) in the AI Modes form editor so it can be re-enabled.
   */
  enabled?: boolean;
  /**
   * The layer this mode was resolved from. Populated by the layering step on the
   * node side; NEVER authored into or written back to a modes YAML file.
   */
  origin?: AiModeOrigin;
}

/**
 * A fully-resolved mode with its layer origin and the lower-precedence layer it
 * shadows (if any). Used by the form editor to badge modes and to render
 * built-in/global modes read-only. `origin`/`overrides`/`enabled` are derived —
 * they are never persisted to a modes YAML file.
 */
export interface ResolvedAiMode extends AiMode {
  origin: AiModeOrigin;
  enabled: boolean;
  /** The origin of the lower layer this record overrides, when it shadows one. */
  overrides?: AiModeOrigin;
}

/**
 * Resolves the effective `apply` delivery for a mode: authored value when set,
 * otherwise `replace` for selection modes and `chat` for everything else.
 * `replace`/`insert` are only meaningful for `selection`/`word` contexts; for
 * `chapter`/`chat` they collapse to `chat`.
 */
export function resolveAiModeApply(mode: AiMode): AiModeApply {
  const context: AiModeContext = mode.context ?? 'chat';
  const apply: AiModeApply = mode.apply ?? (context === 'selection' ? 'replace' : 'chat');
  if ((apply === 'replace' || apply === 'insert') && context !== 'selection' && context !== 'word') {
    return 'chat';
  }
  return apply;
}

export interface AiModeRegistrySnapshot {
  rootUri?: string;
  /** The book modes file (`ai/prompts/custom-modes.yaml`), when a workspace is open. */
  sourceUri?: string;
  /** The user-global modes file (`~/.ai-focused-editor/custom-modes.yaml`). */
  globalUri?: string;
  /**
   * All layer files that should be hot-watched for changes (book + global). The
   * bundled base modes ship read-only and need no watch. Consumers watch each
   * parent directory to pick up create/edit/delete of a layer file.
   */
  watchUris?: string[];
  /**
   * The resolved, layered modes that consumers register (menus, agents, prompt
   * fragments, pickers). Already filtered to enabled modes and origin-tagged, so
   * existing consumers need no change.
   */
  modes: AiMode[];
  /**
   * The full resolution across every layer, INCLUDING disabled modes, for the
   * form editor to display with origin badges. Absent on error/no-workspace.
   */
  resolved?: ResolvedAiMode[];
  diagnostics: WorkspaceDiagnostic[];
}

export interface AiModeRegistry {
  getSnapshot(): Promise<AiModeRegistrySnapshot>;
  refresh(): Promise<AiModeRegistrySnapshot>;
  listModes(): Promise<AiMode[]>;
  getMode(id: string): Promise<AiMode | undefined>;
}

export interface AiModeRegistryBackendService {
  getSnapshot(rootUri?: string): Promise<AiModeRegistrySnapshot>;
  refresh(rootUri?: string): Promise<AiModeRegistrySnapshot>;
}
