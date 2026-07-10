/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0). Extracted and trimmed
 * to the self-contained EPUB export closure for AI Focused Editor.
 */
import { lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { FileMetadata, PublicationStatus } from "./metadata-types";
import { PublicationStatus as Status } from "./metadata-types";

/**
 * Manages YAML front-matter metadata in markdown files
 */
export class MetadataManager {
  private static readonly FRONTMATTER_DELIMITER = "---";
  private static readonly YAML_INDENT = "  ";

  /**
   * Parse metadata from file content
   * @param content File content with potential YAML front-matter
   * @returns Parsed metadata or null if none found
   */
  static parseMetadata(content: string): FileMetadata | null {
    const lines = content.split(/\r?\n/);

    // Check if file starts with front-matter delimiter
    if (lines.length < 3 || lines[0]?.trim() !== MetadataManager.FRONTMATTER_DELIMITER) {
      return null;
    }

    // Find closing delimiter
    let closingIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === MetadataManager.FRONTMATTER_DELIMITER) {
        closingIndex = i;
        break;
      }
    }

    if (closingIndex === -1) {
      return null;
    }

    // Extract YAML content
    const yamlLines = lines.slice(1, closingIndex);
    const yamlContent = yamlLines.join('\n');

    try {
      return MetadataManager.parseYamlMetadata(yamlContent);
    } catch (error) {
      console.warn('Failed to parse YAML metadata:', error);
      return null;
    }
  }

  /**
   * Parse YAML metadata content
   * @param yamlContent Raw YAML content
   * @returns Parsed metadata
   */
  private static parseYamlMetadata(yamlContent: string): FileMetadata | null {
    const metadata: Partial<FileMetadata> = {};
    const lines = yamlContent.split(/\r?\n/);
    let currentKey: string | null = null;
    let currentObject: Record<string, string> | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Handle indented object properties for publishedDependencies
      if (currentKey === 'publishedDependencies' && currentObject && line.startsWith('  ')) {
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex !== -1) {
          const objKey = trimmed.substring(0, colonIndex).trim();
          const objValue = trimmed.substring(colonIndex + 1).trim().replace(/^["']|["']$/g, '');
          currentObject[objKey] = objValue;
        }
        continue;
      }

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const key = trimmed.substring(0, colonIndex).trim();
      const value = trimmed.substring(colonIndex + 1).trim().replace(/^["']|["']$/g, '');

      // Reset object parsing state for new top-level keys
      if (currentKey && currentKey !== key) {
        if (currentKey === 'publishedDependencies' && currentObject) {
          metadata.publishedDependencies = currentObject;
        }
        currentKey = null;
        currentObject = null;
      }

      switch (key) {
        case 'telegraphUrl':
          metadata.telegraphUrl = value;
          break;
        case 'editPath':
          metadata.editPath = value;
          break;
        case 'username':
          metadata.username = value;
          break;
        case 'publishedAt':
          metadata.publishedAt = value;
          break;
        case 'originalFilename':
          metadata.originalFilename = value;
          break;
        case 'title':
          metadata.title = value;
          break;
        case 'description':
          metadata.description = value;
          break;
        case 'contentHash':
          metadata.contentHash = value;
          break;
        case 'gistId':
          metadata.gistId = value;
          break;
        case 'gistUrl':
          metadata.gistUrl = value;
          break;
        case 'gistFilename':
          metadata.gistFilename = value;
          break;
        case 'gistPublic':
          metadata.gistPublic = value.toLowerCase() === 'true';
          break;
        case 'gistUpdatedAt':
          metadata.gistUpdatedAt = value;
          break;
        case 'accessToken':
          metadata.accessToken = value;
          break;
        case 'tokenSource':
          metadata.tokenSource = value as 'metadata' | 'cache' | 'config' | 'session' | 'backfilled';
          break;
        case 'tokenUpdatedAt':
          metadata.tokenUpdatedAt = value;
          break;
        case 'publishedDependencies':
          // Initialize object parsing for publishedDependencies
          currentKey = 'publishedDependencies';
          currentObject = {};
          // If there's a value on the same line (shouldn't happen but handle gracefully)
          if (value && value !== '') {
            try {
              metadata.publishedDependencies = JSON.parse(value);
            } catch {
              // If not valid JSON, treat as empty object and parse following lines
              currentObject = {};
            }
          }
          break;
      }
    }

    // Handle final object if parsing ended while in object mode
    if (currentKey === 'publishedDependencies' && currentObject) {
      metadata.publishedDependencies = currentObject;
    }

    // Return metadata if any fields were found
    if (Object.keys(metadata).length > 0) {
      return metadata as FileMetadata;
    }

    return null;
  }

  /**
   * Inject metadata into file content
   * @param content Original file content
   * @param metadata Metadata to inject
   * @returns Content with injected metadata
   */
  static injectMetadata(content: string, metadata: FileMetadata): string {
    const yamlContent = MetadataManager.serializeMetadata(metadata);
    const contentWithoutExistingMetadata = MetadataManager.removeMetadata(content);

    return `${MetadataManager.FRONTMATTER_DELIMITER}\n${yamlContent}\n${MetadataManager.FRONTMATTER_DELIMITER}\n\n${contentWithoutExistingMetadata}`;
  }

  /**
   * Update existing metadata in file content
   * @param content File content with existing metadata
   * @param metadata New metadata to update
   * @returns Content with updated metadata
   */
  static updateMetadata(content: string, metadata: FileMetadata): string {
    return MetadataManager.injectMetadata(content, metadata);
  }

  /**
   * Remove metadata from file content
   * @param content File content with potential metadata
   * @returns Content without metadata
   */
  static removeMetadata(content: string): string {
    const lines = content.split(/\r?\n/);

    // Check if file starts with front-matter delimiter
    if (lines.length < 3 || lines[0]?.trim() !== MetadataManager.FRONTMATTER_DELIMITER) {
      return content;
    }

    // Find closing delimiter
    let closingIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === MetadataManager.FRONTMATTER_DELIMITER) {
        closingIndex = i;
        break;
      }
    }

    if (closingIndex === -1) {
      return content;
    }

    // Validate that there's actual YAML content between delimiters
    const yamlLines = lines.slice(1, closingIndex);
    let hasValidYaml = false;

    for (const line of yamlLines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes(':')) {
        hasValidYaml = true;
        break;
      }
    }

    // If no valid YAML found, this is probably an HR tag, not front-matter
    if (!hasValidYaml) {
      return content;
    }

    // Return content after closing delimiter, removing empty lines at start
    const remainingLines = lines.slice(closingIndex + 1);
    while (remainingLines.length > 0 && remainingLines[0]?.trim() === '') {
      remainingLines.shift();
    }

    return remainingLines.join('\n');
  }

  /**
   * Upsert gist metadata in YAML front-matter while preserving existing fields.
   * Creates front-matter when it does not exist.
   */
  static upsertGistMetadata(content: string, gistData: {
    gistId: string;
    gistUrl: string;
    gistFilename: string;
    gistPublic: boolean;
    gistUpdatedAt?: string;
  }): string {
    const lines = content.split(/\r?\n/);
    const updatedAt = gistData.gistUpdatedAt ?? new Date().toISOString();

    const hasFrontMatterStart = lines[0]?.trim() === MetadataManager.FRONTMATTER_DELIMITER;
    let closingIndex = -1;

    if (hasFrontMatterStart) {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === MetadataManager.FRONTMATTER_DELIMITER) {
          closingIndex = i;
          break;
        }
      }
    }

    const hasValidYaml =
      closingIndex !== -1 &&
      lines
        .slice(1, closingIndex)
        .some((line) => {
          const trimmed = line.trim();
          return trimmed.length > 0 && !trimmed.startsWith("#") && trimmed.includes(":");
        });

    const gistIdLine = `gistId: ${MetadataManager.quoteYaml(gistData.gistId)}`;
    const gistUrlLine = `gistUrl: ${MetadataManager.quoteYaml(gistData.gistUrl)}`;
    const gistFilenameLine = `gistFilename: ${MetadataManager.quoteYaml(gistData.gistFilename)}`;
    const gistPublicLine = `gistPublic: ${gistData.gistPublic ? "true" : "false"}`;
    const gistUpdatedAtLine = `gistUpdatedAt: ${MetadataManager.quoteYaml(updatedAt)}`;

    if (hasFrontMatterStart && hasValidYaml && closingIndex !== -1) {
      const frontMatterLines = lines.slice(1, closingIndex);
      const bodyLines = lines.slice(closingIndex + 1);

      MetadataManager.upsertYamlKey(frontMatterLines, "gistId", gistIdLine);
      MetadataManager.upsertYamlKey(frontMatterLines, "gistUrl", gistUrlLine);
      MetadataManager.upsertYamlKey(frontMatterLines, "gistFilename", gistFilenameLine);
      MetadataManager.upsertYamlKey(frontMatterLines, "gistPublic", gistPublicLine);
      MetadataManager.upsertYamlKey(frontMatterLines, "gistUpdatedAt", gistUpdatedAtLine);

      const body = bodyLines.join("\n");
      return `${MetadataManager.FRONTMATTER_DELIMITER}\n${frontMatterLines.join("\n")}\n${MetadataManager.FRONTMATTER_DELIMITER}${body.length > 0 ? `\n${body}` : ""}`;
    }

    const gistLines = [gistIdLine, gistUrlLine, gistFilenameLine, gistPublicLine, gistUpdatedAtLine];

    if (content.trim().length === 0) {
      return `${MetadataManager.FRONTMATTER_DELIMITER}\n${gistLines.join("\n")}\n${MetadataManager.FRONTMATTER_DELIMITER}`;
    }

    return `${MetadataManager.FRONTMATTER_DELIMITER}\n${gistLines.join("\n")}\n${MetadataManager.FRONTMATTER_DELIMITER}\n\n${content}`;
  }

  /**
   * Validate metadata integrity
   * @param metadata Metadata to validate
   * @returns True if metadata is valid
   */
  static validateMetadata(metadata: FileMetadata | null): boolean {
    if (!metadata) return false;

    // Check required fields
    if (!metadata.telegraphUrl || !metadata.editPath || !metadata.username ||
      !metadata.publishedAt || !metadata.originalFilename) {
      return false;
    }

    // Validate URL format
    try {
      new URL(metadata.telegraphUrl);
    } catch {
      return false;
    }

    // Validate timestamp format
    if (isNaN(Date.parse(metadata.publishedAt))) {
      return false;
    }

    return true;
  }

  /**
   * Determine publication status of file
   * @param filePath Path to file to check
   * @returns Publication status
   */
  static getPublicationStatus(filePath: string): PublicationStatus {
    try {
      // Check if path is a directory
      try {
        const stats = lstatSync(filePath);
        if (stats.isDirectory()) {
          return Status.METADATA_MISSING;
        }
      } catch (error) {
        // If we can't stat the path, try decoding and check again
        try {
          const decodedPath = decodeURIComponent(filePath);
          const stats = lstatSync(decodedPath);
          if (stats.isDirectory()) {
            return Status.METADATA_MISSING;
          }
        } catch {
          // Path doesn't exist or can't be accessed
          return Status.METADATA_MISSING;
        }
      }

      // Try the path as-is first
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch (error) {
        // Try decoding URL-encoded characters
        const decodedPath = decodeURIComponent(filePath);
        content = readFileSync(decodedPath, 'utf-8');
      }

      const metadata = MetadataManager.parseMetadata(content);

      if (!metadata) {
        return Status.NOT_PUBLISHED;
      }

      if (MetadataManager.validateMetadata(metadata)) {
        return Status.PUBLISHED;
      } else {
        return Status.METADATA_CORRUPTED;
      }
    } catch (error) {
      console.error(`Error reading file ${filePath}:`, error);
      return Status.METADATA_MISSING;
    }
  }

  /**
   * Get publication info from file
   * @param filePath Path to file
   * @returns Metadata if file is published, null otherwise
   */
  static getPublicationInfo(filePath: string): FileMetadata | null {
    try {
      // Check if path is a directory
      try {
        const stats = lstatSync(filePath);
        if (stats.isDirectory()) {
          return null;
        }
      } catch (error) {
        // If we can't stat the path, try decoding and check again
        try {
          const decodedPath = decodeURIComponent(filePath);
          const stats = lstatSync(decodedPath);
          if (stats.isDirectory()) {
            return null;
          }
        } catch {
          // Path doesn't exist or can't be accessed
          return null;
        }
      }

      // Try the path as-is first
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch (error) {
        // Try decoding URL-encoded characters
        const decodedPath = decodeURIComponent(filePath);
        content = readFileSync(decodedPath, 'utf-8');
      }

      return MetadataManager.parseMetadata(content);
    } catch (error) {
      console.error(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Check if file is published
   * @param filePath Path to file to check
   * @returns True if file has valid metadata
   */
  static isPublished(filePath: string): boolean {
    return MetadataManager.getPublicationStatus(filePath) === Status.PUBLISHED;
  }

  /**
   * Create metadata object from page info with optional accessToken
   * @param url Telegraph page URL
   * @param path Telegraph edit path
   * @param username Username
   * @param filePath Local file path
   * @param contentHash Content hash
   * @param title Optional title
   * @param description Optional description
   * @param accessToken Optional access token
   * @returns FileMetadata object
   */
  static createMetadata(
    url: string,
    path: string,
    username: string,
    filePath: string,
    contentHash: string,
    title?: string,
    description?: string,
    accessToken?: string,
    publishedDependencies?: Record<string, string>
  ): FileMetadata {
    return {
      telegraphUrl: url,
      editPath: path,
      username,
      publishedAt: new Date().toISOString(),
      originalFilename: basename(filePath),
      title,
      description,
      contentHash,
      accessToken,
      publishedDependencies
    };
  }

  /**
   * Create enhanced metadata with token source tracking (Creative Enhancement)
   * @param url Telegraph page URL
   * @param path Telegraph edit path
   * @param username Username
   * @param filePath Local file path
   * @param contentHash Content hash
   * @param accessToken Access token used
   * @param tokenSource Source of the access token
   * @param title Optional title
   * @param description Optional description
   * @returns FileMetadata object with enhanced diagnostics
   */
  static createEnhancedMetadata(
    url: string,
    path: string,
    username: string,
    filePath: string,
    contentHash: string,
    accessToken: string,
    tokenSource: 'metadata' | 'cache' | 'config' | 'session' | 'backfilled',
    title?: string,
    description?: string,
    publishedDependencies?: Record<string, string>
  ): FileMetadata {
    return {
      telegraphUrl: url,
      editPath: path,
      username,
      publishedAt: new Date().toISOString(),
      originalFilename: basename(filePath),
      title,
      description,
      contentHash,
      accessToken,
      tokenSource,
      tokenUpdatedAt: new Date().toISOString(),
      publishedDependencies
    };
  }

  /**
   * Serialize metadata to YAML format
   * @param metadata Metadata to serialize
   * @returns YAML string
   */
  private static serializeMetadata(metadata: FileMetadata): string {
    const lines: string[] = [];

    lines.push(`telegraphUrl: "${metadata.telegraphUrl}"`);
    lines.push(`editPath: "${metadata.editPath}"`);
    lines.push(`username: "${metadata.username}"`);
    lines.push(`publishedAt: "${metadata.publishedAt}"`);
    lines.push(`originalFilename: "${metadata.originalFilename}"`);

    if (metadata.title) {
      lines.push(`title: "${metadata.title}"`);
    }

    if (metadata.description) {
      lines.push(`description: "${metadata.description}"`);
    }

    if (metadata.contentHash) {
      lines.push(`contentHash: "${metadata.contentHash}"`);
    }

    if (metadata.gistId) {
      lines.push(`gistId: "${metadata.gistId}"`);
    }

    if (metadata.gistUrl) {
      lines.push(`gistUrl: "${metadata.gistUrl}"`);
    }

    if (metadata.gistFilename) {
      lines.push(`gistFilename: "${metadata.gistFilename}"`);
    }

    if (metadata.gistPublic !== undefined) {
      lines.push(`gistPublic: ${metadata.gistPublic ? "true" : "false"}`);
    }

    if (metadata.gistUpdatedAt) {
      lines.push(`gistUpdatedAt: "${metadata.gistUpdatedAt}"`);
    }

    if (metadata.accessToken) {
      lines.push(`accessToken: "${metadata.accessToken}"`);
    }

    // Creative Enhancement: Token diagnostic metadata
    if (metadata.tokenSource) {
      lines.push(`tokenSource: "${metadata.tokenSource}"`);
    }

    if (metadata.tokenUpdatedAt) {
      lines.push(`tokenUpdatedAt: "${metadata.tokenUpdatedAt}"`);
    }

    // Enhanced Addition: Published Dependencies object serialization
    if (metadata.publishedDependencies && Object.keys(metadata.publishedDependencies).length > 0) {
      lines.push('publishedDependencies:');
      // Sort keys for consistent output
      const sortedKeys = Object.keys(metadata.publishedDependencies).sort();
      for (const key of sortedKeys) {
        const value = metadata.publishedDependencies[key];
        if (value) {
          lines.push(`  ${key}: "${value}"`);
        }
      }
    }

    return lines.join('\n');
  }

  private static quoteYaml(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  private static upsertYamlKey(lines: string[], key: string, fullLine: string): void {
    const keyPrefix = `${key}:`;
    const index = lines.findIndex((line) => line.trim().startsWith(keyPrefix));
    if (index !== -1) {
      lines[index] = fullLine;
      return;
    }

    lines.push(fullLine);
  }

  /**
 * Reset metadata preserving only title
 * @param content File content with potential metadata
 * @param filePath Optional file path for title extraction fallback
 * @returns Content with only title metadata preserved
 */
  static resetMetadata(content: string, filePath?: string): string {
    // Parse existing metadata
    const existingMetadata = MetadataManager.parseMetadata(content);

    // Remove all existing metadata
    const contentWithoutMetadata = MetadataManager.removeMetadata(content);

    // Extract title from multiple sources
    const title = MetadataManager.extractBestTitle(content, existingMetadata, filePath);

    // If title exists, create minimal front-matter with only title
    if (title) {
      return MetadataManager.injectTitleOnlyMetadata(contentWithoutMetadata, title);
    }

    // Return clean content without any front-matter
    return contentWithoutMetadata;
  }

  /**
   * Inject only title metadata into content
   * @param content Content without metadata
   * @param title Title to inject
   * @returns Content with title-only front-matter
   */
  private static injectTitleOnlyMetadata(content: string, title: string): string {
    const titleYaml = `title: "${title}"`;

    // If content is empty or only whitespace, don't add extra newlines
    if (!content.trim()) {
      return `${MetadataManager.FRONTMATTER_DELIMITER}\n${titleYaml}\n${MetadataManager.FRONTMATTER_DELIMITER}`;
    }

    return `${MetadataManager.FRONTMATTER_DELIMITER}\n${titleYaml}\n${MetadataManager.FRONTMATTER_DELIMITER}\n\n${content}`;
  }

  /**
 * Extract the best available title from multiple sources
 * @param content File content
 * @param existingMetadata Parsed metadata from front-matter
 * @param filePath Optional file path for filename-based title
 * @returns Best available title or null
 */
  private static extractBestTitle(
    content: string,
    existingMetadata: FileMetadata | null,
    filePath?: string
  ): string | null {
    // 1. Try existing front-matter title first (always prefer if exists)
    if (existingMetadata?.title) {
      return existingMetadata.title;
    }

    // 2. Try extracting from first markdown heading
    const markdownTitle = MetadataManager.extractMarkdownTitle(content);
    if (markdownTitle) {
      return markdownTitle;
    }

    // 3. Try extracting from filename
    if (filePath) {
      const filenameTitle = MetadataManager.extractFilenameTitle(filePath);
      if (filenameTitle) {
        return filenameTitle;
      }
    }

    return null;
  }

  /**
   * Extract title from first markdown heading
   * @param content File content
   * @returns Title from first H1 heading or null
   */
  private static extractMarkdownTitle(content: string): string | null {
    // Remove front-matter first
    const contentWithoutMetadata = MetadataManager.removeMetadata(content);
    const lines = contentWithoutMetadata.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) {
        const title = trimmed.substring(2).trim();
        if (title) {
          return title;
        }
      }
    }

    return null;
  }

  /**
   * Extract title from filename
   * @param filePath File path
   * @returns Title derived from filename or null
   */
  private static extractFilenameTitle(filePath: string): string | null {
    const filename = basename(filePath, '.md');

    // Convert filename to readable title
    const title = filename
      .replace(/[-_]/g, ' ') // Replace dashes and underscores with spaces
      .replace(/\b\w/g, l => l.toUpperCase()) // Capitalize first letter of each word
      .trim();

    // Return title if it's meaningful (more than just numbers or single characters)
    if (title.length > 2 && !/^\d+$/.test(title)) {
      return title;
    }

    return null;
  }
}
