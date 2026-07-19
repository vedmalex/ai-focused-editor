export const DocumentPreviewService = Symbol('DocumentPreviewService');
/**
 * RPC path of the backend conversion service. The historical value is kept
 * verbatim so existing clients/layouts keep working after the extraction from
 * manuscript-workspace.
 */
export const DocumentPreviewServicePath = '/services/ai-focused-editor/office-preview';

/**
 * The kind of rendered payload {@link DocumentPreviewService.convertOfficeDocument}
 * produced for a given office document:
 * - `html`    — a single HTML fragment (Word documents, ODF text, RTF);
 * - `sheets`  — one HTML table per worksheet (spreadsheets);
 * - `slides`  — one structured card per slide (presentations, ODF Impress);
 * - `epub`    — chapter list (TOC) plus the first spine chapter's HTML (e-books);
 * - `unsupported` — the format cannot be previewed (legacy binary .doc/.ppt,
 *   oversized files, parser failure). `warnings` carries the human reason.
 */
export type DocumentPreviewKind = 'html' | 'sheets' | 'slides' | 'epub' | 'unsupported';

/** One worksheet rendered as an HTML table. */
export interface DocumentSheetPreview {
  /** Worksheet name as authored in the workbook. */
  name: string;
  /** HTML `<table>` markup for the (row/column capped) sheet. */
  html: string;
  /** True when the sheet was capped at the row/column limit. */
  truncated: boolean;
}

/** One slide rendered as a simple structured HTML list of its text runs. */
export interface DocumentSlidePreview {
  /** 1-based slide index in document order. */
  index: number;
  /** First non-empty text run, surfaced as the card heading when present. */
  title?: string;
  /** Structured HTML (`<ul>`/`<p>`) of the slide's text runs. */
  html: string;
}

/** One e-book chapter entry (TOC row); `html` is populated only for the
 *  chapter(s) actually rendered — the MVP loads just the first spine chapter
 *  so the payload stays bounded for large books. */
export interface DocumentEpubChapter {
  /** Stable identifier — the chapter's zip-internal resource path. */
  id: string;
  /** Human-readable TOC label (falls back to the spine item's file name). */
  label: string;
  /** Chapter body HTML. Present only for rendered chapters. MUST be sanitized
   *  on the frontend before injection (epub XHTML can carry scripts/refs). */
  html?: string;
}

/** E-book payload: book title + chapter list with the first chapter rendered. */
export interface DocumentEpubPreview {
  /** Book title from the OPF metadata, when present. */
  title?: string;
  /** TOC (or spine fallback) in reading order. */
  chapters: DocumentEpubChapter[];
}

/**
 * Result of converting an office document to a previewable payload. Conversion
 * never throws across the RPC boundary: every failure mode (unsupported format,
 * oversized file, parser error) surfaces as `kind: 'unsupported'` (or an empty
 * payload) plus a human-readable entry in `warnings`.
 */
export interface DocumentPreviewResult {
  kind: DocumentPreviewKind;
  /** Present for `kind === 'html'` (Word/ODF text/RTF documents). Already
   *  server-trusted but MUST still be sanitized on the frontend before injection. */
  html?: string;
  /** Present for `kind === 'sheets'` (spreadsheets), in workbook order. */
  sheets?: DocumentSheetPreview[];
  /** Present for `kind === 'slides'` (presentations), in document order. */
  slides?: DocumentSlidePreview[];
  /** Present for `kind === 'epub'` (e-books). */
  epub?: DocumentEpubPreview;
  /** Non-fatal notices: mammoth conversion messages, truncation notes, the
   *  unsupported-format reason, size-guard refusals, etc. */
  warnings: string[];
}

export interface DocumentPreviewService {
  /**
   * Convert the office document at the workspace-relative `path` (resolved under
   * `rootUri`) into a previewable payload. Best-effort: failures are reported via
   * `kind: 'unsupported'` + `warnings` rather than rejecting.
   */
  convertOfficeDocument(rootUri: string, path: string): Promise<DocumentPreviewResult>;
}

// ---------------------------------------------------------------------------
// Back-compat aliases (pre-extraction names used by manuscript-workspace and
// external consumers). New code should prefer the DocumentPreview* names.
// ---------------------------------------------------------------------------

/** @deprecated Use {@link DocumentPreviewService}. */
export const OfficePreviewService = DocumentPreviewService;
/** @deprecated Use {@link DocumentPreviewService}. */
export type OfficePreviewService = DocumentPreviewService;
/** @deprecated Use {@link DocumentPreviewServicePath}. */
export const OfficePreviewServicePath = DocumentPreviewServicePath;
/** @deprecated Use {@link DocumentPreviewKind}. */
export type OfficePreviewKind = DocumentPreviewKind;
/** @deprecated Use {@link DocumentSheetPreview}. */
export type OfficeSheetPreview = DocumentSheetPreview;
/** @deprecated Use {@link DocumentSlidePreview}. */
export type OfficeSlidePreview = DocumentSlidePreview;
/** @deprecated Use {@link DocumentPreviewResult}. */
export type OfficePreviewResult = DocumentPreviewResult;
