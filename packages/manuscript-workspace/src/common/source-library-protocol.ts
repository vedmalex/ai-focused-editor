import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';

export const SourceLibraryService = Symbol('SourceLibraryService');

export interface SourceLibraryItem {
  name: string;
  path: string;
  uri: string;
  type: 'file' | 'directory';
}

export interface CitationEntry {
  id: string;
  title: string;
  source?: string;
  note?: string;
}

export interface SourceLibrarySnapshot {
  rootUri?: string;
  sourceUri?: string;
  items: SourceLibraryItem[];
  citations: CitationEntry[];
  diagnostics: WorkspaceDiagnostic[];
}

export interface SourceLibraryService {
  getSnapshot(): Promise<SourceLibrarySnapshot>;
  refresh(): Promise<SourceLibrarySnapshot>;
}
