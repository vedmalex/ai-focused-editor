export const ManuscriptWorkspaceService = Symbol('ManuscriptWorkspaceService');

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

export interface ManuscriptWorkspaceService {
  getSnapshot(): Promise<ManuscriptWorkspaceSnapshot>;
  refresh(): Promise<ManuscriptWorkspaceSnapshot>;
}
