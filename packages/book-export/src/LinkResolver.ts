/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0). Extracted and trimmed
 * to the self-contained EPUB export closure for AI Focused Editor.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import type { LocalLink } from './metadata-types';
import { PathResolver } from './PathResolver';
import type {
  BrokenLink,
  FileScanResult,
  ScanResult
} from './link-types';
import { newMarkdownLinkRegex } from './link-regex';
import { isMarkdownFilePath } from './link-fs';

/**
 * LinkResolver provides intelligent suggestions for fixing broken links
 */
export class LinkResolver {
  private static pathResolverInstance = PathResolver.getInstance();

  /**
   * Resolve suggestions for broken links based on available files
   * @param scanResults All scan results from the project
   * @returns Updated scan results with suggestions populated
   */
  async resolveBrokenLinks(scanResults: FileScanResult[]): Promise<FileScanResult[]> {
    // Build a map of available files by their basename for quick lookup
    const availableFiles = this.buildFileMap(scanResults);

    const resolvedResults: FileScanResult[] = [];

    for (const scanResult of scanResults) {
      const updatedBrokenLinks: BrokenLink[] = [];

      for (const brokenLink of scanResult.brokenLinks) {
        const suggestions = this.findSuggestions(brokenLink, availableFiles, scanResult.filePath);

        updatedBrokenLinks.push({
          ...brokenLink,
          suggestions,
          canAutoFix: suggestions.length > 0
        });
      }

      resolvedResults.push({
        ...scanResult,
        brokenLinks: updatedBrokenLinks
      });
    }

    return resolvedResults;
  }

  /**
   * Resolve suggestions for a complete scan result
   * @param scanResult Complete scan result
   * @returns Updated scan result with all suggestions resolved
   */
  async resolveScanResult(scanResult: ScanResult): Promise<ScanResult> {
    const resolvedFileResults = await this.resolveBrokenLinks(scanResult.fileResults);

    // Rebuild the flattened broken links array
    const allBrokenLinks: BrokenLink[] = [];
    for (const fileResult of resolvedFileResults) {
      allBrokenLinks.push(...fileResult.brokenLinks);
    }

    return {
      ...scanResult,
      brokenLinks: allBrokenLinks,
      fileResults: resolvedFileResults
    };
  }

  /**
   * Find suggestions for a single broken link
   * @param brokenLink The broken link to find suggestions for
   * @param availableFiles Map of available files
   * @param sourceFilePath Path of the source file
   * @returns Array of suggested fix paths
   */
  private findSuggestions(
    brokenLink: BrokenLink,
    availableFiles: Map<string, string[]>,
    sourceFilePath: string
  ): string[] {
    const linkHref = brokenLink.link.href;

    // Extract the filename from the broken link
    const targetFilename = this.extractFilename(linkHref);

    if (!targetFilename) {
      return [];
    }

    // Find files with matching names
    const candidateFiles = availableFiles.get(targetFilename.toLowerCase()) || [];

    if (candidateFiles.length === 0) {
      return [];
    }

    // Generate relative paths from source to each candidate
    const suggestions: string[] = [];
    const sourceDir = dirname(sourceFilePath);

    for (const candidateFile of candidateFiles) {
      // Skip if it's the same file
      if (candidateFile === sourceFilePath) {
        continue;
      }

      try {
        const relativePath = relative(sourceDir, candidateFile);

        // Ensure we use forward slashes for cross-platform compatibility
        const normalizedPath = relativePath.replace(/\\/g, '/');

        // Add ./ prefix for relative paths that don't start with ../
        const finalPath = normalizedPath.startsWith('../') ? normalizedPath : `./${normalizedPath}`;

        suggestions.push(finalPath);
      } catch (error) {
      }
    }

    // Sort suggestions by "distance" - prefer shorter paths
    return suggestions.sort((a, b) => {
      const aDepth = (a.match(/\.\.\//g) || []).length;
      const bDepth = (b.match(/\.\.\//g) || []).length;

      if (aDepth !== bDepth) {
        return aDepth - bDepth; // Prefer fewer ../
      }

      return a.length - b.length; // Prefer shorter paths
    });
  }

  /**
   * Extract filename from a link path
   * @param linkHref The link path
   * @returns Filename or null if not extractable
   */
  private extractFilename(linkHref: string): string | null {
    // Remove query parameters and fragments
    const cleanHref = linkHref.split('?')[0]?.split('#')[0];

    if (!cleanHref) {
      return null;
    }

    // Extract the basename
    const filename = basename(cleanHref);

    // Must have an extension to be considered a file
    if (!filename.includes('.')) {
      return null;
    }

    return filename;
  }

  /**
   * Build a map of available files organized by filename
   * @param scanResults All scan results
   * @returns Map from lowercase filename to array of full file paths
   */
  private buildFileMap(scanResults: FileScanResult[]): Map<string, string[]> {
    const fileMap = new Map<string, string[]>();

    for (const scanResult of scanResults) {
      const filename = basename(scanResult.filePath).toLowerCase();

      if (!fileMap.has(filename)) {
        fileMap.set(filename, []);
      }

      fileMap.get(filename)?.push(scanResult.filePath);
    }

    return fileMap;
  }

  /**
   * Get statistics about link resolution
   * @param scanResults Resolved scan results
   * @returns Resolution statistics
   */
  getResolutionStats(scanResults: FileScanResult[]): {
    totalBrokenLinks: number;
    linksWithSuggestions: number;
    resolutionRate: number;
    averageSuggestionsPerLink: number;
    filesWithAutoFixableLinks: number;
  } {
    let totalBrokenLinks = 0;
    let linksWithSuggestions = 0;
    let totalSuggestions = 0;
    const filesWithAutoFixableLinks = new Set<string>();

    for (const scanResult of scanResults) {
      for (const brokenLink of scanResult.brokenLinks) {
        totalBrokenLinks++;

        if (brokenLink.suggestions.length > 0) {
          linksWithSuggestions++;
          totalSuggestions += brokenLink.suggestions.length;

          if (brokenLink.canAutoFix) {
            filesWithAutoFixableLinks.add(scanResult.filePath);
          }
        }
      }
    }

    return {
      totalBrokenLinks,
      linksWithSuggestions,
      resolutionRate: totalBrokenLinks > 0 ? (linksWithSuggestions / totalBrokenLinks) * 100 : 0,
      averageSuggestionsPerLink: linksWithSuggestions > 0 ? totalSuggestions / linksWithSuggestions : 0,
      filesWithAutoFixableLinks: filesWithAutoFixableLinks.size
    };
  }

  /**
   * Find the best suggestion for a broken link
   * @param brokenLink The broken link
   * @returns The best suggestion or null if none available
   */
  getBestSuggestion(brokenLink: BrokenLink): string | null {
    if (brokenLink.suggestions.length === 0) {
      return null;
    }

    // Return the first suggestion (they're already sorted by preference)
    return brokenLink.suggestions[0] || null;
  }

  /**
   * Check if a broken link has multiple suggestion options
   * @param brokenLink The broken link
   * @returns True if there are multiple suggestions
   */
  hasMultipleSuggestions(brokenLink: BrokenLink): boolean {
    return brokenLink.suggestions.length > 1;
  }

  /**
   * Group broken links by their target filename for bulk operations
   * @param brokenLinks Array of broken links
   * @returns Map from filename to array of broken links
   */
  groupByTargetFilename(brokenLinks: BrokenLink[]): Map<string, BrokenLink[]> {
    const groups = new Map<string, BrokenLink[]>();

    for (const brokenLink of brokenLinks) {
      const filename = this.extractFilename(brokenLink.link.href);

      if (filename) {
        const key = filename.toLowerCase();

        if (!groups.has(key)) {
          groups.set(key, []);
        }

        groups.get(key)?.push(brokenLink);
      }
    }

    return groups;
  }

  /**
   * Calculate the "fix confidence" for a suggestion
   * @param brokenLink The broken link
   * @param suggestion The suggested fix
   * @returns Confidence score between 0 and 1
   */
  calculateFixConfidence(brokenLink: BrokenLink, suggestion: string): number {
    const originalPath = brokenLink.link.href;
    const originalFilename = this.extractFilename(originalPath);
    const suggestedFilename = this.extractFilename(suggestion);

    if (!originalFilename || !suggestedFilename) {
      return 0;
    }

    // Exact filename match gives high confidence
    if (originalFilename.toLowerCase() === suggestedFilename.toLowerCase()) {
      // Bonus for similar directory structure
      const originalDirs = originalPath.split('/').slice(0, -1);
      const suggestedDirs = suggestion.split('/').slice(0, -1);

      const commonDirs = originalDirs.filter(dir => suggestedDirs.includes(dir));
      const directoryBonus = commonDirs.length / Math.max(originalDirs.length, 1);

      return Math.min(0.8 + directoryBonus * 0.2, 1.0);
    }

    // Partial filename match
    const similarity = this.calculateStringSimilarity(originalFilename, suggestedFilename);
    return similarity * 0.6; // Max 60% confidence for partial matches
  }

  /**
  * Calculate string similarity between two strings using simple character matching
  * @param str1 First string
  * @param str2 Second string
  * @returns Similarity score between 0 and 1
  */
  private calculateStringSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    // Simple character overlap calculation
    let matchingChars = 0;
    for (let i = 0; i < shorter.length; i++) {
      const char = shorter.charAt(i);
      if (char && longer.includes(char)) {
        matchingChars++;
      }
    }

    return matchingChars / longer.length;
  }

  /**
   * Find local links in markdown content
   * @param content Markdown content to parse for local links
   * @param basePath Base path for resolving relative links
   * @returns Array of local links found in the content
   */
  static findLocalLinks(content: string, basePath: string): LocalLink[] {
    // Input validation
    if (!content || typeof content !== 'string') {
      return [];
    }

    if (!basePath || typeof basePath !== 'string') {
      return [];
    }

    const localLinks: LocalLink[] = [];

    // Use shared regex for markdown links
    const linkRegex = newMarkdownLinkRegex();
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(content)) !== null) {
      const fullMatch = match[0] || '';
      const text = match[1] || '';
      const path = match[2] || '';
      const startIndex = match.index ?? 0;

      // Only process local links (not external URLs)
      if (LinkResolver.isLocalPath(path)) {
        const resolvedPath = LinkResolver.resolveLocalPath(path, basePath);

        localLinks.push({
          text,
          originalPath: path,
          resolvedPath,
          isPublished: false, // Will be determined by caller
          fullMatch,
          startIndex,
          endIndex: startIndex + fullMatch.length
        });
      }
    }

    return localLinks;
  }

  /**
   * Check if a path is a local path (not an external URL)
   * @param path Path to check
   * @returns True if path is local, false if external
   */
  private static isLocalPath(path: string): boolean {
    if (!path || typeof path !== 'string') {
      return false;
    }

    // Check if it's not an external URL
    return !path.match(/^https?:\/\//) &&
      !path.match(/^mailto:/) &&
      !path.match(/^tel:/) &&
      !path.match(/^ftp:/) &&
      !path.match(/^ftps:/);
  }

  /**
  * Resolve a relative path to absolute path
  * @param relativePath Relative path to resolve
  * @param basePath Base path for resolution (can be file or directory path)
  * @returns Absolute path
  */
  private static resolveLocalPath(relativePath: string, basePath: string): string {
    try {
      return LinkResolver.pathResolverInstance.resolve(basePath, relativePath);
    } catch (error) {
      // If resolution fails, return the original path
      return relativePath;
    }
  }

  /**
   * Filter LocalLink array to include only links to markdown files
   * @param links Array of LocalLink objects to filter
   * @returns Filtered array containing only links to .md files
   */
  static filterMarkdownLinks(links: LocalLink[]): LocalLink[] {
    // Input validation
    if (!Array.isArray(links)) {
      return [];
    }

    return links.filter(link => {
      // Validate link object structure
      if (!link || typeof link !== 'object' || !link.resolvedPath) {
        return false;
      }

      // Check if the resolved path points to a markdown file (shared util)
      return isMarkdownFilePath(link.resolvedPath);
    });
  }

  /**
   * Extract unique file paths from LocalLink array
   * @param links Array of LocalLink objects
   * @returns Array of unique file paths
   */
  static getUniqueFilePaths(links: LocalLink[]): string[] {
    // Input validation
    if (!Array.isArray(links)) {
      return [];
    }

    // Use Set for efficient deduplication
    const uniquePaths = new Set<string>();

    for (const link of links) {
      // Validate link object structure
      if (link && typeof link === 'object' && link.resolvedPath && typeof link.resolvedPath === 'string') {
        uniquePaths.add(link.resolvedPath);
      }
    }

    // Convert Set to Array for return
    return Array.from(uniquePaths);
  }

  /**
   * Replace local Markdown links in content with Telegraph URLs
   * @param content Markdown content string
   * @param linkMappings Map where keys are original local paths and values are Telegraph URLs
   * @returns Content string with local links replaced by Telegraph URLs
   */
  static replaceLocalLinks(content: string, linkMappings: Map<string, string>): string {
    // Input validation
    if (!content || typeof content !== 'string') {
      return '';
    }

    if (!linkMappings || !(linkMappings instanceof Map) || linkMappings.size === 0) {
      return content;
    }

    // Use shared markdown link regex
    const linkRegex = newMarkdownLinkRegex();

    // Replace links using callback function
    return content.replace(linkRegex, (fullMatch: string, linkText: string, linkPath: string) => {
      // Check if this link path has a mapping to a Telegraph URL
      const telegraphUrl = linkMappings.get(linkPath);

      if (telegraphUrl) {
        // Replace with Telegraph URL
        return `[${linkText}](${telegraphUrl})`;
      }

      // No mapping found, return original link unchanged
      return fullMatch;
    });
  }

  /**
   * Validate if a link target exists
   * @param filePath Path to the link target
   * @returns True if link target exists
   */
  static validateLinkTarget(filePath: string): boolean {
    try {
      return existsSync(filePath);
    } catch {
      return false;
    }
  }

  /**
   * Check if a file is a markdown file
   * @param filePath Path to check
   * @returns True if file is markdown
   */
  static isMarkdownFile(filePath: string): boolean {
    return isMarkdownFilePath(filePath);
  }
}