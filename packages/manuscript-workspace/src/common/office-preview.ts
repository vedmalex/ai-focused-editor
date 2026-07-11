import type { OfficePreviewKind, OfficeSlidePreview } from './office-preview-protocol';

/**
 * Pure formatting helpers for the office-preview backend. No Theia/Node/DOM
 * imports so they can be exercised with plain `bun test`. The node service owns
 * the actual mammoth/xlsx/jszip parsing; everything deterministic — cell/slide
 * shaping and HTML assembly — lives here.
 */

/** Row cap applied per worksheet before an explicit `truncated` flag is set. */
export const OFFICE_SHEET_MAX_ROWS = 1000;
/** Column cap applied per worksheet row. */
export const OFFICE_SHEET_MAX_COLS = 50;
/** Files larger than this are refused with a warning (bytes). */
export const OFFICE_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Total embedded-media budget for a single presentation (bytes). */
export const OFFICE_PPTX_MEDIA_BUDGET_BYTES = 20 * 1024 * 1024;

/** Extensions routed to each preview strategy. */
const HTML_EXTENSIONS = ['.docx'];
const SHEET_EXTENSIONS = ['.xlsx', '.xls', '.ods'];
const SLIDE_EXTENSIONS = ['.pptx'];
/** Legacy binary formats we can only surface as a friendly "unsupported" view. */
const LEGACY_BINARY_EXTENSIONS = ['.doc', '.ppt'];

export type OfficeStrategy = 'html' | 'sheets' | 'slides' | 'legacy' | 'unknown';

/** All extensions the office preview claims (drives the open-handler + tree). */
export const OFFICE_PREVIEW_EXTENSIONS: readonly string[] = [
  ...HTML_EXTENSIONS,
  ...SHEET_EXTENSIONS,
  ...SLIDE_EXTENSIONS,
  ...LEGACY_BINARY_EXTENSIONS
];

/** Lower-cased extension (including the dot) of a path, or '' when none. */
export function officeExtension(pathOrName: string): string {
  const base = pathOrName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

/** True when the office preview should claim this path. */
export function isOfficePreviewFile(pathOrName: string): boolean {
  return OFFICE_PREVIEW_EXTENSIONS.includes(officeExtension(pathOrName));
}

/** Map an extension to the parsing strategy the node service applies. */
export function officeStrategyForExtension(ext: string): OfficeStrategy {
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
  if (LEGACY_BINARY_EXTENSIONS.includes(lower)) {
    return 'legacy';
  }
  return 'unknown';
}

/** The preview kind that corresponds to a strategy (legacy/unknown => unsupported). */
export function kindForStrategy(strategy: OfficeStrategy): OfficePreviewKind {
  switch (strategy) {
    case 'html':
      return 'html';
    case 'sheets':
      return 'sheets';
    case 'slides':
      return 'slides';
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
 * Cap a rectangular grid of cell strings to {@link OFFICE_SHEET_MAX_ROWS} rows
 * and {@link OFFICE_SHEET_MAX_COLS} columns. `truncated` is true when either
 * dimension was clipped, so the frontend can surface an explicit notice.
 */
export function capSheetGrid(
  grid: string[][],
  maxRows: number = OFFICE_SHEET_MAX_ROWS,
  maxCols: number = OFFICE_SHEET_MAX_COLS
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
): OfficeSlidePreview {
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
