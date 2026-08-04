/**
 * SPLIT OUT OF `node-domain-knowledge-service.test.ts` (TASK-022 WP-7).
 *
 * The original file held FOUR unrelated `describe` blocks over three unrelated
 * services, and WP-7 touches exactly one of them. The plan's rule is that the
 * unit of decision is the `describe` BLOCK and not the FILE, so the file is
 * SPLIT FIRST and the fate of each block is decided afterwards, one at a time.
 * Nothing below is rewritten by the split: the assertions, the fixtures and
 * their order are byte-identical to the block this file was carved from.
 *
 * `makeRoot`/`SCRATCH_BASE` are REPEATED in each of the four files rather than
 * lifted into a shared module. `tsconfig.json` excludes test files and NOTHING
 * else, so a shared helper under `src/` would compile into `lib/` and ship as
 * production surface — for eight lines of `mkdtemp`. Repetition is the smaller
 * cost, and it keeps each file runnable on its own.
 */

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChromePath, renderHtmlToPdf } from '@ai-focused-editor/book-export';
import { NodeSourceLibraryService } from './node-domain-knowledge-service';


// Resolve a real browser once so the real-PDF extraction test can skip gracefully
// on machines without Chrome/Chromium and run for real when one is present.
const CHROME = findChromePath();

/**
 * Build a minimal, valid, uncompressed single-page PDF containing `text`, with
 * correct xref byte offsets so pdf.js (via unpdf) parses it deterministically and
 * offline — no Chrome required.
 */
function buildMinimalPdf(text: string): Buffer {
  const header = '%PDF-1.4\n';
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];

  let body = header;
  const offsets: number[] = [];
  objects.forEach((content, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}
const SCRATCH_BASE = process.env.CLAUDE_SCRATCHPAD_DIR
  || '/private/tmp/claude-501/-Users-vedmalex-work-ai-editor-3/8a15f000-cd38-4649-8fe4-b479e61f41c1/scratchpad/domain-services-test';

async function makeRoot(): Promise<string> {
  await fs.mkdir(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), { recursive: true });
  return fs.mkdtemp(join(SCRATCH_BASE.startsWith('/') ? SCRATCH_BASE : tmpdir(), 'afe-domain-'));
}

describe('NodeSourceLibraryService.extractSourceText', () => {
  let root: string;
  let service: NodeSourceLibraryService;

  beforeEach(async () => {
    root = await makeRoot();
    service = new NodeSourceLibraryService();
    await fs.mkdir(join(root, 'sources/documents'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('extracts text from a simple text-based PDF', async () => {
    await fs.writeFile(join(root, 'sources/documents/study.pdf'), buildMinimalPdf('Dharma Notes Token 4821'));
    const result = await service.extractSourceText(root, 'sources/documents/study.pdf');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Dharma Notes Token 4821');
    expect(result.detail).toBeUndefined();
  });

  test.skipIf(!CHROME)('extracts text from a Chrome-generated PDF', async () => {
    const pdfPath = join(root, 'sources/documents/generated.pdf');
    await renderHtmlToPdf(
      '<!doctype html><html><body><h1>Generated Source</h1><p>Unmistakable Token 90210 lives here.</p></body></html>',
      { outputPath: pdfPath, format: 'a4' }
    );
    const result = await service.extractSourceText(root, 'sources/documents/generated.pdf');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Unmistakable Token 90210');
  }, 60000);

  test('reads a non-PDF source file as UTF-8 text', async () => {
    await fs.writeFile(join(root, 'sources/documents/notes.md'), '# Notes\n\nPlain markdown body.\n');
    const result = await service.extractSourceText(root, 'sources/documents/notes.md');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Plain markdown body.');
  });

  test('reports a clear failure for a missing file without throwing', async () => {
    const result = await service.extractSourceText(root, 'sources/documents/does-not-exist.pdf');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not found');
  });

  test('rejects a path that escapes the workspace root', async () => {
    const result = await service.extractSourceText(root, '../secrets.pdf');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('escapes the workspace root');
  });

  test('fails gracefully on a corrupt PDF instead of crashing', async () => {
    await fs.writeFile(join(root, 'sources/documents/broken.pdf'), '%PDF-1.4\nthis is not a real pdf body\n');
    const result = await service.extractSourceText(root, 'sources/documents/broken.pdf');
    expect(result.ok).toBe(false);
    expect(typeof result.detail).toBe('string');
  });

  test('reports a missing workspace root', async () => {
    const result = await service.extractSourceText('', 'sources/documents/study.pdf');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('workspace');
  });
});
