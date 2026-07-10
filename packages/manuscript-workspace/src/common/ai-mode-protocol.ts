import type { GenerateParameters } from '@vedmalex/ai-connect';
import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';

export const AiModeRegistry = Symbol('AiModeRegistry');
export const AiModeRegistryBackendService = Symbol('AiModeRegistryBackendService');
export const AiModeRegistryBackendServicePath = '/services/ai-focused-editor/ai-mode-registry';

export interface AiMode {
  id: string;
  label: string;
  description?: string;
  systemPrompt: string;
  userPrompt?: string;
  parameters?: GenerateParameters;
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
