import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';

export const NarrativeEntityService = Symbol('NarrativeEntityService');
export const NarrativeEntityBackendService = Symbol('NarrativeEntityBackendService');
export const NarrativeEntityBackendServicePath = '/services/ai-focused-editor/narrative-entity';

export type NarrativeEntityKind = 'character' | 'term' | 'artifact' | 'location';

export interface NarrativeEntity {
  kind: NarrativeEntityKind;
  id: string;
  label: string;
  path: string;
  uri: string;
  summary?: string;
  aliases: string[];
  /** Alternate honorifics/titles for the entity (spec §5.2). */
  epithets?: string[];
  /** Longer-form history behind the entity. */
  backstory?: string;
  /** Narrative arc / how the entity changes across the manuscript. */
  arc?: string;
  /** Characteristic ways this entity speaks or is referred to. */
  speechPatterns?: string[];
  /** Free-form authoring notes. */
  notes?: string;
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

export interface NarrativeEntityBackendService {
  getSnapshot(rootUri?: string): Promise<NarrativeEntitySnapshot>;
  refresh(rootUri?: string): Promise<NarrativeEntitySnapshot>;
}
