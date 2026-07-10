import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';

export const SourceLibraryService = Symbol('SourceLibraryService');
export const SourceLibraryBackendService = Symbol('SourceLibraryBackendService');
export const SourceLibraryBackendServicePath = '/services/ai-focused-editor/source-library';

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
  /**
   * Workspace-relative path to the cited source file, derived from `source`
   * when it resolves to a file inside the workspace. Consumers use it to open
   * the underlying document (e.g. from `[@cite:id]` links).
   */
  path?: string;
}

/**
 * A source excerpt indexed from `sources/excerpts.jsonl` (spec §5.4).
 * Excerpts can optionally link a source fragment back to a manuscript
 * paragraph via `targetPath` (+ `targetAnchor`/`targetLine`).
 */
export interface SourceExcerpt {
  id: string;
  /** Free-form source reference (citation id or label). */
  sourceId?: string;
  /** Workspace-relative path of the originating source document, when known. */
  sourcePath?: string;
  text: string;
  note?: string;
  /** Workspace-relative path of the manuscript file this excerpt links to. */
  targetPath?: string;
  /** Optional anchor (heading slug) within the target file. */
  targetAnchor?: string;
  /** Optional 1-based line to reveal within the target file. */
  targetLine?: number;
}

export interface SourceLibrarySnapshot {
  rootUri?: string;
  sourceUri?: string;
  items: SourceLibraryItem[];
  citations: CitationEntry[];
  excerpts: SourceExcerpt[];
  diagnostics: WorkspaceDiagnostic[];
}

export interface SourceLibraryService {
  getSnapshot(): Promise<SourceLibrarySnapshot>;
  refresh(): Promise<SourceLibrarySnapshot>;
}

export interface SourceLibraryBackendService {
  getSnapshot(rootUri?: string): Promise<SourceLibrarySnapshot>;
  refresh(rootUri?: string): Promise<SourceLibrarySnapshot>;
}
