/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0). Extracted and trimmed
 * to the self-contained EPUB export closure for AI Focused Editor.
 */
import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { LinkResolver } from "./LinkResolver";
import { MetadataManager } from "./MetadataManager";
import type { FileMetadata, LocalLink, ProcessedContent } from "./metadata-types";

/**
 * Processes content for publication with link replacement and metadata handling
 */
export class ContentProcessor {

  /**
   * Remove duplicate title from content if it matches metadata title
   * @param content Content to process
   * @param metadataTitle Title from metadata
   * @returns Content with duplicate title removed if necessary
   */
  static removeDuplicateTitle(content: string, metadataTitle?: string): string {
    if (!metadataTitle) {
      return content;
    }

    // Normalize titles for comparison (remove extra spaces, convert to lowercase)
    const normalizedMetadataTitle = metadataTitle.trim().toLowerCase();

    // Split content into lines and find first non-empty line
    const lines = content.split(/\r?\n/);
    let headerLineIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.trim() === '') continue; // Skip empty lines

      // Check if this line is an h1 header
      const h1Match = line.match(/^\s*#\s+(.+?)$/);
      if (h1Match && h1Match[1]) {
        const contentTitle = h1Match[1].trim().toLowerCase();

        // If titles match, mark for removal
        if (normalizedMetadataTitle === contentTitle) {
          headerLineIndex = i;
        }
      }
      break; // Only check first non-empty line
    }

    // If we found a matching header, remove it
    if (headerLineIndex >= 0) {
      lines.splice(headerLineIndex, 1);

      // Remove any empty lines that follow the removed header
      while (headerLineIndex < lines.length) {
        const currentLine = lines[headerLineIndex];
        if (currentLine && currentLine.trim() === '') {
          lines.splice(headerLineIndex, 1);
        } else {
          break;
        }
      }

      return lines.join('\n');
    }

    return content;
  }

  /**
   * Process file content for publication
   * @param filePath Path to file to process
   * @returns Processed content information
   */
  static processFile(filePath: string): ProcessedContent {
    try {
      // Check if path is a directory
      try {
        const stats = lstatSync(filePath);
        if (stats.isDirectory()) {
          throw new Error(`Cannot process directory as file: ${filePath}`);
        }
      } catch (error) {
        // If we can't stat the path, try decoding and check again
        try {
          const decodedPath = decodeURIComponent(filePath);
          const stats = lstatSync(decodedPath);
          if (stats.isDirectory()) {
            throw new Error(`Cannot process directory as file: ${decodedPath}`);
          }
        } catch {
          // Path doesn't exist, will be handled by readFileSync below
        }
      }

      // Try the path as-is first
      let originalContent: string;
      try {
        originalContent = readFileSync(filePath, 'utf-8');
      } catch (error) {
        // Try decoding URL-encoded characters
        const decodedPath = decodeURIComponent(filePath);
        originalContent = readFileSync(decodedPath, 'utf-8');
      }
      return ContentProcessor.processContent(originalContent, filePath);
    } catch (error) {
      console.error(`Error reading file ${filePath}:`, error);
      throw new Error(`Failed to read file: ${filePath}`);
    }
  }

  /**
   * Process content string for publication
   * @param content Content to process
   * @param basePath Base path for resolving relative links
   * @returns Processed content information
   */
  static processContent(content: string, basePath: string): ProcessedContent {
    // Extract metadata if present
    const metadata = MetadataManager.parseMetadata(content);

    // Remove metadata from content
    let contentWithoutMetadata = MetadataManager.removeMetadata(content);

    // Remove duplicate title if it matches metadata title
    contentWithoutMetadata = ContentProcessor.removeDuplicateTitle(contentWithoutMetadata, metadata?.title);

    // Find local links
    const localLinks = LinkResolver.findLocalLinks(contentWithoutMetadata, basePath);

    // Initially, content with replaced links is same as original
    // Will be modified by replaceLinksInContent method
    const contentWithReplacedLinks = contentWithoutMetadata;

    return {
      originalContent: content,
      contentWithoutMetadata,
      contentWithReplacedLinks,
      contentWithLocalLinks: contentWithoutMetadata, // Initially same as without metadata
      metadata: metadata || undefined,
      localLinks,
      telegraphLinks: [], // Will be populated when links are replaced
      hasChanges: localLinks.length > 0
    };
  }

  /**
   * Replace local links in processed content with Telegraph URLs
   * @param processedContent Previously processed content
   * @param linkMappings Map of local paths to Telegraph URLs
   * @returns Updated processed content with replaced links
   */
  static replaceLinksInContent(
    processedContent: ProcessedContent,
    linkMappings: Map<string, string>
  ): ProcessedContent {
    // Create mapping from original paths to Telegraph URLs
    const replacementMap = new Map<string, string>();

    for (const link of processedContent.localLinks) {
      // Look up by resolved absolute path (without anchor), as provided by caller
      const anchorPosResolved = link.resolvedPath.indexOf('#');
      const resolvedFileOnly = anchorPosResolved !== -1 ? link.resolvedPath.substring(0, anchorPosResolved) : link.resolvedPath;
      const telegraphBase = linkMappings.get(resolvedFileOnly);
      
      if (telegraphBase) {
        // Preserve the anchor from the original markdown path if present
        const originalAnchorIndex = link.originalPath.indexOf('#');
        let finalUrl = telegraphBase;

        if (originalAnchorIndex !== -1) {
          const anchor = link.originalPath.substring(originalAnchorIndex);
          finalUrl += anchor;
        }

        // Map the original markdown path to the final Telegraph URL
        replacementMap.set(link.originalPath, finalUrl);
        // Update link object
        link.telegraphUrl = finalUrl;
        link.isPublished = true;
      }
    }

    // Replace links in content
    const contentWithReplacedLinks = LinkResolver.replaceLocalLinks(
      processedContent.contentWithoutMetadata,
      replacementMap
    );

    return {
      ...processedContent,
      contentWithReplacedLinks,
      // Preserve full localLinks array and mark published links in-place
      localLinks: processedContent.localLinks,
      hasChanges: replacementMap.size > 0
    };
  }

  /**
   * Prepare content for Telegraph publication
   * @param processedContent Processed content with replaced links
   * @returns Content ready for Telegraph API
   */
  static prepareForPublication(processedContent: ProcessedContent): string {
    return processedContent.contentWithReplacedLinks;
  }

  /**
   * Create content with injected metadata
   * @param processedContent Original processed content
   * @param metadata Metadata to inject
   * @returns Content with metadata injected
   */
  static injectMetadataIntoContent(
    processedContent: ProcessedContent,
    metadata: FileMetadata
  ): string {
    return MetadataManager.injectMetadata(
      processedContent.contentWithoutMetadata,
      metadata
    );
  }

  /**
   * Validate processed content for publication
   * @param processedContent Content to validate
   * @param options Validation options
   * @returns Validation result with any issues found
   */
  static validateContent(processedContent: ProcessedContent, options: {
    allowBrokenLinks?: boolean;
    allowUnpublishedDependencies?: boolean;
  } = {}): {
    isValid: boolean;
    issues: string[];
  } {
    const issues: string[] = [];

    // Check for broken local links (only if not allowed)
    if (!options.allowBrokenLinks) {
      const brokenLinks = processedContent.localLinks.filter(link => {
        // Extract file path without anchor from resolvedPath for validation
        const anchorIndex = link.resolvedPath.indexOf('#');
        const filePathOnly = anchorIndex !== -1 ? link.resolvedPath.substring(0, anchorIndex) : link.resolvedPath;
        return !LinkResolver.validateLinkTarget(filePathOnly);
      });

      if (brokenLinks.length > 0) {
        issues.push(`Broken local links found: ${brokenLinks.map(l => l.originalPath).join(', ')}`);
      }
    }

    // Check for unpublished dependencies (only if not allowed)
    if (!options.allowUnpublishedDependencies) {
      const unpublishedLinks = processedContent.localLinks.filter(link =>
        !link.isPublished && LinkResolver.isMarkdownFile(link.resolvedPath)
      );

      if (unpublishedLinks.length > 0) {
        issues.push(`Unpublished dependencies: ${unpublishedLinks.map(l => l.originalPath).join(', ')}`);
      }
    }

    // Check content length
    if (processedContent.contentWithReplacedLinks.trim().length === 0) {
      issues.push('Content is empty after processing');
    }

    return {
      isValid: issues.length === 0,
      issues
    };
  }

  /**
   * Get content statistics
   * @param processedContent Content to analyze
   * @returns Content statistics
   */
  static getContentStats(processedContent: ProcessedContent): {
    originalLength: number;
    processedLength: number;
    localLinksCount: number;
    markdownLinksCount: number;
    replacedLinksCount: number;
    hasMetadata: boolean;
  } {
    const markdownLinks = LinkResolver.filterMarkdownLinks(processedContent.localLinks);
    const replacedLinks = processedContent.localLinks.filter(link => link.isPublished);

    return {
      originalLength: processedContent.originalContent.length,
      processedLength: processedContent.contentWithReplacedLinks.length,
      localLinksCount: processedContent.localLinks.length,
      markdownLinksCount: markdownLinks.length,
      replacedLinksCount: replacedLinks.length,
      hasMetadata: processedContent.metadata !== null && processedContent.metadata !== undefined
    };
  }

  /**
   * Create a copy of processed content for safe modification
   * @param processedContent Content to clone
   * @returns Deep copy of processed content
   */
  static cloneProcessedContent(processedContent: ProcessedContent): ProcessedContent {
    return {
      originalContent: processedContent.originalContent,
      contentWithoutMetadata: processedContent.contentWithoutMetadata,
      contentWithReplacedLinks: processedContent.contentWithReplacedLinks,
      contentWithLocalLinks: processedContent.contentWithLocalLinks,
      metadata: processedContent.metadata ? { ...processedContent.metadata } : processedContent.metadata,
      localLinks: processedContent.localLinks.map(link => ({ ...link })),
      telegraphLinks: processedContent.telegraphLinks.map(link => ({ ...link })),
      hasChanges: processedContent.hasChanges
    };
  }

  /**
   * Extract title from processed content
   * @param processedContent Content to extract title from
   * @returns Extracted title or null
   */
  static extractTitle(processedContent: ProcessedContent): string | null {
    // First check metadata
    if (processedContent.metadata?.title) {
      return processedContent.metadata.title;
    }

    // Then check content for first heading
    const content = processedContent.contentWithoutMetadata;
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      // Check for markdown heading
      const headingMatch = trimmed.match(/^(#+)\s*(.*)/);
      if (headingMatch && headingMatch[2]) {
        return headingMatch[2].trim();
      }

      // Check for bold/italic that could be a title
      const boldMatch = trimmed.match(/^(?:\*{2}|__)(.*?)(?:\*{2}|__)$/);
      if (boldMatch && boldMatch[1]) {
        return boldMatch[1].trim();
      }

      // First non-empty line could be title if short enough
      if (trimmed.length <= 100 && !trimmed.includes('\n')) {
        return trimmed;
      }

      break; // Only check first non-empty line
    }

    return null;
  }

  /**
   * Calculates SHA-256 hash of content for change detection.
   * This method provides a centralized, robust approach for content hashing
   * used by both the publisher and anchor cache systems.
   * @param content The content to hash (should be without metadata for consistent results)
   * @returns Hex-encoded SHA-256 hash, or empty string on error for fail-safe behavior
   */
  public static calculateContentHash(content: string): string {
    try {
      return createHash('sha256').update(content, 'utf8').digest('hex');
    } catch (error) {
      console.warn('Content hash calculation failed:', error);
      // Return empty string to trigger re-parsing as a fail-safe
      return '';
    }
  }
}