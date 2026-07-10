import type { WorkspaceDiagnostic } from './manuscript-workspace-protocol';

export const BookBuildService = Symbol('BookBuildService');
export const BookBuildServicePath = '/services/ai-focused-editor/book-build';

export type BookBuildFormat = 'markdown' | 'html' | 'epub' | 'pdf';

export interface BookBuildRequest {
  rootUri?: string;
  outputPath?: string;
}

export interface BookBuildChapter {
  path: string;
  title: string;
  uri: string;
  included: boolean;
  bytes: number;
}

export interface BookBuildResult {
  rootUri: string;
  outputUri: string;
  outputPath: string;
  format: BookBuildFormat;
  title: string;
  chapters: BookBuildChapter[];
  diagnostics: WorkspaceDiagnostic[];
  generatedAt: string;
  contentLength: number;
}

export interface BookBuildService {
  buildMarkdown(request?: BookBuildRequest): Promise<BookBuildResult>;
  buildHtml(request?: BookBuildRequest): Promise<BookBuildResult>;
  buildEpub(request?: BookBuildRequest): Promise<BookBuildResult>;
  buildPdf(request?: BookBuildRequest): Promise<BookBuildResult>;
}
