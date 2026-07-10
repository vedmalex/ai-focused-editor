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
  sourceUri?: string;
  modes: AiMode[];
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
