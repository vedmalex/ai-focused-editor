/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0). Extracted to the
 * self-contained EPUB export closure for AI Focused Editor.
 */

/**
 * Core types and interfaces for the link verification system
 */

/**
 * Represents a Markdown link found in a file
 */
export interface MarkdownLink {
  /** The display text of the link */
  text: string;
  /** The original path/URL in the link */
  href: string;
  /** Line number where the link was found (1-based) */
  lineNumber: number;
  /** Character position in the line where link starts */
  columnStart: number;
  /** Character position in the line where link ends */
  columnEnd: number;
}

/**
 * Represents a broken link with potential fixes
 */
export interface BrokenLink {
  /** Path to the file containing the broken link */
  filePath: string;
  /** The original link information */
  link: MarkdownLink;
  /** Array of suggested fix paths (relative to the source file) */
  suggestions: string[];
  /** Whether this link can be automatically fixed */
  canAutoFix: boolean;
}

/**
 * Result of scanning a single file for links
 */
export interface FileScanResult {
  /** Path to the scanned file */
  filePath: string;
  /** All Markdown links found in the file */
  allLinks: MarkdownLink[];
  /** Only local links (non-HTTP/HTTPS/mailto) */
  localLinks: MarkdownLink[];
  /** Links that are broken (target file doesn't exist) */
  brokenLinks: BrokenLink[];
  /** Processing time for this file in milliseconds */
  processingTime: number;
}

/**
 * Complete scan result for all processed files
 */
export interface ScanResult {
  /** Total number of files scanned */
  totalFiles: number;
  /** Total number of links found across all files */
  totalLinks: number;
  /** Total number of local links found */
  totalLocalLinks: number;
  /** All broken links found across all files */
  brokenLinks: BrokenLink[];
  /** Individual file scan results */
  fileResults: FileScanResult[];
  /** Total processing time in milliseconds */
  processingTime: number;
}

/**
 * Options for the link checking operation
 */
export interface CheckLinksOptions {
  /** Path to scan (file or directory) */
  targetPath?: string;
  /** Enable interactive repair mode */
  applyFixes?: boolean;
  /** Show detailed progress information */
  verbose?: boolean;
  /** Perform dry run (report only, no changes) */
  dryRun?: boolean;
  /** Output file path for saving the report */
  outputFile?: string;
}

/**
 * User action in interactive repair mode
 */
export type UserAction = 'yes' | 'no' | 'all' | 'quit';

/**
 * Result of applying a fix to a broken link
 */
export interface FixResult {
  /** Whether the fix was successfully applied */
  success: boolean;
  /** The broken link that was processed */
  brokenLink: BrokenLink;
  /** The fix that was applied (if any) */
  appliedFix?: string;
  /** Error message if fix failed */
  error?: string;
}

/**
 * Summary of interactive repair session
 */
export interface RepairSummary {
  /** Total number of broken links processed */
  totalProcessed: number;
  /** Number of fixes successfully applied */
  fixesApplied: number;
  /** Number of links skipped by user */
  linksSkipped: number;
  /** Number of files modified */
  filesModified: number;
  /** Any errors encountered during repair */
  errors: string[];
}

/**
 * Configuration for link scanning behavior
 */
export interface ScanConfig {
  /** File extensions to scan (default: ['.md', '.markdown']) */
  extensions?: string[];
  /** Directories to ignore during scanning */
  ignoreDirs?: string[];
  /** Maximum depth for recursive scanning (-1 for unlimited) */
  maxDepth?: number;
  /** Whether to follow symbolic links */
  followSymlinks?: boolean;
}

/**
 * Progress callback for long-running operations
 */
export type ProgressCallback = (current: number, total: number, message?: string) => void;

/**
 * Error types that can occur during link verification
 */
export enum LinkVerificationError {
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  INVALID_PATH = 'INVALID_PATH',
  PARSE_ERROR = 'PARSE_ERROR',
  WRITE_ERROR = 'WRITE_ERROR'
}

/**
 * Custom error class for link verification operations
 */
export class LinkVerificationException extends Error {
  constructor(
    public errorType: LinkVerificationError,
    message: string,
    public filePath?: string
  ) {
    super(message);
    this.name = 'LinkVerificationException';
  }
}

/**
 * Statistics for reporting
 */
export interface LinkStatistics {
  /** Total files scanned */
  totalFiles: number;
  /** Total links found */
  totalLinks: number;
  /** Local links found */
  localLinks: number;
  /** Broken links found */
  brokenLinks: number;
  /** Links with available suggestions */
  linksWithSuggestions: number;
  /** Percentage of broken links */
  brokenLinkPercentage: number;
  /** Percentage of fixable links */
  fixablePercentage: number;
  /** Total scan time */
  scanTime: number;
}