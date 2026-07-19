import { describe, expect, it } from 'bun:test';
import * as XLSX from 'xlsx';
import {
  assembleSheetTable,
  buildSlidePreview,
  capSheetGrid,
  decodeXmlEntities,
  escapeHtml,
  extractSlideText,
  isDocumentPreviewFile,
  kindForStrategy,
  documentPreviewExtension,
  documentPreviewStrategyForExtension,
  DOCUMENT_PREVIEW_EXTENSIONS,
  DOCUMENT_SHEET_MAX_COLS,
  DOCUMENT_SHEET_MAX_ROWS,
  slideNumberFromName
} from './document-preview';

describe('documentPreviewExtension / routing', () => {
  it('lower-cases and isolates the final extension', () => {
    expect(documentPreviewExtension('sources/Report.DOCX')).toBe('.docx');
    expect(documentPreviewExtension('a.b.xlsx')).toBe('.xlsx');
    expect(documentPreviewExtension('C:\\docs\\deck.PPTX')).toBe('.pptx');
    expect(documentPreviewExtension('noext')).toBe('');
  });

  it('claims exactly the office formats', () => {
    for (const ext of ['.docx', '.xlsx', '.xls', '.ods', '.pptx', '.doc', '.ppt']) {
      expect(isDocumentPreviewFile(`file${ext}`)).toBe(true);
    }
    expect(isDocumentPreviewFile('notes.md')).toBe(false);
    expect(isDocumentPreviewFile('scan.pdf')).toBe(false);
    expect(DOCUMENT_PREVIEW_EXTENSIONS).toContain('.docx');
  });

  it('maps extensions to strategies and kinds', () => {
    expect(documentPreviewStrategyForExtension('.docx')).toBe('html');
    expect(documentPreviewStrategyForExtension('.xls')).toBe('sheets');
    expect(documentPreviewStrategyForExtension('.ods')).toBe('sheets');
    expect(documentPreviewStrategyForExtension('.pptx')).toBe('slides');
    expect(documentPreviewStrategyForExtension('.doc')).toBe('legacy');
    expect(documentPreviewStrategyForExtension('.zip')).toBe('unknown');

    expect(kindForStrategy('html')).toBe('html');
    expect(kindForStrategy('sheets')).toBe('sheets');
    expect(kindForStrategy('slides')).toBe('slides');
    expect(kindForStrategy('legacy')).toBe('unsupported');
    expect(kindForStrategy('unknown')).toBe('unsupported');
  });
});

describe('escapeHtml', () => {
  it('escapes the five markup-significant characters', () => {
    expect(escapeHtml(`<b>a&b</b> "q" 'x'`)).toBe(
      '&lt;b&gt;a&amp;b&lt;/b&gt; &quot;q&quot; &#39;x&#39;'
    );
  });
});

describe('capSheetGrid', () => {
  it('leaves a small grid untouched', () => {
    const { rows, truncated } = capSheetGrid([['a', 'b'], ['c', 'd']]);
    expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
    expect(truncated).toBe(false);
  });

  it('caps rows and flags truncation', () => {
    const big = Array.from({ length: DOCUMENT_SHEET_MAX_ROWS + 5 }, (_, i) => [String(i)]);
    const { rows, truncated } = capSheetGrid(big);
    expect(rows.length).toBe(DOCUMENT_SHEET_MAX_ROWS);
    expect(truncated).toBe(true);
  });

  it('caps columns and flags truncation', () => {
    const wide = [Array.from({ length: DOCUMENT_SHEET_MAX_COLS + 3 }, (_, i) => String(i))];
    const { rows, truncated } = capSheetGrid(wide);
    expect(rows[0].length).toBe(DOCUMENT_SHEET_MAX_COLS);
    expect(truncated).toBe(true);
  });

  it('respects custom caps and normalizes nullish cells', () => {
    const grid = [['keep', null as unknown as string, 'drop']];
    const { rows, truncated } = capSheetGrid(grid, 10, 2);
    expect(rows).toEqual([['keep', '']]);
    expect(truncated).toBe(true);
  });
});

describe('assembleSheetTable', () => {
  it('renders a header row and escapes cells', () => {
    const html = assembleSheetTable([['H<1>', 'H2'], ['a&b', 'c']]);
    expect(html).toContain('<th>H&lt;1&gt;</th>');
    expect(html).toContain('<td>a&amp;b</td>');
    expect(html.startsWith('<table')).toBe(true);
  });

  it('handles an empty grid', () => {
    expect(assembleSheetTable([])).toBe('<table class="afe-office-sheet-table"></table>');
  });
});

describe('extractSlideText', () => {
  it('extracts trimmed non-empty runs in order across namespaces and newlines', () => {
    const xml = `
      <p:sld xmlns:a="urn"><p:cSld><p:spTree>
        <a:p><a:r><a:t>  Title Slide  </a:t></a:r></a:p>
        <a:p><a:r><a:t></a:t></a:r><a:r><a:t>Bullet
one</a:t></a:r></a:p>
        <a:p><a:r><a:t xml:space="preserve">Amp &amp; &#65;</a:t></a:r></a:p>
      </p:spTree></p:cSld></p:sld>`;
    expect(extractSlideText(xml)).toEqual(['Title Slide', 'Bullet\none', 'Amp & A']);
  });

  it('returns an empty array when there are no text runs', () => {
    expect(extractSlideText('<p:sld><p:cSld/></p:sld>')).toEqual([]);
  });
});

describe('decodeXmlEntities', () => {
  it('decodes predefined and numeric references', () => {
    expect(decodeXmlEntities('a &lt;b&gt; &amp; &#66; &#x43;')).toBe('a <b> & B C');
  });
});

describe('buildSlidePreview', () => {
  it('uses the first run as title and lists the rest', () => {
    const preview = buildSlidePreview(3, ['Heading', 'point a', 'point b'], 'no text');
    expect(preview.index).toBe(3);
    expect(preview.title).toBe('Heading');
    expect(preview.html).toContain('<li>point a</li>');
    expect(preview.html).toContain('<li>point b</li>');
  });

  it('renders an explicit empty card when the slide has no runs', () => {
    const preview = buildSlidePreview(1, [], 'no text on this slide');
    expect(preview.title).toBeUndefined();
    expect(preview.html).toContain('no text on this slide');
  });
});

describe('slideNumberFromName', () => {
  it('sorts natural slide numbers', () => {
    const names = ['ppt/slides/slide10.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'];
    const sorted = [...names].sort((a, b) => slideNumberFromName(a) - slideNumberFromName(b));
    expect(sorted).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
      'ppt/slides/slide10.xml'
    ]);
  });
});

describe('back-compat aliases', () => {
  it('re-exports the historical Office* names as aliases of the new symbols', async () => {
    const mod = await import('./document-preview');
    expect(mod.officeExtension).toBe(mod.documentPreviewExtension);
    expect(mod.isOfficePreviewFile).toBe(mod.isDocumentPreviewFile);
    expect(mod.officeStrategyForExtension).toBe(mod.documentPreviewStrategyForExtension);
    expect(mod.OFFICE_PREVIEW_EXTENSIONS).toBe(mod.DOCUMENT_PREVIEW_EXTENSIONS);
    expect(mod.OFFICE_SHEET_MAX_ROWS).toBe(mod.DOCUMENT_SHEET_MAX_ROWS);
    expect(mod.OFFICE_SHEET_MAX_COLS).toBe(mod.DOCUMENT_SHEET_MAX_COLS);
    expect(mod.OFFICE_MAX_FILE_BYTES).toBe(mod.DOCUMENT_PREVIEW_MAX_FILE_BYTES);
    const protocol = await import('./document-preview-protocol');
    expect(protocol.OfficePreviewService).toBe(protocol.DocumentPreviewService);
    expect(protocol.OfficePreviewServicePath).toBe(protocol.DocumentPreviewServicePath);
  });
});

describe('xlsx grid integration (fixture built in-test)', () => {
  it('parses a tiny workbook into a capped, assembled table', () => {
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['Name', 'Qty'],
      ['Widget', 3],
      ['Gadget', 7]
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory');

    // Round-trip through the binary form the node service will read.
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const reparsed = XLSX.read(buffer, { type: 'buffer' });
    const sheet = reparsed.Sheets[reparsed.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, raw: false });

    const { rows: capped, truncated } = capSheetGrid(rows);
    expect(truncated).toBe(false);
    const html = assembleSheetTable(capped);
    expect(reparsed.SheetNames[0]).toBe('Inventory');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td>Widget</td>');
    expect(html).toContain('<td>7</td>');
  });
});
