export const GitHistoryService = Symbol('GitHistoryService');
export const GitHistoryServicePath = '/services/ai-focused-editor/git-history';

export interface GitStatusFile {
  path: string;
  uri: string;
  indexStatus: string;
  workingTreeStatus: string;
}

export interface GitStatusSnapshot {
  available: boolean;
  clean: boolean;
  rootUri?: string;
  branch?: string;
  files: GitStatusFile[];
  message?: string;
}

export interface GitFileContentRequest {
  uri: string;
  ref?: string;
}

export interface GitFileContent {
  uri: string;
  ref: string;
  exists: boolean;
  content: string;
}

export interface GitHistoryService {
  getStatus(rootUri?: string): Promise<GitStatusSnapshot>;
  getFileContent(request: GitFileContentRequest): Promise<GitFileContent>;
}
