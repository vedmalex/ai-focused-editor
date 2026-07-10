/*
 * Derived from the owner's telegraph-publisher library
 * (~/work/BhaktiVaibhava/telegraph-publisher, v1.5.0). Extracted and trimmed
 * to the self-contained EPUB export closure for AI Focused Editor.
 *
 * AI-focused-editor change: `generateAnchor` now delegates to the shared
 * `slugifyBase` slug convention so heading ids (markdownConverter) and NCX
 * anchors (EpubGenerator) stay consistent with the Markdown/HTML exporters.
 */

/**
 * AnchorGenerator - Unified anchor generation for TOC and link verification
 *
 * This module provides a single source of truth for anchor generation,
 * ensuring consistency between TOC generation and link validation.
 */
import { slugifyBase } from './slug';

/**
 * Comprehensive heading information with processing metadata
 */
export interface HeadingInfo {
  /** Original heading level (1-6+) */
  level: number;
  
  /** Raw text from markdown (including any formatting) */
  originalText: string;
  
  /** Display text with level prefixes for rendering */
  displayText: string;
  
  /** Processed text optimized for anchor generation */
  textForAnchor: string;
  
  /** Detected link information if heading contains a link */
  linkInfo?: {
    text: string;
    url: string;
  };
  
  /** Processing metadata for debugging and validation */
  metadata: {
    hasLink: boolean;
    hasPrefix: boolean;
    prefixType: 'none' | 'h5' | 'h6' | 'extended';
  };
}

/**
 * Configuration for anchor generation behavior
 */
export interface AnchorGenerationOptions {
  /** Whether to preserve level prefixes (>, >>) in anchors */
  preservePrefixes?: boolean;
  
  /** Custom prefix mapping for levels > 6 */
  extendedPrefixes?: Record<number, string>;
  
  /** Whether to extract link text from headings */
  extractLinkText?: boolean;
  
  /** Validation mode for debugging */
  strict?: boolean;
}

/**
 * AnchorGenerator - Intelligent Heading Processor
 * 
 * Provides unified anchor generation using the same algorithm as Telegraph TOC,
 * ensuring 100% consistency between TOC anchors and link validation anchors.
 */
export class AnchorGenerator {
  /** Default processing options aligned with Telegraph behavior */
  private static readonly DEFAULT_OPTIONS: Required<AnchorGenerationOptions> = {
    preservePrefixes: true,
    extendedPrefixes: {},
    extractLinkText: true,
    strict: false
  };

  /**
   * PHASE 1: Intelligent Heading Detection & Extraction
   * 
   * Extracts heading info with advanced link detection and level processing.
   * Based on the proven logic from generateTocAside with enhancements.
   * 
   * @param headingMatch RegExp match from heading detection (/^(#+)\s+(.*)/)
   * @param options Processing options
   * @returns Comprehensive heading information
   */
  static extractHeadingInfo(
    headingMatch: RegExpMatchArray, 
    options: AnchorGenerationOptions = {}
  ): HeadingInfo {
    const opts = { ...this.DEFAULT_OPTIONS, ...options };
    
    const level = headingMatch[1]?.length || 0;
    const originalText = headingMatch[2]?.trim() || '';
    
    // Advanced Link Detection (Enhanced from TOC logic)
    const linkDetection = this.detectLinkInHeading(originalText, opts.extractLinkText);
    
    // Level-Aware Text Processing (Extracted from generateTocAside)
    const levelProcessing = this.processHeadingLevel(
      level, 
      originalText, 
      linkDetection, 
      opts
    );
    
    return {
      level,
      originalText,
      displayText: levelProcessing.displayText,
      textForAnchor: levelProcessing.textForAnchor,
      linkInfo: linkDetection.linkInfo,
      metadata: {
        hasLink: linkDetection.hasLink,
        hasPrefix: levelProcessing.hasPrefix,
        prefixType: levelProcessing.prefixType
      }
    };
  }

  /**
   * PHASE 2: Anchor generation unified with the AI Focused Editor slug convention.
   *
   * Delegates to the shared `slugifyBase` (lowercase, keep Unicode letters/digits,
   * collapse everything else to single hyphens) so EPUB heading ids and NCX anchors
   * match the Markdown/HTML exporters. Level prefixes (`>`/`>>` for H5/H6) collapse
   * away naturally because they are non-letter characters.
   *
   * @param headingInfo Processed heading information
   * @returns Slug anchor string consistent with slugifyBase
   */
  static generateAnchor(headingInfo: HeadingInfo): string {
    return slugifyBase(headingInfo.textForAnchor);
  }

  /**
   * PHASE 3: Batch Content Processing
   * 
   * Efficiently processes entire markdown content for headings.
   * Uses the same regex pattern as the original TOC generation.
   * 
   * @param content Raw markdown content
   * @param options Processing options
   * @returns Array of processed heading information
   */
  static parseHeadingsFromContent(
    content: string, 
    options: AnchorGenerationOptions = {}
  ): HeadingInfo[] {
    const headings: HeadingInfo[] = [];
    const lines = content.split(/\r?\n/);
    
    // Optimized single-pass parsing (same regex as original TOC)
    for (const line of lines) {
      const headingMatch = line.match(/^(#+)\s+(.*)/);
      if (headingMatch?.[1] && headingMatch[2] !== undefined) {
        headings.push(this.extractHeadingInfo(headingMatch, options));
      }
    }
    
    return headings;
  }

  /**
   * CONVENIENCE METHOD: Direct Anchor Extraction
   * 
   * Optimized for LinkVerifier use case.
   * Returns a Set of anchor strings ready for validation.
   * 
   * @param content Raw markdown content
   * @param options Processing options
   * @returns Set of anchor strings
   */
  static extractAnchors(
    content: string, 
    options: AnchorGenerationOptions = {}
  ): Set<string> {
    return new Set(
      this.parseHeadingsFromContent(content, options)
        .map(heading => this.generateAnchor(heading))
        .filter(anchor => anchor.length > 0)
    );
  }

  // PRIVATE: Advanced Processing Methods

  /**
   * Enhanced Link Detection (Extracted & Enhanced from TOC)
   * 
   * Detects various markdown link formats in headings:
   * - [text](url)
   * - [text](url "title")
   * - [text][ref]
   * 
   * @param text Heading text to analyze
   * @param shouldExtract Whether to perform link extraction
   * @returns Link detection results
   */
  private static detectLinkInHeading(
    text: string, 
    shouldExtract: boolean
  ): {
    hasLink: boolean;
    linkInfo?: { text: string; url: string };
  } {
    if (!shouldExtract) {
      return { hasLink: false };
    }

    // Enhanced link detection (supports multiple link formats)
    const linkMatches = [
      // Link with title (check first to capture URL without title)
      text.match(/^\[(.*?)\]\((\S+?)(?:\s+".*?")?\)$/),
      // Standard markdown link
      text.match(/^\[(.*?)\]\((.*?)\)$/),
      // Reference link
      text.match(/^\[(.*?)\]\[(.*?)\]$/),
    ];

    for (const match of linkMatches) {
      if (match) {
        return {
          hasLink: true,
          linkInfo: {
            text: match[1] || '',
            url: match[2] || ''
          }
        };
      }
    }

    return { hasLink: false };
  }

  /**
   * Level-Aware Processing (Enhanced from generateTocAside)
   * 
   * Applies the exact same level processing logic as the original TOC generation:
   * - H1-H4: No prefix
   * - H5: "> " prefix
   * - H6: ">> " prefix  
   * - H7+: ">>> " prefix
   * 
   * @param level Heading level (1-6+)
   * @param originalText Raw heading text
   * @param linkDetection Link detection results
   * @param options Processing options
   * @returns Processed text variants and metadata
   */
  private static processHeadingLevel(
    level: number,
    originalText: string,
    linkDetection: { hasLink: boolean; linkInfo?: { text: string; url: string } },
    options: Required<AnchorGenerationOptions>
  ): {
    displayText: string;
    textForAnchor: string;
    hasPrefix: boolean;
    prefixType: 'none' | 'h5' | 'h6' | 'extended';
  } {
    let displayText = originalText;
    let textForAnchor = originalText;
    
    // Extract link text if present (exact logic from generateTocAside)
    if (linkDetection.hasLink && linkDetection.linkInfo) {
      textForAnchor = linkDetection.linkInfo.text;
    }

    // Apply level-specific processing (exact logic from generateTocAside)
    switch (level) {
      case 1:
      case 2:
      case 3:
      case 4:
        return {
          displayText,
          textForAnchor: this.stripInlineMarkdown(textForAnchor),
          hasPrefix: false,
          prefixType: 'none'
        };

      case 5:
        const h5Display = `> ${originalText}`;
        const h5Anchor = linkDetection.hasLink && linkDetection.linkInfo 
          ? `> ${linkDetection.linkInfo.text}` 
          : `> ${originalText}`;
        
        return {
          displayText: h5Display,
          textForAnchor: this.stripInlineMarkdown(h5Anchor),
          hasPrefix: true,
          prefixType: 'h5'
        };

      case 6:
        const h6Display = `>> ${originalText}`;
        const h6Anchor = linkDetection.hasLink && linkDetection.linkInfo
          ? `>> ${linkDetection.linkInfo.text}`
          : `>> ${originalText}`;
        
        return {
          displayText: h6Display,
          textForAnchor: this.stripInlineMarkdown(h6Anchor),
          hasPrefix: true,
          prefixType: 'h6'
        };

      default:
        // Handle levels > 6 with extensible prefix system
        const extendedPrefix = options.extendedPrefixes[level] || '>>> ';
        const extendedDisplay = `${extendedPrefix}${originalText}`;
        const extendedAnchor = linkDetection.hasLink && linkDetection.linkInfo
          ? `${extendedPrefix}${linkDetection.linkInfo.text}`
          : `${extendedPrefix}${originalText}`;
        
        return {
          displayText: extendedDisplay,
          textForAnchor: this.stripInlineMarkdown(extendedAnchor),
          hasPrefix: true,
          prefixType: 'extended'
        };
    }
  }

  /**
   * Removes inline markdown formatting (links, bold/italic, code) for anchor text.
   */
  private static stripInlineMarkdown(text: string): string {
    let sanitized = text;

    // Replace links with their text
    sanitized = sanitized.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    sanitized = sanitized.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

    // Bold / italic / code
    sanitized = sanitized.replace(/(\*\*|__)(.*?)\1/g, '$2');
    sanitized = sanitized.replace(/(\*|_)(.*?)\1/g, '$2');
    sanitized = sanitized.replace(/`([^`]*)`/g, '$1');

    return sanitized;
  }

  /**
   * DEBUGGING: Validation & Analysis Tools
   * 
   * Provides debugging utilities for migration and validation.
   * Useful during development and testing phases.
   * 
   * @param content Markdown content to analyze
   * @returns Consistency analysis results
   */
  static validateAnchorConsistency(content: string): {
    isConsistent: boolean;
    inconsistencies: Array<{
      heading: string;
      tocAnchor: string;
      generatedAnchor: string;
      issue: string;
    }>;
  } {
    const headings = this.parseHeadingsFromContent(content);
    const inconsistencies: Array<{
      heading: string;
      tocAnchor: string;
      generatedAnchor: string;
      issue: string;
    }> = [];
    
    // Check for potential issues
    const anchors = headings.map(h => this.generateAnchor(h));
    const anchorCounts = new Map<string, number>();
    
    // Count anchor occurrences
    for (const anchor of anchors) {
      anchorCounts.set(anchor, (anchorCounts.get(anchor) || 0) + 1);
    }
    
    // Check for duplicates
    for (const [anchor, count] of anchorCounts) {
      if (count > 1) {
        const duplicateHeadings = headings
          .filter(h => this.generateAnchor(h) === anchor)
          .map(h => h.originalText);
        
        for (const heading of duplicateHeadings) {
          inconsistencies.push({
            heading,
            tocAnchor: anchor,
            generatedAnchor: anchor,
            issue: `Duplicate anchor (${count} occurrences)`
          });
        }
      }
    }
    
    return {
      isConsistent: inconsistencies.length === 0,
      inconsistencies
    };
  }
}
