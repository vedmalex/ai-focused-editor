export const ManuscriptWorkspaceService = Symbol('ManuscriptWorkspaceService');
export const ManuscriptWorkspaceBackendService = Symbol('ManuscriptWorkspaceBackendService');
export const ManuscriptWorkspaceBackendServicePath = '/services/ai-focused-editor/manuscript-workspace';

export type ManuscriptNodeType = 'file' | 'folder';

export interface ManuscriptNode {
  id: string;
  name: string;
  path: string;
  uri?: string;
  type: ManuscriptNodeType;
  order: number;
  buildIncluded: boolean;
  children?: ManuscriptNode[];
}

export interface WorkspaceDiagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
  source: string;
  uri?: string;
  range?: {
    start: {
      line: number;
      character: number;
    };
    end: {
      line: number;
      character: number;
    };
  };
}

export interface ManuscriptWorkspaceSnapshot {
  rootUri?: string;
  manifestUri?: string;
  content: ManuscriptNode[];
  diagnostics: WorkspaceDiagnostic[];
}

export interface ManuscriptMoveTarget {
  /**
   * Workspace-relative path of the folder entry that should become the parent.
   * Undefined targets the manifest root content list.
   */
  parentPath?: string;
  /** Insertion index within the target sibling list; values past the end append. */
  index: number;
}

export interface ManuscriptMutationResult {
  ok: boolean;
  message?: string;
  snapshot: ManuscriptWorkspaceSnapshot;
}

export interface ManuscriptWorkspaceService {
  getSnapshot(): Promise<ManuscriptWorkspaceSnapshot>;
  refresh(): Promise<ManuscriptWorkspaceSnapshot>;
  moveEntry(sourcePath: string, target: ManuscriptMoveTarget): Promise<ManuscriptMutationResult>;
  setBuildInclusion(path: string, include: boolean): Promise<ManuscriptMutationResult>;
  createChapter(parentPath: string | undefined, title: string): Promise<ManuscriptMutationResult>;
}

export interface ManuscriptWorkspaceBackendService {
  getSnapshot(rootUri?: string): Promise<ManuscriptWorkspaceSnapshot>;
  refresh(rootUri?: string): Promise<ManuscriptWorkspaceSnapshot>;
  moveManuscriptEntry(rootUri: string, sourcePath: string, target: ManuscriptMoveTarget): Promise<ManuscriptMutationResult>;
  setManuscriptBuildInclusion(rootUri: string, path: string, include: boolean): Promise<ManuscriptMutationResult>;
  createManuscriptChapter(rootUri: string, parentPath: string | undefined, title: string): Promise<ManuscriptMutationResult>;
}
