import type { DocumentPreviewKind, DocumentSlidePreview } from './document-preview-protocol';

/**
 * Pure formatting helpers for the document-preview backend. No Theia/Node/DOM
 * imports so they can be exercised with plain `bun test`. The node service owns
 * the actual mammoth/xlsx/jszip parsing; everything deterministic — cell/slide
 * shaping and HTML assembly — lives here.
 */

/** Row cap applied per worksheet before an explicit `truncated` flag is set. */
export const DOCUMENT_SHEET_MAX_ROWS = 1000;
/** Column cap applied per worksheet row. */
export const DOCUMENT_SHEET_MAX_COLS = 50;
/** Files larger than this are refused with a warning (bytes). */
export const DOCUMENT_PREVIEW_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Total embedded-media budget for a single presentation (bytes). */
export const DOCUMENT_PPTX_MEDIA_BUDGET_BYTES = 20 * 1024 * 1024;
/** Per-chapter HTML budget for e-book previews (bytes); larger chapters are
 *  truncated with an explicit warning so the RPC payload stays bounded. */
export const DOCUMENT_EPUB_CHAPTER_HTML_MAX_BYTES = 1024 * 1024;
/** Chapter-list cap for e-book previews; longer TOCs are clipped with a warning. */
export const DOCUMENT_EPUB_MAX_CHAPTERS = 500;

/** Extensions routed to each preview strategy. */
const HTML_EXTENSIONS = ['.docx', '.odt', '.rtf'];
const SHEET_EXTENSIONS = ['.xlsx', '.xls', '.ods'];
const SLIDE_EXTENSIONS = ['.pptx', '.odp'];
const EPUB_EXTENSIONS = ['.epub'];
/** Legacy binary formats we can only surface as a friendly "unsupported" view. */
const LEGACY_BINARY_EXTENSIONS = ['.doc', '.ppt'];

export type DocumentPreviewStrategy = 'html' | 'sheets' | 'slides' | 'epub' | 'legacy' | 'unknown';

/** All extensions the document preview claims (drives the open-handler + tree). */
export const DOCUMENT_PREVIEW_EXTENSIONS: readonly string[] = [
  ...HTML_EXTENSIONS,
  ...SHEET_EXTENSIONS,
  ...SLIDE_EXTENSIONS,
  ...EPUB_EXTENSIONS,
  ...LEGACY_BINARY_EXTENSIONS
];

/** Lower-cased extension (including the dot) of a path, or '' when none. */
export function documentPreviewExtension(pathOrName: string): string {
  const base = pathOrName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

/** True when the document preview should claim this path. */
export function isDocumentPreviewFile(pathOrName: string): boolean {
  return DOCUMENT_PREVIEW_EXTENSIONS.includes(documentPreviewExtension(pathOrName));
}

/** Map an extension to the parsing strategy the node service applies. */
export function documentPreviewStrategyForExtension(ext: string): DocumentPreviewStrategy {
  const lower = ext.toLowerCase();
  if (HTML_EXTENSIONS.includes(lower)) {
    return 'html';
  }
  if (SHEET_EXTENSIONS.includes(lower)) {
    return 'sheets';
  }
  if (SLIDE_EXTENSIONS.includes(lower)) {
    return 'slides';
  }
  if (EPUB_EXTENSIONS.includes(lower)) {
    return 'epub';
  }
  if (LEGACY_BINARY_EXTENSIONS.includes(lower)) {
    return 'legacy';
  }
  return 'unknown';
}

/** The preview kind that corresponds to a strategy (legacy/unknown => unsupported). */
export function kindForStrategy(strategy: DocumentPreviewStrategy): DocumentPreviewKind {
  switch (strategy) {
    case 'html':
      return 'html';
    case 'sheets':
      return 'sheets';
    case 'slides':
      return 'slides';
    case 'epub':
      return 'epub';
    default:
      return 'unsupported';
  }
}

/** Minimal HTML text escaping for cell/run content. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface CappedGrid {
  rows: string[][];
  truncated: boolean;
}

/**
 * Cap a rectangular grid of cell strings to {@link DOCUMENT_SHEET_MAX_ROWS} rows
 * and {@link DOCUMENT_SHEET_MAX_COLS} columns. `truncated` is true when either
 * dimension was clipped, so the frontend can surface an explicit notice.
 */
export function capSheetGrid(
  grid: string[][],
  maxRows: number = DOCUMENT_SHEET_MAX_ROWS,
  maxCols: number = DOCUMENT_SHEET_MAX_COLS
): CappedGrid {
  let truncated = false;
  const rows: string[][] = [];
  for (let r = 0; r < grid.length; r++) {
    if (r >= maxRows) {
      truncated = true;
      break;
    }
    const source = grid[r] ?? [];
    if (source.length > maxCols) {
      truncated = true;
    }
    rows.push(source.slice(0, maxCols).map(cell => (cell == null ? '' : String(cell))));
  }
  return { rows, truncated };
}

/**
 * Assemble an HTML `<table>` from a (already capped) grid. The first row is
 * rendered as a header (`<th>`) when `headerRow` is true. All cell content is
 * HTML-escaped.
 */
export function assembleSheetTable(grid: string[][], headerRow = true): string {
  if (grid.length === 0) {
    return '<table class="afe-office-sheet-table"></table>';
  }
  const parts: string[] = ['<table class="afe-office-sheet-table">'];
  grid.forEach((row, index) => {
    const cellTag = headerRow && index === 0 ? 'th' : 'td';
    const cells = row.map(cell => `<${cellTag}>${escapeHtml(cell)}</${cellTag}>`).join('');
    parts.push(`<tr>${cells}</tr>`);
  });
  parts.push('</table>');
  return parts.join('');
}

/**
 * Extract the ordered text runs from a single PowerPoint slide XML string
 * (`ppt/slides/slideN.xml`). Each `<a:t>` element is one run; runs are trimmed
 * and empty runs dropped. XML entities in run text are decoded. This is
 * deliberately tolerant of namespace prefixes and self-closing/empty tags.
 */
export function extractSlideText(slideXml: string): string[] {
  const runs: string[] = [];
  // `<a:t>...</a:t>` — non-greedy, dot-all so runs spanning newlines are caught.
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(slideXml)) !== null) {
    const text = decodeXmlEntities(match[1]).trim();
    if (text.length > 0) {
      runs.push(text);
    }
  }
  return runs;
}

/** Decode the five predefined XML entities plus numeric character references. */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return '';
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Build a slide preview card payload from a slide's extracted text runs. The
 * first run becomes the `title`; the remaining runs render as a `<ul>` list.
 * A slide with no runs yields an explicit "no text" paragraph so the card is
 * never blank.
 */
export function buildSlidePreview(
  index: number,
  runs: string[],
  emptyLabel: string
): DocumentSlidePreview {
  if (runs.length === 0) {
    return {
      index,
      html: `<p class="afe-office-slide-empty">${escapeHtml(emptyLabel)}</p>`
    };
  }
  const [title, ...body] = runs;
  const items = body.map(run => `<li>${escapeHtml(run)}</li>`).join('');
  const list = items.length > 0 ? `<ul class="afe-office-slide-runs">${items}</ul>` : '';
  return {
    index,
    title,
    html: `${list}` || `<p>${escapeHtml(title)}</p>`
  };
}

/** Natural sort key for `slideN.xml` names so slide2 precedes slide10. */
export function slideNumberFromName(name: string): number {
  const match = /slide(\d+)\.xml$/i.exec(name);
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// ODF Impress (.odp) — pure content.xml parsing
// ---------------------------------------------------------------------------

/** Strip markup tags, decode XML entities, and collapse whitespace. */
export function stripXmlMarkup(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Extract per-slide text runs from an ODF Impress `content.xml`. Each
 * `<draw:page>` is one slide; every non-empty `<text:p>` (which contains the
 * page's `<text:span>` runs) inside the page becomes one text run, in document
 * order. Purely regex-based and namespace-prefix tolerant on purpose — same
 * trade-off as {@link extractSlideText} for pptx.
 */
export function extractOdpSlideTexts(contentXml: string): string[][] {
  const pages: string[][] = [];
  const pageRe = /<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g;
  let pageMatch: RegExpExecArray | null;
  while ((pageMatch = pageRe.exec(contentXml)) !== null) {
    const runs: string[] = [];
    const paraRe = /<text:(p|h)\b[^>]*>([\s\S]*?)<\/text:\1>/g;
    let paraMatch: RegExpExecArray | null;
    while ((paraMatch = paraRe.exec(pageMatch[1])) !== null) {
      const text = stripXmlMarkup(paraMatch[2]);
      if (text.length > 0) {
        runs.push(text);
      }
    }
    pages.push(runs);
  }
  return pages;
}

// ---------------------------------------------------------------------------
// EPUB — pure container.xml / OPF / TOC parsing (custom jszip spine reader)
// ---------------------------------------------------------------------------

/** One `<item>` of the OPF manifest. */
export interface EpubManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

/** Parsed skeleton of an OPF package document. */
export interface EpubOpf {
  /** `<dc:title>` content, when present. */
  title?: string;
  /** Manifest items in document order. */
  manifest: EpubManifestItem[];
  /** Spine `idref`s in reading order (entries with `linear="no"` excluded). */
  spine: string[];
}

/** One TOC row extracted from a nav document or NCX. */
export interface EpubTocEntry {
  label: string;
  href: string;
}

/** Value of an XML attribute inside a single tag string, or undefined. */
function xmlAttr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decodeXmlEntities(match[1] ?? match[2] ?? '') : undefined;
}

/** OPF package-document path from `META-INF/container.xml`, or undefined. */
export function epubRootFileFromContainer(containerXml: string): string | undefined {
  const rootfileRe = /<rootfile\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = rootfileRe.exec(containerXml)) !== null) {
    const mediaType = xmlAttr(match[0], 'media-type');
    const fullPath = xmlAttr(match[0], 'full-path');
    if (fullPath && (!mediaType || mediaType === 'application/oebps-package+xml')) {
      return fullPath;
    }
  }
  return undefined;
}

/** Parse the OPF package document into title + manifest + spine. */
export function parseEpubOpf(opfXml: string): EpubOpf {
  const titleMatch = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opfXml);
  const title = titleMatch ? stripXmlMarkup(titleMatch[1]) || undefined : undefined;

  const manifest: EpubManifestItem[] = [];
  const manifestSection = /<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i.exec(opfXml)?.[1] ?? '';
  const itemRe = /<item\b[^>]*\/?>/g;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemRe.exec(manifestSection)) !== null) {
    const id = xmlAttr(itemMatch[0], 'id');
    const href = xmlAttr(itemMatch[0], 'href');
    const mediaType = xmlAttr(itemMatch[0], 'media-type');
    if (id && href) {
      manifest.push({ id, href, mediaType: mediaType ?? '', properties: xmlAttr(itemMatch[0], 'properties') });
    }
  }

  const spine: string[] = [];
  const spineSection = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opfXml)?.[1] ?? '';
  const itemrefRe = /<itemref\b[^>]*\/?>/g;
  let itemrefMatch: RegExpExecArray | null;
  while ((itemrefMatch = itemrefRe.exec(spineSection)) !== null) {
    const idref = xmlAttr(itemrefMatch[0], 'idref');
    const linear = xmlAttr(itemrefMatch[0], 'linear');
    if (idref && linear?.toLowerCase() !== 'no') {
      spine.push(idref);
    }
  }

  return { title, manifest, spine };
}

/**
 * TOC entries from an EPUB 3 nav document. Prefers the `<nav epub:type="toc">`
 * element; falls back to the first `<nav>` when no epub:type is declared.
 * Hrefs are as-authored (relative to the nav document itself).
 */
export function epubTocFromNav(navXhtml: string): EpubTocEntry[] {
  const navRe = /<nav\b[^>]*>([\s\S]*?)<\/nav>/gi;
  let tocSection: string | undefined;
  let firstNav: string | undefined;
  let navMatch: RegExpExecArray | null;
  while ((navMatch = navRe.exec(navXhtml)) !== null) {
    firstNav = firstNav ?? navMatch[1];
    const typeAttr = /\bepub:type\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(navMatch[0].slice(0, navMatch[0].indexOf('>') + 1));
    if ((typeAttr?.[1] ?? typeAttr?.[2] ?? '').split(/\s+/).includes('toc')) {
      tocSection = navMatch[1];
      break;
    }
  }
  const section = tocSection ?? firstNav ?? '';
  const entries: EpubTocEntry[] = [];
  const anchorRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorRe.exec(section)) !== null) {
    const href = xmlAttr(anchorMatch[0].slice(0, anchorMatch[0].indexOf('>') + 1), 'href');
    const label = stripXmlMarkup(anchorMatch[1]);
    if (href && label) {
      entries.push({ label, href });
    }
  }
  return entries;
}

/**
 * TOC entries from an EPUB 2 `toc.ncx`. Nested navPoints are flattened in
 * document order. Hrefs are as-authored (relative to the NCX document).
 */
export function epubTocFromNcx(ncxXml: string): EpubTocEntry[] {
  const entries: EpubTocEntry[] = [];
  const navPointRe = /<navPoint\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = navPointRe.exec(ncxXml)) !== null) {
    const contentTag = /<content\b[^>]*\/?>/.exec(match[0].slice(match[0].lastIndexOf('<content')));
    const href = contentTag ? xmlAttr(contentTag[0], 'src') : undefined;
    const label = stripXmlMarkup(match[1]);
    if (href && label) {
      entries.push({ label, href });
    }
  }
  return entries;
}

/** Inner HTML of `<body>` from an (X)HTML chapter, or the whole input. */
export function extractXhtmlBody(xhtml: string): string {
  const match = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml);
  return (match ? match[1] : xhtml).trim();
}

/**
 * Resolve an OPF/TOC href against the directory of the referencing document to
 * a normalized zip-internal path: strips fragment/query, URI-decodes, and
 * collapses `.`/`..` segments (never above the archive root).
 */
export function resolveEpubHref(baseDir: string, href: string): string {
  const clean = href.split('#')[0].split('?')[0];
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // Keep the raw href when it is not valid percent-encoding.
  }
  const joined = decoded.startsWith('/') ? decoded.slice(1) : (baseDir ? `${baseDir}/${decoded}` : decoded);
  const segments: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** Zip-internal directory of a path ('' for root-level files). */
export function epubDirName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash) : '';
}

/**
 * Cap an HTML fragment at `maxBytes` (UTF-16 code-unit approximation is fine
 * here — the cap is a payload guard, not an exact byte budget). A truncated
 * fragment may end mid-tag; the frontend's DOMPurify pass repairs the markup.
 */
export function capHtmlFragment(html: string, maxBytes: number = DOCUMENT_EPUB_CHAPTER_HTML_MAX_BYTES): {
  html: string;
  truncated: boolean;
} {
  if (html.length <= maxBytes) {
    return { html, truncated: false };
  }
  return { html: html.slice(0, maxBytes), truncated: true };
}

// ---------------------------------------------------------------------------
// Back-compat aliases (pre-extraction names used by manuscript-workspace and
// external consumers). New code should prefer the DocumentPreview* names.
// ---------------------------------------------------------------------------

/** @deprecated Use {@link DOCUMENT_SHEET_MAX_ROWS}. */
export const OFFICE_SHEET_MAX_ROWS = DOCUMENT_SHEET_MAX_ROWS;
/** @deprecated Use {@link DOCUMENT_SHEET_MAX_COLS}. */
export const OFFICE_SHEET_MAX_COLS = DOCUMENT_SHEET_MAX_COLS;
/** @deprecated Use {@link DOCUMENT_PREVIEW_MAX_FILE_BYTES}. */
export const OFFICE_MAX_FILE_BYTES = DOCUMENT_PREVIEW_MAX_FILE_BYTES;
/** @deprecated Use {@link DOCUMENT_PPTX_MEDIA_BUDGET_BYTES}. */
export const OFFICE_PPTX_MEDIA_BUDGET_BYTES = DOCUMENT_PPTX_MEDIA_BUDGET_BYTES;
/** @deprecated Use {@link DocumentPreviewStrategy}. */
export type OfficeStrategy = DocumentPreviewStrategy;
/** @deprecated Use {@link DOCUMENT_PREVIEW_EXTENSIONS}. */
export const OFFICE_PREVIEW_EXTENSIONS = DOCUMENT_PREVIEW_EXTENSIONS;
/** @deprecated Use {@link documentPreviewExtension}. */
export const officeExtension = documentPreviewExtension;
/** @deprecated Use {@link isDocumentPreviewFile}. */
export const isOfficePreviewFile = isDocumentPreviewFile;
/** @deprecated Use {@link documentPreviewStrategyForExtension}. */
export const officeStrategyForExtension = documentPreviewStrategyForExtension;
