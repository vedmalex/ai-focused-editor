import { describe, expect, it } from 'bun:test';
import * as XLSX from 'xlsx';
import {
  assembleSheetTable,
  buildSlidePreview,
  capHtmlFragment,
  capSheetGrid,
  decodeXmlEntities,
  epubDirName,
  epubRootFileFromContainer,
  epubTocFromNav,
  epubTocFromNcx,
  escapeHtml,
  extractOdpSlideTexts,
  extractSlideText,
  extractXhtmlBody,
  isDocumentPreviewFile,
  kindForStrategy,
  documentPreviewExtension,
  documentPreviewStrategyForExtension,
  parseEpubOpf,
  resolveEpubHref,
  stripXmlMarkup,
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
    for (const ext of ['.docx', '.odt', '.rtf', '.xlsx', '.xls', '.ods', '.pptx', '.odp', '.epub', '.doc', '.ppt']) {
      expect(isDocumentPreviewFile(`file${ext}`)).toBe(true);
      expect(DOCUMENT_PREVIEW_EXTENSIONS).toContain(ext);
    }
    expect(isDocumentPreviewFile('notes.md')).toBe(false);
    expect(isDocumentPreviewFile('scan.pdf')).toBe(false);
    expect(DOCUMENT_PREVIEW_EXTENSIONS).toContain('.docx');
  });

  it('maps extensions to strategies and kinds', () => {
    expect(documentPreviewStrategyForExtension('.docx')).toBe('html');
    expect(documentPreviewStrategyForExtension('.odt')).toBe('html');
    expect(documentPreviewStrategyForExtension('.rtf')).toBe('html');
    expect(documentPreviewStrategyForExtension('.xls')).toBe('sheets');
    expect(documentPreviewStrategyForExtension('.ods')).toBe('sheets');
    expect(documentPreviewStrategyForExtension('.pptx')).toBe('slides');
    expect(documentPreviewStrategyForExtension('.odp')).toBe('slides');
    expect(documentPreviewStrategyForExtension('.epub')).toBe('epub');
    expect(documentPreviewStrategyForExtension('.doc')).toBe('legacy');
    expect(documentPreviewStrategyForExtension('.zip')).toBe('unknown');

    expect(kindForStrategy('html')).toBe('html');
    expect(kindForStrategy('sheets')).toBe('sheets');
    expect(kindForStrategy('slides')).toBe('slides');
    expect(kindForStrategy('epub')).toBe('epub');
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

describe('stripXmlMarkup', () => {
  it('drops tags, decodes entities, and collapses whitespace', () => {
    expect(stripXmlMarkup('<span>Hello</span>\n  <b>w&amp;orld</b>')).toBe('Hello w&orld');
    expect(stripXmlMarkup('  plain  ')).toBe('plain');
  });
});

describe('extractOdpSlideTexts (.odp content.xml)', () => {
  const contentXml = `
    <office:document-content xmlns:draw="d" xmlns:text="t">
      <office:body><office:presentation>
        <draw:page draw:name="page1">
          <draw:frame><draw:text-box>
            <text:p>Slide One Title</text:p>
            <text:p><text:span>First</text:span> <text:span>bullet</text:span></text:p>
            <text:p></text:p>
          </draw:text-box></draw:frame>
        </draw:page>
        <draw:page draw:name="page2">
          <draw:frame><draw:text-box><text:p>Second &amp; last</text:p></draw:text-box></draw:frame>
        </draw:page>
        <draw:page draw:name="page3"><draw:frame/></draw:page>
      </office:presentation></office:body>
    </office:document-content>`;

  it('extracts per-page text runs in order', () => {
    const pages = extractOdpSlideTexts(contentXml);
    expect(pages.length).toBe(3);
    expect(pages[0]).toEqual(['Slide One Title', 'First bullet']);
    expect(pages[1]).toEqual(['Second & last']);
    expect(pages[2]).toEqual([]);
  });

  it('returns no pages for non-presentation content', () => {
    expect(extractOdpSlideTexts('<office:document-content/>')).toEqual([]);
  });
});

describe('epub container/OPF parsing', () => {
  it('finds the OPF path in container.xml', () => {
    const container = `<?xml version="1.0"?>
      <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
        <rootfiles>
          <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
        </rootfiles>
      </container>`;
    expect(epubRootFileFromContainer(container)).toBe('OEBPS/content.opf');
    expect(epubRootFileFromContainer('<container/>')).toBeUndefined();
  });

  it('parses title, manifest, and spine (skipping linear="no")', () => {
    const opf = `<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <metadata><dc:title>My &amp; Book</dc:title></metadata>
        <manifest>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="sub/ch2.xhtml" media-type="application/xhtml+xml"/>
          <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        </manifest>
        <spine toc="ncx">
          <itemref idref="cover" linear="no"/>
          <itemref idref="c1"/>
          <itemref idref="c2"/>
        </spine>
      </package>`;
    const parsed = parseEpubOpf(opf);
    expect(parsed.title).toBe('My & Book');
    expect(parsed.manifest.map(item => item.id)).toEqual(['nav', 'c1', 'c2', 'ncx']);
    expect(parsed.manifest[0].properties).toBe('nav');
    expect(parsed.manifest[3].mediaType).toBe('application/x-dtbncx+xml');
    expect(parsed.spine).toEqual(['c1', 'c2']);
  });
});

describe('epub TOC parsing', () => {
  it('reads the epub:type="toc" nav with markup-bearing labels', () => {
    const nav = `<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
      <nav epub:type="landmarks"><ol><li><a href="cover.xhtml">Cover</a></li></ol></nav>
      <nav epub:type="toc"><ol>
        <li><a href="ch1.xhtml"><span>Chapter</span> One</a></li>
        <li><a href="sub/ch2.xhtml#s1">Chapter Two</a></li>
      </ol></nav>
    </body></html>`;
    expect(epubTocFromNav(nav)).toEqual([
      { label: 'Chapter One', href: 'ch1.xhtml' },
      { label: 'Chapter Two', href: 'sub/ch2.xhtml#s1' }
    ]);
  });

  it('falls back to the first nav when no epub:type is present', () => {
    const nav = '<body><nav><ol><li><a href="a.xhtml">A</a></li></ol></nav></body>';
    expect(epubTocFromNav(nav)).toEqual([{ label: 'A', href: 'a.xhtml' }]);
  });

  it('flattens NCX navPoints in document order', () => {
    const ncx = `<ncx><navMap>
      <navPoint id="n1" playOrder="1">
        <navLabel><text>One</text></navLabel>
        <content src="ch1.xhtml"/>
        <navPoint id="n2" playOrder="2">
          <navLabel><text>One point one</text></navLabel>
          <content src="ch1.xhtml#s1"/>
        </navPoint>
      </navPoint>
      <navPoint id="n3" playOrder="3">
        <navLabel><text>Two</text></navLabel>
        <content src="ch2.xhtml"/>
      </navPoint>
    </navMap></ncx>`;
    expect(epubTocFromNcx(ncx)).toEqual([
      { label: 'One', href: 'ch1.xhtml' },
      { label: 'One point one', href: 'ch1.xhtml#s1' },
      { label: 'Two', href: 'ch2.xhtml' }
    ]);
  });
});

describe('epub path + body helpers', () => {
  it('resolves hrefs against a base dir with ../ and fragments', () => {
    expect(resolveEpubHref('OEBPS', 'ch1.xhtml')).toBe('OEBPS/ch1.xhtml');
    expect(resolveEpubHref('OEBPS/text', '../images/pic.png')).toBe('OEBPS/images/pic.png');
    expect(resolveEpubHref('OEBPS', 'ch1.xhtml#frag?x=1')).toBe('OEBPS/ch1.xhtml');
    expect(resolveEpubHref('', 'ch%201.xhtml')).toBe('ch 1.xhtml');
    expect(resolveEpubHref('a/b', '../../../x.xhtml')).toBe('x.xhtml');
  });

  it('computes the zip-internal dirname', () => {
    expect(epubDirName('OEBPS/content.opf')).toBe('OEBPS');
    expect(epubDirName('content.opf')).toBe('');
  });

  it('extracts the body inner HTML with a whole-document fallback', () => {
    expect(extractXhtmlBody('<html><head><script>x()</script></head><body class="c"><p>Hi</p></body></html>')).toBe('<p>Hi</p>');
    expect(extractXhtmlBody('<p>No body wrapper</p>')).toBe('<p>No body wrapper</p>');
  });

  it('caps oversized HTML fragments', () => {
    expect(capHtmlFragment('<p>ok</p>', 100)).toEqual({ html: '<p>ok</p>', truncated: false });
    const capped = capHtmlFragment('x'.repeat(50), 10);
    expect(capped.truncated).toBe(true);
    expect(capped.html.length).toBe(10);
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
