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
 * - `html`    — a single HTML fragment (Word documents);
 * - `sheets`  — one HTML table per worksheet (spreadsheets);
 * - `slides`  — one structured card per slide (presentations);
 * - `unsupported` — the format cannot be previewed (legacy binary .doc/.ppt,
 *   oversized files, parser failure). `warnings` carries the human reason.
 */
export type DocumentPreviewKind = 'html' | 'sheets' | 'slides' | 'unsupported';

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

/**
 * Result of converting an office document to a previewable payload. Conversion
 * never throws across the RPC boundary: every failure mode (unsupported format,
 * oversized file, parser error) surfaces as `kind: 'unsupported'` (or an empty
 * payload) plus a human-readable entry in `warnings`.
 */
export interface DocumentPreviewResult {
  kind: DocumentPreviewKind;
  /** Present for `kind === 'html'` (Word documents). Already server-trusted but
   *  MUST still be sanitized on the frontend before injection. */
  html?: string;
  /** Present for `kind === 'sheets'` (spreadsheets), in workbook order. */
  sheets?: DocumentSheetPreview[];
  /** Present for `kind === 'slides'` (presentations), in document order. */
  slides?: DocumentSlidePreview[];
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
