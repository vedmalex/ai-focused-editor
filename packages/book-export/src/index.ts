/*
 * @ai-focused-editor/book-export
 *
 * Self-contained EPUB + PDF export core, derived from the owner's
 * telegraph-publisher library (~/work/BhaktiVaibhava/telegraph-publisher,
 * v1.5.0). Provides the EPUB generator, the PDF renderer, and the shared slug
 * convention used by all manuscript exporters.
 */
export { EpubGenerator } from './EpubGenerator';
export type { EpubNavPoint } from './EpubGenerator';
export { AnchorGenerator } from './AnchorGenerator';
export type { HeadingInfo } from './AnchorGenerator';
export { convertMarkdownToTelegraphNodes } from './markdownConverter';
export type { TelegraphNode } from './telegraph-node';
export { slugifyBase, createSlugger } from './slug';
export {
  findChromePath,
  renderHtmlToPdf,
  CHROME_CANDIDATE_PATHS,
  CHROME_NOT_FOUND_MESSAGE
} from './PdfGenerator';
export type { PdfPaperFormat, RenderHtmlToPdfOptions } from './PdfGenerator';
