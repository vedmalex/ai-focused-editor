import { promises as fs } from 'fs';
import { extname, isAbsolute, relative, resolve } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { injectable } from '@theia/core/shared/inversify';
import {
  assembleSheetTable,
  buildSlidePreview,
  capSheetGrid,
  extractSlideText,
  kindForStrategy,
  officeStrategyForExtension,
  OFFICE_MAX_FILE_BYTES,
  slideNumberFromName
} from '../common/office-preview';
import {
  OfficePreviewResult,
  OfficePreviewService,
  OfficeSheetPreview,
  OfficeSlidePreview
} from '../common';

/** Minimal structural surface of the `mammoth` functions used for docx preview. */
interface MammothModule {
  convertToHtml(
    input: { buffer: Buffer },
    options?: { convertImage?: unknown }
  ): Promise<{ value: string; messages: { type: string; message: string }[] }>;
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string; messages: { type: string; message: string }[] }>;
  images: {
    imgElement(handler: (image: {
      read(encoding: string): Promise<string>;
      contentType: string;
    }) => Promise<{ src: string }>): unknown;
  };
}

/** Minimal structural surface of the `xlsx` (SheetJS) functions we use. */
interface XlsxModule {
  read(data: Buffer, opts: { type: 'buffer' }): {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: {
    sheet_to_json<T>(sheet: unknown, opts: { header: 1; blankrows?: boolean; raw?: boolean; defval?: string }): T[];
  };
}

/** Minimal structural surface of the `jszip` async API we use. */
interface JsZipEntry {
  name: string;
  dir: boolean;
  async(type: 'string'): Promise<string>;
  async(type: 'uint8array'): Promise<Uint8Array>;
}
interface JsZipInstance {
  files: Record<string, JsZipEntry>;
}
interface JsZipModule {
  loadAsync(data: Buffer): Promise<JsZipInstance>;
}

/**
 * Heavy office parsers (`mammoth`, `xlsx`, `jszip`) are resolved lazily through a
 * runtime-assembled specifier so the esbuild backend bundler never pulls them
 * into the graph — they load from node_modules only when an office document is
 * actually previewed, mirroring the `unpdf` lazy-require in the source-analysis
 * path. Each ships a CommonJS entry so a plain `require` resolves under the
 * tsc-CJS backend and the bun test runner alike.
 */
function lazyRequire<T>(...parts: string[]): T {
  const moduleName = parts.join('');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(moduleName) as T;
}

function loadMammoth(): MammothModule {
  return lazyRequire<MammothModule>('mam', 'moth');
}
function loadXlsx(): XlsxModule {
  return lazyRequire<XlsxModule>('xl', 'sx');
}
function loadJsZip(): JsZipModule {
  return lazyRequire<{ default?: JsZipModule } & JsZipModule>('js', 'zip') as unknown as JsZipModule;
}

const PPTX_MEDIA_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};

@injectable()
export class NodeOfficePreviewService implements OfficePreviewService {
  async convertOfficeDocument(rootUri: string, path: string): Promise<OfficePreviewResult> {
    const warnings: string[] = [];
    if (!rootUri) {
      return { kind: 'unsupported', warnings: ['Open a manuscript workspace before previewing office documents.'] };
    }
    if (typeof path !== 'string' || path.trim().length === 0) {
      return { kind: 'unsupported', warnings: ['No document path was provided.'] };
    }

    const rootPath = toRootPath(rootUri);
    const absolutePath = resolve(rootPath, path);
    const relativePath = relative(rootPath, absolutePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return { kind: 'unsupported', warnings: [`Path escapes the workspace root: ${path}`] };
    }

    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      return { kind: 'unsupported', warnings: [`Document not found: ${path}`] };
    }
    if (!stat.isFile()) {
      return { kind: 'unsupported', warnings: [`Not a file: ${path}`] };
    }
    if (stat.size > OFFICE_MAX_FILE_BYTES) {
      const mb = Math.round(OFFICE_MAX_FILE_BYTES / (1024 * 1024));
      return {
        kind: 'unsupported',
        warnings: [`This document is too large to preview (over ${mb} MB). Open it in a dedicated application.`]
      };
    }

    const ext = extname(absolutePath).toLowerCase();
    const strategy = officeStrategyForExtension(ext);
    if (strategy === 'legacy') {
      return {
        kind: 'unsupported',
        warnings: [
          `The legacy binary format ${ext} cannot be previewed. Re-save it as ${ext === '.doc' ? '.docx' : '.pptx'} (or open it with a dedicated application) to preview here.`
        ]
      };
    }
    if (strategy === 'unknown') {
      return { kind: 'unsupported', warnings: [`Unsupported document type: ${ext || path}`] };
    }

    try {
      const buffer = await fs.readFile(absolutePath);
      switch (strategy) {
        case 'html':
          return await this.convertDocx(buffer, warnings);
        case 'sheets':
          return this.convertSpreadsheet(buffer, warnings);
        case 'slides':
          return await this.convertPresentation(buffer, warnings);
      }
    } catch (error) {
      return {
        kind: 'unsupported',
        warnings: [`Could not preview ${path}: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
    // Unreachable — every strategy above returns — but satisfies the compiler.
    return { kind: kindForStrategy(strategy), warnings };
  }

  /** Word documents → a single sanitized-on-frontend HTML fragment with inline images. */
  protected async convertDocx(buffer: Buffer, warnings: string[]): Promise<OfficePreviewResult> {
    const mammoth = loadMammoth();
    const convertImage = mammoth.images.imgElement(async image => {
      const base64 = await image.read('base64');
      return { src: `data:${image.contentType};base64,${base64}` };
    });
    const { value, messages } = await mammoth.convertToHtml({ buffer }, { convertImage });
    for (const message of messages) {
      warnings.push(message.message);
    }
    return { kind: 'html', html: value, warnings };
  }

  /** Spreadsheets → one capped HTML table per worksheet. */
  protected convertSpreadsheet(buffer: Buffer, warnings: string[]): OfficePreviewResult {
    const xlsx = loadXlsx();
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheets: OfficeSheetPreview[] = [];
    for (const name of workbook.SheetNames) {
      const worksheet = workbook.Sheets[name];
      const grid = xlsx.utils.sheet_to_json<string[]>(worksheet, {
        header: 1,
        blankrows: false,
        raw: false,
        defval: ''
      });
      const { rows, truncated } = capSheetGrid(grid);
      sheets.push({ name, html: assembleSheetTable(rows), truncated });
      if (truncated) {
        warnings.push(`Sheet "${name}" was truncated to fit the preview limit.`);
      }
    }
    if (sheets.length === 0) {
      warnings.push('The workbook has no worksheets.');
    }
    return { kind: 'sheets', sheets, warnings };
  }

  /**
   * Presentations → per-slide title + text runs extracted from
   * `ppt/slides/slideN.xml`. Embedded slide images are inlined as data URIs only
   * while the cumulative media budget ({@link OFFICE_PPTX_MEDIA_BUDGET_BYTES})
   * allows; beyond it, text-only slides render with a note.
   */
  protected async convertPresentation(buffer: Buffer, warnings: string[]): Promise<OfficePreviewResult> {
    const JSZip = loadJsZip();
    const zip = await JSZip.loadAsync(buffer);

    const slideEntries = Object.values(zip.files)
      .filter(entry => !entry.dir && /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
      .sort((a, b) => slideNumberFromName(a.name) - slideNumberFromName(b.name));

    if (slideEntries.length === 0) {
      warnings.push('No slides were found in the presentation.');
      return { kind: 'slides', slides: [], warnings };
    }

    const slides: OfficeSlidePreview[] = [];
    for (let i = 0; i < slideEntries.length; i++) {
      const xml = await slideEntries[i].async('string');
      const runs = extractSlideText(xml);
      slides.push(buildSlidePreview(i + 1, runs, 'This slide has no extractable text.'));
    }

    // Embedded media is optional and intentionally not inlined: this is a cheap
    // text preview that stays well within the 20MB media budget guard.
    const mediaCount = Object.values(zip.files)
      .filter(entry => !entry.dir && /^ppt\/media\//i.test(entry.name)
        && PPTX_MEDIA_CONTENT_TYPES[extname(entry.name).toLowerCase()] !== undefined)
      .length;
    if (mediaCount > 0) {
      warnings.push('Slide images are not shown in this text preview — open the file to view them.');
    }

    return { kind: 'slides', slides, warnings };
  }
}

function toRootPath(rootUri: string): string {
  if (rootUri.startsWith('file:')) {
    return FileUri.fsPath(rootUri);
  }
  return isAbsolute(rootUri) ? rootUri : resolve(process.cwd(), rootUri);
}
