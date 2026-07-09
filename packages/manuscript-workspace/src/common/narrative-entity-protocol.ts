import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';

export const NarrativeEntityService = Symbol('NarrativeEntityService');

export type NarrativeEntityKind = 'character' | 'term';

export interface NarrativeEntity {
  kind: NarrativeEntityKind;
  id: string;
  label: string;
  path: string;
  uri: string;
  summary?: string;
  aliases: string[];
}

export interface NarrativeEntitySnapshot {
  rootUri?: string;
  entities: NarrativeEntity[];
  diagnostics: WorkspaceDiagnostic[];
}

export interface NarrativeEntityService {
  getSnapshot(): Promise<NarrativeEntitySnapshot>;
  refresh(): Promise<NarrativeEntitySnapshot>;
}
