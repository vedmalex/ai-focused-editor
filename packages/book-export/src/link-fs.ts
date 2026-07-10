/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0). Extracted to the
 * self-contained EPUB export closure for AI Focused Editor.
 */
// Shared filesystem-related utilities for links subsystem

export const DEFAULT_MARKDOWN_EXTENSIONS: readonly string[] = ['.md', '.markdown'];

export function isMarkdownFilePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const lower = filePath.toLowerCase();
  return DEFAULT_MARKDOWN_EXTENSIONS.some(ext => lower.endsWith(ext));
}
