import type { ContributedTaskConfiguration } from '@theia/task/lib/common';
import type { BookBuildFormat } from './book-build-protocol';

export const BookBuildTaskType = 'ai-focused-editor.book-build';
export const BookBuildTaskSource = 'AI Focused Editor';
export const BookBuildMarkdownTaskLabel = 'AI Focused Editor: Build Manuscript Markdown';
export const BookBuildHtmlTaskLabel = 'AI Focused Editor: Build Manuscript HTML';
export const BookBuildEpubTaskLabel = 'AI Focused Editor: Build Manuscript EPUB';
export const BookBuildPdfTaskLabel = 'AI Focused Editor: Build Manuscript PDF';
export const BookBuildDefaultMarkdownOutputPath = 'build/book.md';
export const BookBuildDefaultHtmlOutputPath = 'build/book.html';
export const BookBuildDefaultEpubOutputPath = 'build/book.epub';
export const BookBuildDefaultPdfOutputPath = 'build/book.pdf';

export interface BookBuildTaskConfiguration extends ContributedTaskConfiguration {
  rootUri: string;
  format?: BookBuildFormat;
  outputPath?: string;
}
