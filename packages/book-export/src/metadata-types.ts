/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0). Trimmed to the subset
 * of metadata/link types the self-contained EPUB export closure needs.
 */

/**
 * Publication status enumeration
 */
export enum PublicationStatus {
  NOT_PUBLISHED = "not_published",
  PUBLISHED = "published",
  METADATA_CORRUPTED = "metadata_corrupted",
  METADATA_MISSING = "metadata_missing"
}

/**
 * File metadata stored in YAML front-matter
 */
export interface FileMetadata {
  /** Telegraph page URL */
  telegraphUrl: string;
  /** Telegraph page path for editing */
  editPath: string;
  /** Username/author name */
  username: string;
  /** Publication timestamp in ISO format */
  publishedAt: string;
  /** Original filename for reference */
  originalFilename: string;
  /** Optional page title */
  title?: string;
  /** Optional description */
  description?: string;
  /** Optional content hash for change detection */
  contentHash?: string;
  /** Optional GitHub Gist ID for markdown export/update workflow */
  gistId?: string;
  /** Optional GitHub Gist URL */
  gistUrl?: string;
  /** Optional filename used inside GitHub Gist */
  gistFilename?: string;
  /** Optional gist visibility flag */
  gistPublic?: boolean;
  /** Optional ISO timestamp for last gist update */
  gistUpdatedAt?: string;
  /** Access token used for publication/editing. */
  accessToken?: string;
  /** Source of the access token for diagnostic purposes */
  tokenSource?: 'metadata' | 'cache' | 'config' | 'session' | 'backfilled';
  /** ISO timestamp when token was last updated */
  tokenUpdatedAt?: string;
  /** Map of published dependencies for this file. */
  publishedDependencies?: Record<string, string>;
}

/**
 * Local link information found in markdown content
 */
export interface LocalLink {
  /** Link text displayed to user */
  text: string;
  /** Original local path as written in markdown */
  originalPath: string;
  /** Resolved absolute file path */
  resolvedPath: string;
  /** Whether the linked file has been published */
  isPublished: boolean;
  /** Telegraph URL if file is published */
  telegraphUrl?: string;
  /** Full markdown link match for replacement */
  fullMatch: string;
  /** Start position in content */
  startIndex: number;
  /** End position in content */
  endIndex: number;
  /** Whether this is an internal link to our published page */
  isInternalLink?: boolean;
}

/**
 * Telegraph link information found in content
 */
export interface TelegraphLink {
  /** Link text displayed to user */
  text: string;
  /** Telegraph URL */
  telegraphUrl: string;
  /** Local file path if this is our published page */
  localFilePath?: string;
  /** Full markdown link match for replacement */
  fullMatch: string;
  /** Start position in content */
  startIndex: number;
  /** End position in content */
  endIndex: number;
  /** Whether this link should be converted to local link */
  shouldConvertToLocal: boolean;
}

/**
 * Content processing result
 */
export interface ProcessedContent {
  /** Original content */
  originalContent: string;
  /** Content without front-matter */
  contentWithoutMetadata: string;
  /** Content with Telegraph URLs (for publishing) */
  contentWithReplacedLinks: string;
  /** Content with local links (for source file) */
  contentWithLocalLinks: string;
  /** Extracted metadata if present */
  metadata?: FileMetadata;
  /** Found local links */
  localLinks: LocalLink[];
  /** Found Telegraph links */
  telegraphLinks: TelegraphLink[];
  /** Whether content was modified */
  hasChanges: boolean;
}
