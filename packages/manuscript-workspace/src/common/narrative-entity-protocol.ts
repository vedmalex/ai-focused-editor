import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';
import type { NarrativeEntityKindFromRegistry } from './entity-type-registry';

export const NarrativeEntityService = Symbol('NarrativeEntityService');
export const NarrativeEntityBackendService = Symbol('NarrativeEntityBackendService');
export const NarrativeEntityBackendServicePath = '/services/ai-focused-editor/narrative-entity';

/**
 * The narrative entity kind union, derived from the single-source-of-truth
 * {@link BASE_ENTITY_TYPES} registry. Stays the same four literals
 * (`character | term | artifact | location`) — the registry's `as const` keeps
 * them from widening to `string`.
 */
export type NarrativeEntityKind = NarrativeEntityKindFromRegistry;

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
